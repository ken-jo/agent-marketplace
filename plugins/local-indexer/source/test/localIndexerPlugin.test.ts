/**
 * LocalIndexerPlugin over worker stdio control v1.
 *
 * No Python process is spawned: `spawnWorker` hands out fake
 * `StdioControlPluginWorker` handles (test/support/fakeStdioWorker.ts) that
 * behave as the host's handle is documented to. The tests cover the spawn
 * spec, the lifecycle, the worker→plugin egress requests and the restart after
 * an incarnation ends.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { flattenAgentPluginsManifest, type PluginWorkerSpec } from "@ave/plugin-contract";
import {
  LEGACY_INDEX_DIR_NAME,
  LOCAL_INDEXER_WORKER_ID,
  LocalIndexerPlugin,
} from "../src/localIndexerPlugin";
import { CAPTION_REQUEST_BYTES_MAX } from "../src/egressBroker";
import type { LocalIndexerWorkerOptions } from "../src/types";
import { FakeStdioWorker, readyWorker, spawnSequence } from "./support/fakeStdioWorker";

const HOST_KEY = "fake-host-provider-token";

function brokerOptions(upstreamCalls: string[] = []): Pick<
  LocalIndexerWorkerOptions,
  "egressChannels" | "isUpstreamAllowed" | "egressUpstreamFetch"
> {
  const channel = async () => ({
    upstreamBaseUrl: "https://api.openai.com/v1",
    apiKey: HOST_KEY,
    authScheme: "bearer" as const,
  });
  return {
    egressChannels: { embedding: channel, caption: channel },
    isUpstreamAllowed: (url: string) => new URL(url).host === "api.openai.com",
    egressUpstreamFetch: async (url: string) => {
      upstreamCalls.push(url);
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true}') };
    },
  };
}

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makePlugin(
  spawnWorker: (spec: PluginWorkerSpec) => Promise<FakeStdioWorker | unknown>,
  options: Partial<LocalIndexerWorkerOptions> = {},
): LocalIndexerPlugin {
  return new LocalIndexerPlugin({
    pythonExecutable: "/usr/bin/python3",
    startupTimeoutMs: 500,
    shutdownGraceMs: 50,
    spawnWorker: spawnWorker as LocalIndexerWorkerOptions["spawnWorker"],
    ...brokerOptions(),
    ...options,
  });
}

describe("LocalIndexerPlugin — lifecycle", () => {
  it("is not running before start, and stop() is a no-op then", async () => {
    const plugin = makePlugin(async () => readyWorker(), { pluginDataDir: "/unused" });
    expect(plugin.isRunning).toBe(false);
    expect(plugin.getIndexLocation()).toBeNull();
    await expect(plugin.stop()).resolves.toBeUndefined();
  });

  it("refuses to start without a python executable, spawnWorker or egress channels", async () => {
    await withTempDir("ave-li-req-", async (dir) => {
      const noPython = new LocalIndexerPlugin({ pluginDataDir: dir, spawnWorker: async () => readyWorker(), ...brokerOptions() });
      await expect(noPython.start()).rejects.toThrow(/pythonExecutable/);
      const noSpawn = new LocalIndexerPlugin({ pythonExecutable: "/usr/bin/python3", pluginDataDir: dir, ...brokerOptions() });
      await expect(noSpawn.start()).rejects.toThrow(/spawnWorker capability/);
      const noChannels = makePlugin(async () => readyWorker(), { pluginDataDir: dir, egressChannels: undefined });
      await expect(noChannels.start()).rejects.toThrow(/egressChannels/);
      const noUpstream = makePlugin(async () => readyWorker(), { pluginDataDir: dir, egressUpstreamFetch: undefined });
      await expect(noUpstream.start()).rejects.toThrow(/egressUpstreamFetch/);
    });
  });

  it("starts once, attaches the worker client, and stops in order: worker_shutdown, then handle.stop()", async () => {
    await withTempDir("ave-li-life-", async (dir) => {
      const worker = readyWorker({
        documents_list: () => ({ documents: [{ doc_id: "d1", path: "/a.md", doc_name: "a.md", doc_type: "md" }], next_after: null }),
      });
      const { spawnWorker, specs } = spawnSequence(worker);
      const plugin = makePlugin(spawnWorker, { pluginDataDir: dir });
      await Promise.all([plugin.start(), plugin.start()]);
      expect(specs).toHaveLength(1);
      expect(plugin.isRunning).toBe(true);
      expect(plugin.getWorkerClient().attached).toBe(true);
      const docs = await plugin.listDocuments();
      expect(docs[0]).toMatchObject({ id: "d1", doc_id: "d1", path: "/a.md", doc_type: "md" });

      await plugin.stop();
      expect(worker.callsOf("worker_shutdown")).toHaveLength(1);
      expect(worker.callsOf("worker_shutdown")[0]!.options?.signal).toBeInstanceOf(AbortSignal);
      expect(worker.stopCalls).toBe(1);
      expect(plugin.isRunning).toBe(false);
      expect(plugin.getWorkerClient().attached).toBe(false);
    });
  });

  it("delegates document calls to the worker methods", async () => {
    await withTempDir("ave-li-deleg-", async (dir) => {
      const worker = readyWorker({
        indexer_reindex: () => ({ doc_id: "d9", doc_name: "x.md", doc_type: "md", chunk_count: 1, status: "indexed" }),
        documents_delete: () => ({ removed: true, doc_id: "d9" }),
        document_get: () => ({ doc_id: "d9", doc_name: "x.md" }),
        document_structure: () => ({ nodes: [] }),
        page_content: () => [{ page: 1, text: "p1" }],
      });
      const plugin = makePlugin(spawnSequence(worker).spawnWorker, { pluginDataDir: dir });
      await plugin.start();
      await expect(plugin.indexDocument("/x.md", "md")).resolves.toBe("d9");
      await plugin.removeDocument("d9");
      await expect(plugin.getDocument("d9")).resolves.toEqual({ doc_id: "d9", doc_name: "x.md" });
      await expect(plugin.getDocumentStructure("d9")).resolves.toEqual({ nodes: [] });
      await expect(plugin.getPageContent("d9", "1")).resolves.toEqual([{ page: 1, text: "p1" }]);
      expect(worker.requests.map((r) => r.method)).toEqual([
        "runtime_info", "indexer_reindex", "documents_delete", "document_get", "document_structure", "page_content",
      ]);
      await plugin.stop();
    });
  });

  it("a start that never becomes ready stops the handle and reports why", async () => {
    await withTempDir("ave-li-fail-", async (dir) => {
      const worker = new FakeStdioWorker({
        runtime_info: () => new Promise(() => {}),
        worker_shutdown: () => ({ bye: true }),
      });
      const plugin = makePlugin(spawnSequence(worker).spawnWorker, { pluginDataDir: dir, startupTimeoutMs: 20 });
      await expect(plugin.start()).rejects.toThrow(/failed to become ready within 20ms/);
      expect(worker.stopCalls).toBe(1);
      expect(plugin.isRunning).toBe(false);
    });
  });

  it("a worker that exits during startup fails start() with the exit, not a timeout", async () => {
    await withTempDir("ave-li-exit-", async (dir) => {
      const worker = new FakeStdioWorker({ runtime_info: () => new Promise(() => {}) });
      const plugin = makePlugin(spawnSequence(worker).spawnWorker, { pluginDataDir: dir, startupTimeoutMs: 5_000 });
      const starting = plugin.start();
      await new Promise((r) => setTimeout(r, 5));
      worker.end("exited", 1);
      await expect(starting).rejects.toThrow(/exited before becoming ready/);
      expect(plugin.getLastWorkerExit()).toEqual({ code: 1, signal: null, reason: "exited" });
    });
  });

  it("refuses a handle whose control is not stdio-control-v1, and stops it", async () => {
    await withTempDir("ave-li-ctl-", async (dir) => {
      const stop = vi.fn();
      const legacy = { control: undefined, socketPath: null, pid: 1, stop, onStdout() {}, onStderr() {}, onExit() {} };
      const plugin = makePlugin(async () => legacy, { pluginDataDir: dir });
      await expect(plugin.start()).rejects.toThrow(/stdio-control-v1 spec/);
      expect(stop).toHaveBeenCalled();
      expect(plugin.isRunning).toBe(false);
    });
  });

  it("restarts with a new incarnation after worker-incarnation-ended", async () => {
    await withTempDir("ave-li-restart-", async (dir) => {
      const first = readyWorker({ indexer_reindex: () => new Promise(() => {}) });
      const second = readyWorker({ metrics: () => ({ processed: 2 }) });
      const { spawnWorker, specs } = spawnSequence(first, second);
      const onDiagnostic = vi.fn();
      const plugin = makePlugin(spawnWorker, { pluginDataDir: dir, onDiagnostic });
      await plugin.start();

      const pending = plugin.indexDocument("/slow.md");
      await new Promise((r) => setTimeout(r, 1));
      first.end("control-violation", 137);
      // The call in flight is not replayed: it fails with the control error.
      await expect(pending).rejects.toThrow(/worker-incarnation-ended/);
      expect(plugin.isRunning).toBe(false);
      expect(onDiagnostic).toHaveBeenCalledWith("warn", "local_indexer.worker.exited", {
        reason: "control-violation",
        code: 137,
        signal: null,
      });
      await expect(plugin.getWorkerClient().getMetrics()).rejects.toThrow(/not running/);

      await plugin.start();
      expect(specs).toHaveLength(2);
      expect(plugin.isRunning).toBe(true);
      await expect(plugin.getWorkerClient().getMetrics()).resolves.toEqual({ processed: 2 });
      expect(first.callsOf("metrics")).toHaveLength(0);
      // The second incarnation registered its own request handler.
      expect(second.requestHandler).not.toBeNull();
      await plugin.stop();
    });
  });

  it("splits worker stderr into lines and flushes a trailing partial line on exit", async () => {
    await withTempDir("ave-li-stderr-", async (dir) => {
      const worker = readyWorker();
      const onWorkerStderr = vi.fn();
      const plugin = makePlugin(spawnSequence(worker).spawnWorker, { pluginDataDir: dir, onWorkerStderr });
      await plugin.start();
      onWorkerStderr.mockClear();
      worker.emitStderr('{"event":"one"}\n{"event":');
      worker.emitStderr('"two"}\r\n\n  \npartial');
      expect(onWorkerStderr.mock.calls.map(([l]) => l)).toEqual(['{"event":"one"}', '{"event":"two"}']);
      worker.end("exited", 0);
      expect(onWorkerStderr.mock.calls.map(([l]) => l)).toContain("partial");
    });
  });
});

describe("LocalIndexerPlugin — spawn spec", () => {
  it("asks for stdio control v1 and a state directory, with no socket, port or token", async () => {
    await withTempDir("ave-li-spec-", async (dir) => {
      const { spawnWorker, specs } = spawnSequence(readyWorker());
      const plugin = makePlugin(spawnWorker, { pluginDataDir: dir });
      await plugin.start();
      const spec = specs[0]!;
      expect(spec.workerId).toBe(LOCAL_INDEXER_WORKER_ID);
      expect(spec.workerId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(spec.control).toBe("stdio-control-v1");
      expect(spec.stateDirectory).toBe(true);
      const workspace = resolve(dir, ".local-indexer-workspace");
      expect(spec.allowWritePaths).toEqual([workspace]);
      expect(spec.args).toEqual(expect.arrayContaining(["--workspace", workspace]));
      // The index is the worker's state directory; nothing names a location for it.
      for (const flag of ["--index-root", "--sqlite", "--lance", "--port", "--uds", "--host", "--egress-broker-url"]) {
        expect(spec.args, flag).not.toContain(flag);
      }
      expect(JSON.stringify(spec)).not.toMatch(/token|socket|127\.0\.0\.1/i);
      await plugin.stop();
    });
  });

  it("a user-chosen indexStorageRoot is passed as --index-root and keeps its write grant", async () => {
    await withTempDir("ave-li-root-", async (root) => {
      const { spawnWorker, specs } = spawnSequence(readyWorker({}, { index_root: resolve(root), state_dir: "/state" }));
      const plugin = makePlugin(spawnWorker, { indexStorageRoot: root, pluginDataDir: join(root, "pdd") });
      await plugin.start();
      const spec = specs[0]!;
      const args = spec.args ?? [];
      expect(args[args.indexOf("--index-root") + 1]).toBe(resolve(root));
      expect(args[args.indexOf("--workspace") + 1]).toBe(resolve(root, "workspace"));
      expect(spec.allowWritePaths).toEqual([resolve(root), resolve(root, "workspace")]);
      expect(spec.stateDirectory).toBe(true);
      expect(plugin.getIndexLocation()).toEqual({
        indexRoot: resolve(root),
        documentCount: 0,
        inStateDirectory: false,
        legacyIndexDir: null,
      });
      await plugin.stop();
    });
  });

  it("grants the worker module directory without widening system interpreter access", async () => {
    await withTempDir("ave-li-read-", async (dir) => {
      const { spawnWorker, specs } = spawnSequence(readyWorker());
      const plugin = makePlugin(spawnWorker, { pluginDataDir: dir });
      await plugin.start();
      const reads = specs[0]!.allowReadPaths ?? [];
      expect(reads).toHaveLength(3);
      expect(reads[0]).toBe("/usr/bin/python3");
      expect(reads[1]).toMatch(/[\\/]local_indexer_worker\.py$/);
      expect(reads[2]).toBe(dirname(reads[1]));
      expect(reads).not.toContain("/usr");
      await plugin.stop();
    });
  });

  it("grants only the selected managed environment's venv and interpreter tree", async () => {
    await withTempDir("ave-li-python-read-", async (dir) => {
      const runtime = resolve(dir, "runtime/python-envs/lock-id");
      const { spawnWorker, specs } = spawnSequence(readyWorker());
      const plugin = makePlugin(spawnWorker, { pluginDataDir: dir, pythonExecutable: resolve(runtime, "venv/bin/python") });
      await plugin.start();
      const reads = specs[0]!.allowReadPaths ?? [];
      expect(reads).toContain(resolve(runtime, "venv"));
      expect(reads).toContain(resolve(runtime, "python"));
      expect(reads).not.toContain(runtime);
      expect(reads).not.toContain(resolve(runtime, ".."));
      await plugin.stop();
    });
  });

  it("grants and injects the corp CA the host resolved, and only that one", async () => {
    await withTempDir("ave-li-ca-", async (dir) => {
      const corpCaPath = join(dir, "corp-ca.pem");
      await writeFile(corpCaPath, "-----BEGIN CERTIFICATE-----\n");
      const { spawnWorker, specs } = spawnSequence(readyWorker());
      const plugin = makePlugin(spawnWorker, { pluginDataDir: dir, corpCaPath });
      await plugin.start();
      const spec = specs[0]!;
      expect(spec.allowReadPaths).toContain(corpCaPath);
      expect(spec.allowReadPaths!.filter((p) => p.endsWith(".pem"))).toEqual([corpCaPath]);
      expect(spec.env?.SSL_CERT_FILE).toBe(corpCaPath);
      expect(spec.env?.REQUESTS_CA_BUNDLE).toBe(corpCaPath);
      expect(spec.env?.CURL_CA_BUNDLE).toBe(corpCaPath);
      await plugin.stop();
    });
  });

  it("puts no API key in the spawn env or args, even with one configured", async () => {
    await withTempDir("ave-li-nokey-", async (dir) => {
      const { spawnWorker, specs } = spawnSequence(readyWorker());
      const secret = "fake-provider-token-must-not-leak";
      const plugin = makePlugin(spawnWorker, {
        pluginDataDir: dir,
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        apiKey: secret,
      });
      await plugin.start();
      const spec = specs[0]!;
      expect(Object.keys(spec.env ?? {}).filter((n) => /API_KEY/u.test(n))).toEqual([]);
      expect(JSON.stringify(spec)).not.toContain(secret);
      expect(spec.env?.PYTHONDONTWRITEBYTECODE).toBe("1");
      await plugin.stop();
    });
  });

  it("azure provider with missing endpoint/apiKey invokes onConfigWarning", async () => {
    await withTempDir("ave-li-warn-", async (dir) => {
      const onConfigWarning = vi.fn();
      const onDiagnostic = vi.fn();
      const plugin = makePlugin(spawnSequence(readyWorker()).spawnWorker, {
        pluginDataDir: dir,
        embeddingProvider: "azure",
        embeddingModel: "text-embedding-3-small",
        hostVendor: "azure-foundry",
        onConfigWarning,
        onDiagnostic,
      });
      await plugin.start();
      expect(onDiagnostic).toHaveBeenCalledWith("warn", "local_indexer.config.azure_config_required", expect.objectContaining({
        missing: ["embeddingEndpoint", "apiKey"],
      }));
      expect(onConfigWarning).toHaveBeenCalledTimes(1);
      expect(onConfigWarning).toHaveBeenCalledWith({
        reason: "azure-inherit-missing-config",
        missing: ["embeddingEndpoint", "apiKey"],
        inheritedFrom: "explicit embeddingProvider=azure",
      });
      await plugin.stop();
    });
  });
});

describe("LocalIndexerPlugin — worker egress requests", () => {
  it("answers an allowed egress_embedding from the broker, with the key injected upstream only", async () => {
    await withTempDir("ave-li-egress-", async (dir) => {
      const worker = readyWorker();
      const upstreamCalls: string[] = [];
      const plugin = makePlugin(spawnSequence(worker).spawnWorker, { pluginDataDir: dir, ...brokerOptions(upstreamCalls) });
      await plugin.start();
      const answer = await worker.askPlugin("egress_embedding", {
        method: "POST", path: "/embeddings", headers: { "content-type": "application/json" }, body: "{}",
      });
      expect(answer).toEqual({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' });
      expect(upstreamCalls).toEqual(["https://api.openai.com/v1/embeddings"]);
      expect(JSON.stringify(answer)).not.toContain(HOST_KEY);
      await plugin.stop();
    });
  });

  it("refuses an upstream off the allow-list with 403 and relays nothing", async () => {
    await withTempDir("ave-li-egress-deny-", async (dir) => {
      const worker = readyWorker();
      const upstreamCalls: string[] = [];
      const plugin = makePlugin(spawnSequence(worker).spawnWorker, {
        pluginDataDir: dir,
        ...brokerOptions(upstreamCalls),
        isUpstreamAllowed: () => false,
      });
      await plugin.start();
      const answer = (await worker.askPlugin("egress_embedding", { method: "POST", path: "/embeddings", body: "{}" })) as { status: number };
      expect(answer.status).toBe(403);
      expect(upstreamCalls).toEqual([]);
      await plugin.stop();
    });
  });

  it("refuses a caption over the 11 MiB cap with a visible 413", async () => {
    await withTempDir("ave-li-egress-cap-", async (dir) => {
      const worker = readyWorker();
      const upstreamCalls: string[] = [];
      const plugin = makePlugin(spawnSequence(worker).spawnWorker, { pluginDataDir: dir, ...brokerOptions(upstreamCalls) });
      await plugin.start();
      const answer = (await worker.askPlugin("egress_caption", {
        method: "POST", path: "/responses", body: "x".repeat(CAPTION_REQUEST_BYTES_MAX + 1),
      })) as { status: number; body: string };
      expect(answer.status).toBe(413);
      expect(answer.body).toMatch(/11 MiB/);
      expect(upstreamCalls).toEqual([]);
      await plugin.stop();
    });
  });

  it("refuses a worker request it does not answer", async () => {
    await withTempDir("ave-li-egress-unknown-", async (dir) => {
      const worker = readyWorker();
      const plugin = makePlugin(spawnSequence(worker).spawnWorker, { pluginDataDir: dir });
      await plugin.start();
      await expect(worker.askPlugin("read_host_file", { path: "/etc/passwd" })).rejects.toThrow(/answers no worker request named read_host_file/);
      await plugin.stop();
    });
  });
});

describe("LocalIndexerPlugin — index location", () => {
  it("reports the pre-0.8.0 index directory when it still holds an index", async () => {
    await withTempDir("ave-li-legacy-", async (dir) => {
      const legacy = join(dir, LEGACY_INDEX_DIR_NAME);
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "fts5.sqlite"), "");
      const plugin = makePlugin(spawnSequence(readyWorker({}, { document_count: 3 })).spawnWorker, { pluginDataDir: dir });
      await plugin.start();
      expect(plugin.getIndexLocation()).toEqual({
        indexRoot: "/state/workers/local-indexer-worker/index",
        documentCount: 3,
        inStateDirectory: true,
        legacyIndexDir: resolve(legacy),
      });
      await plugin.stop();
    });
  });

  it("reports no legacy directory when it is absent, empty, or the index is still there", async () => {
    await withTempDir("ave-li-nolegacy-", async (dir) => {
      const first = makePlugin(spawnSequence(readyWorker()).spawnWorker, { pluginDataDir: dir });
      await first.start();
      expect(first.getIndexLocation()?.legacyIndexDir).toBeNull();
      await first.stop();

      // A directory without fts5.sqlite holds no index worth rebuilding from.
      await mkdir(join(dir, LEGACY_INDEX_DIR_NAME), { recursive: true });
      const second = makePlugin(spawnSequence(readyWorker()).spawnWorker, { pluginDataDir: dir });
      await second.start();
      expect(second.getIndexLocation()?.legacyIndexDir).toBeNull();
      await second.stop();

      // The worker still resolved its index to the old directory: nothing moved.
      await writeFile(join(dir, LEGACY_INDEX_DIR_NAME, "fts5.sqlite"), "");
      const third = makePlugin(
        spawnSequence(readyWorker({}, { index_root: resolve(dir, LEGACY_INDEX_DIR_NAME) })).spawnWorker,
        { pluginDataDir: dir },
      );
      await third.start();
      expect(third.getIndexLocation()?.legacyIndexDir).toBeNull();
      await third.stop();
    });
  });
});

describe("manifest contract — UI-only tools are uiActions, not LLM tools", () => {
  type PureTool = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    _meta?: { ui?: { visibility?: string[] } };
  };
  const manifest = flattenAgentPluginsManifest(
    JSON.parse(readFileSync(join(__dirname, "..", "plugin.json"), "utf-8")),
  ) as unknown as {
    tools: PureTool[];
    [key: string]: unknown;
  };
  // Pure v6 manifest: a single tools[] array, visibility carried per-tool in
  // _meta.ui.visibility. "model" = LLM-callable (former tools[]), "app" =
  // renderer-invokable via bridge.callTool (former uiActions).
  const modelTools = manifest.tools
    .filter((t) => t._meta?.ui?.visibility?.includes("model"))
    .map((t) => t.name);
  const uiActions = manifest.tools
    .filter((t) => t._meta?.ui?.visibility?.includes("app"))
    .map((t) => t.name);

  // The 12→6 hard-cut consolidation: the LLM-visible tool surface is exactly
  // these 6. index_search absorbs chat_preview; index_scan absorbs
  // index_refresh_folder + document_index_scan; index_folders absorbs
  // index_add_folder + index_add_folders + index_remove_folder.
  const SIX_TOOLS = [
    "index_search",
    "index_scan",
    "index_folders",
    "index_documents",
    "index_get_document",
    "index_scan_status",
  ];

  it("tools[] is exactly the 6 consolidated tools", () => {
    expect([...modelTools].sort()).toEqual([...SIX_TOOLS].sort());
  });

  it("the 6 absorbed old tool names are gone from tools[] (no aliases)", () => {
    for (const gone of [
      "chat_preview",
      "document_index_scan",
      "index_refresh_folder",
      "index_add_folder",
      "index_add_folders",
      "index_remove_folder",
    ]) {
      expect(modelTools).not.toContain(gone);
    }
  });

  it("omits the retired keyword-to-tool manifest contract", () => {
    expect(Object.prototype.hasOwnProperty.call(manifest, "keywords")).toBe(false);
  });

  // Tools the renderer drives directly (folder picker, settings toggles,
  // warning buffer, orphan purge) — the model never calls these, so they
  // belong in uiActions[] only and must stay out of the LLM-visible tools[].
  const UI_ONLY = [
    "index_scan_cancel",
    "index_clear_warnings",
    "index_pick_folder",
    "index_preview_folder",
    "index_get_settings",
    "index_set_image_embedding",
    "index_folders_purge_orphans",
  ];

  it("the 7 UI-only tools are absent from LLM tools[]", () => {
    for (const name of UI_ONLY) {
      expect(modelTools, `${name} must not be LLM-visible`).not.toContain(name);
    }
  });

  it("the 7 UI-only tools are present in uiActions[]", () => {
    for (const name of UI_ONLY) {
      expect(uiActions, `${name} must stay renderer-invokable`).toContain(name);
    }
  });

  it("index_scan_status stays in tools[] (the model legitimately polls scan progress)", () => {
    expect(modelTools).toContain("index_scan_status");
  });

  it("every tool name in tools[] is unique (host runtime registry sync requires it)", () => {
    const names = manifest.tools.map((t) => t.name);
    expect(names.length).toBe(new Set(names).size);
  });
});

// ─── Egress broker lifecycle (P3 ⑬) ──────────────────────────────────────
