import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  endpointHostForLog,
  endpointQueryParam,
  endpointRoot,
  isTrustedEndpointUrl,
  normalizeUncRoot,
  resolveAzureResourceEndpoint,
  validateEndpointUrl,
} from "../src/hostPlugin.js";
import { flattenAgentPluginsManifest } from "@ave/plugin-contract";
import { RESCAN_OVERLAY_SOURCE } from "../src/rescanSuggestion.js";

// Manifest loaded once — every contract assertion runs against the same
// source-of-truth file the host's AJV validator consumes at install time.
type PureTool = {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  _meta?: { ui?: { visibility?: string[] }; [key: string]: unknown };
};
const manifest = flattenAgentPluginsManifest(
  JSON.parse(readFileSync(join(__dirname, "..", "plugin.json"), "utf-8")),
) as unknown as Record<string, any> & { tools: PureTool[] };
const toolByName = new Map(manifest.tools.map((t) => [t.name, t]));
// Pure v6 manifest: a single tools[] array, visibility carried per-tool in
// _meta.ui.visibility. "app" = renderer-invokable via bridge.callTool
// (former uiActions); "model" = LLM-callable (former tools[]).
const uiActions = manifest.tools
  .filter((t) => t._meta?.ui?.visibility?.includes("app"))
  .map((t) => t.name);

describe("validateEndpointUrl — SSRF gate by allowLoopback", () => {
  it("accepts any https URL regardless of loopback flag", () => {
    expect(
      validateEndpointUrl("https://api.openai.com/v1", { allowLoopback: false }),
    ).toBe("https://api.openai.com/v1");
    expect(
      validateEndpointUrl("https://corp.openai.azure.com/", { allowLoopback: false }),
    ).toBe("https://corp.openai.azure.com/");
    expect(
      validateEndpointUrl("https://api.openai.com/v1", { allowLoopback: true }),
    ).toBe("https://api.openai.com/v1");
  });

  it("accepts http://localhost ONLY when allowLoopback=true (openai provider gate)", () => {
    expect(
      validateEndpointUrl("http://localhost:1234/v1", { allowLoopback: true }),
    ).toBe("http://localhost:1234/v1");
    expect(
      validateEndpointUrl("http://127.0.0.1:11434/v1", { allowLoopback: true }),
    ).toBe("http://127.0.0.1:11434/v1");
    expect(
      validateEndpointUrl("http://[::1]:8080/", { allowLoopback: true }),
    ).toBe("http://[::1]:8080/");
  });

  it("rejects http://loopback when allowLoopback=false (azure path)", () => {
    expect(
      validateEndpointUrl("http://localhost:1234/v1", { allowLoopback: false }),
    ).toBe("");
    expect(
      validateEndpointUrl("http://127.0.0.1:11434/v1", { allowLoopback: false }),
    ).toBe("");
    expect(
      validateEndpointUrl("http://[::1]:8080/", { allowLoopback: false }),
    ).toBe("");
  });

  it("rejects http:// against non-loopback hosts unconditionally", () => {
    expect(
      validateEndpointUrl("http://internal.corp/v1", { allowLoopback: true }),
    ).toBe("");
    expect(
      validateEndpointUrl("http://10.0.0.5/", { allowLoopback: true }),
    ).toBe("");
    expect(
      validateEndpointUrl("http://example.com/", { allowLoopback: false }),
    ).toBe("");
  });

  it("rejects non-http(s) schemes (file://, ftp://, javascript:)", () => {
    expect(
      validateEndpointUrl("file:///etc/passwd", { allowLoopback: true }),
    ).toBe("");
    expect(
      validateEndpointUrl("ftp://example.com/", { allowLoopback: true }),
    ).toBe("");
    // eslint-disable-next-line no-script-url
    expect(
      validateEndpointUrl("javascript:alert(1)", { allowLoopback: true }),
    ).toBe("");
  });

  it("rejects empty / malformed / non-string inputs", () => {
    expect(validateEndpointUrl("", { allowLoopback: true })).toBe("");
    expect(validateEndpointUrl("not a url", { allowLoopback: true })).toBe("");
    expect(validateEndpointUrl(null, { allowLoopback: true })).toBe("");
    expect(validateEndpointUrl(undefined, { allowLoopback: true })).toBe("");
    expect(validateEndpointUrl(42, { allowLoopback: true })).toBe("");
  });
});

describe("isTrustedEndpointUrl — host-key trust chokepoint", () => {
  it("accepts api.openai.com (exact host) over https", () => {
    expect(isTrustedEndpointUrl("https://api.openai.com")).toBe(true);
    expect(isTrustedEndpointUrl("https://api.openai.com/v1")).toBe(true);
  });

  it("accepts *.openai.azure.com and *.cognitiveservices.azure.com (dot-boundary suffix)", () => {
    expect(isTrustedEndpointUrl("https://corp.openai.azure.com/")).toBe(true);
    expect(
      isTrustedEndpointUrl(
        "https://tenant.cognitiveservices.azure.com/openai/deployments/x/embeddings?api-version=1",
      ),
    ).toBe(true);
  });

  it("rejects arbitrary custom endpoints (LM Studio / internal proxy / attacker base_url)", () => {
    expect(isTrustedEndpointUrl("https://evil.com/v1")).toBe(false);
    expect(isTrustedEndpointUrl("https://internal.corp/openai")).toBe(false);
  });

  it("rejects look-alike hosts via dot-boundary matching (no naive substring/endsWith)", () => {
    // The canonical bypass the dot-boundary check defeats.
    expect(
      isTrustedEndpointUrl("https://evil-openai.azure.com.attacker.com/"),
    ).toBe(false);
    expect(isTrustedEndpointUrl("https://api.openai.com.attacker.com/")).toBe(false);
    expect(isTrustedEndpointUrl("https://notapi.openai.com/")).toBe(false);
    expect(isTrustedEndpointUrl("https://fakecognitiveservices.azure.com/")).toBe(false);
  });

  it("rejects loopback and http downgrade (host key is https-trusted only)", () => {
    expect(isTrustedEndpointUrl("http://localhost:1234/v1")).toBe(false);
    expect(isTrustedEndpointUrl("http://127.0.0.1:11434/v1")).toBe(false);
    expect(isTrustedEndpointUrl("http://api.openai.com/v1")).toBe(false);
  });

  it("rejects empty / malformed / non-string inputs (won't throw)", () => {
    expect(isTrustedEndpointUrl("")).toBe(false);
    expect(isTrustedEndpointUrl("not a url")).toBe(false);
    expect(isTrustedEndpointUrl(null)).toBe(false);
    expect(isTrustedEndpointUrl(undefined)).toBe(false);
    expect(isTrustedEndpointUrl(42)).toBe(false);
  });

  it("stays aligned with plugin.json networkAccess.allowedDomains", () => {
    const domains: string[] = manifest.networkAccess.allowedDomains;
    expect(domains).toContain("api.openai.com");
    expect(domains).toContain("openai.azure.com");
    expect(domains).toContain("cognitiveservices.azure.com");
  });

  it("declares the loopback literals without making them trusted", () => {
    // The declaration is what lets the host reach a local inference server the
    // user configured in `embeddingEndpoint` — without it the setting is denied
    // at hostFetch no matter what is typed.
    const domains: string[] = manifest.networkAccess.allowedDomains;
    expect(domains).toContain("localhost");
    expect(domains).toContain("127.0.0.1");
    expect(domains).toContain("::1");
    // Reachable is not trusted: the HOST key never follows the plugin to a
    // local endpoint, declared or not. Only the plugin's own key may go there.
    expect(isTrustedEndpointUrl("http://localhost:1234/v1")).toBe(false);
    expect(isTrustedEndpointUrl("https://localhost:8443/v1")).toBe(false);
    expect(isTrustedEndpointUrl("https://127.0.0.1:8443/v1")).toBe(false);
  });
});

describe("endpointHostForLog — redact path/query but keep host", () => {
  it("returns the host portion only for full Azure URLs", () => {
    expect(
      endpointHostForLog(
        "https://tenant.openai.azure.com/openai/deployments/my-emb/embeddings?api-version=2024-08-01-preview",
      ),
    ).toBe("tenant.openai.azure.com");
  });

  it("returns the host for plain OpenAI URLs", () => {
    expect(endpointHostForLog("https://api.openai.com/v1")).toBe("api.openai.com");
  });

  it("preserves the port", () => {
    expect(endpointHostForLog("http://localhost:1234/v1")).toBe("localhost:1234");
  });

  it("returns '' for empty / malformed input (won't throw)", () => {
    expect(endpointHostForLog("")).toBe("");
    expect(endpointHostForLog("not a url")).toBe("");
  });
});

describe("Azure endpoint helpers", () => {
  it("reduces a full Azure URL to its resource root", () => {
    expect(
      endpointRoot(
        "https://tenant.cognitiveservices.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2023-05-15",
      ),
    ).toBe("https://tenant.cognitiveservices.azure.com/");
  });

  it("extracts api-version from a pasted full endpoint", () => {
    expect(
      endpointQueryParam(
        "https://tenant.cognitiveservices.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2023-05-15",
        "api-version",
      ),
    ).toBe("2023-05-15");
  });

  it("resolves Azure roots by explicit, fallback, then host baseUrl precedence", () => {
    expect(
      resolveAzureResourceEndpoint({
        explicitEndpoint: "https://explicit.openai.azure.com/openai/deployments/a/embeddings?api-version=1",
        fallbackEndpoint: "https://fallback.cognitiveservices.azure.com/openai/responses?api-version=2",
        hostBaseUrl: "https://host.openai.azure.com/openai/deployments/b/chat/completions?api-version=3",
      }),
    ).toBe("https://explicit.openai.azure.com/");
    expect(
      resolveAzureResourceEndpoint({
        fallbackEndpoint: "https://fallback.cognitiveservices.azure.com/openai/responses?api-version=2",
        hostBaseUrl: "https://host.openai.azure.com/openai/deployments/b/chat/completions?api-version=3",
      }),
    ).toBe("https://fallback.cognitiveservices.azure.com/");
    expect(
      resolveAzureResourceEndpoint({
        hostBaseUrl: "https://host.openai.azure.com/openai/deployments/b/chat/completions?api-version=3",
      }),
    ).toBe("https://host.openai.azure.com/");
  });
});

describe("manifest contract — uiActions narrowing", () => {
  it("removes LLM-only tools (chat_preview, index_search, etc.) from uiActions", () => {
    const ui = uiActions;
    expect(ui).not.toContain("chat_preview");
    expect(ui).not.toContain("index_search");
    expect(ui).not.toContain("index_get_document");
    expect(ui).not.toContain("document_index_scan");
    expect(ui).not.toContain("index_add_folder");
  });

  it("keeps every tool the webview actually invokes via bridge.callTool", () => {
    const ui = uiActions;
    // After the 12→6 consolidation the UI invokes index_scan (full scan /
    // {folder} refresh / {paths} drop) and index_folders (list / add / remove)
    // instead of the former index_refresh_folder / index_add_folders /
    // index_remove_folder tools.
    for (const required of [
      "index_scan",
      "index_scan_cancel",
      "index_scan_status",
      "index_documents",
      "index_folders",
      "index_folders_purge_orphans",
      "index_pick_folder",
      "index_preview_folder",
      "index_get_settings",
      "index_set_image_embedding",
    ]) {
      expect(ui).toContain(required);
    }
  });

  it("the consolidated old tool names are gone from uiActions (hard-cut, no aliases)", () => {
    const ui = uiActions;
    for (const gone of [
      "index_refresh_folder",
      "index_add_folder",
      "index_add_folders",
      "index_remove_folder",
      "chat_preview",
      "document_index_scan",
    ]) {
      expect(ui).not.toContain(gone);
    }
  });

  it("uiActions entries are valid runtime method names", () => {
    // UI-only methods (in uiActions, absent from tools[]) may keep a
    // descriptive toolSchemas entry — the LLM-visible set is tools[], so a
    // schema for a uiActions-only method is renderer/tooltip metadata that is
    // never surfaced to the model. The only hard invariant here is that every
    // uiActions entry is a valid runtime method name.
    const methodName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    for (const name of uiActions) {
      expect(methodName.test(name), `uiActions '${name}' must be a valid runtime method name`).toBe(true);
    }
  });
});

describe("manifest contract — toolSchemas integrity", () => {
  // Pure v6 tools[] is an array, not a dict keyed by name, so the old
  // dict-key uniqueness guarantee no longer comes for free — assert it.
  it("every tool name in tools[] is unique (host runtime registry sync requires it)", () => {
    const names = manifest.tools.map((t) => t.name);
    expect(names.length).toBe(new Set(names).size);
  });

  // The old "orphan schema" check guarded against a toolSchemas entry with
  // no tools[]/uiActions[] membership. In the pure shape a schema can't be
  // orphaned from its tool (it's embedded on it), but a tool can still be
  // orphaned from every *surface* — assert every tool is reachable somehow.
  it("every tool has a non-empty _meta.ui.visibility (no orphan/unreachable tool entries)", () => {
    for (const t of manifest.tools) {
      const visibility = t._meta?.ui?.visibility ?? [];
      expect(visibility.length, `tool '${t.name}' has no visibility — orphaned entry`).toBeGreaterThan(0);
    }
  });

  it("each tool has a valid draft-07 object inputSchema", () => {
    for (const t of manifest.tools) {
      expect(t.inputSchema, `${t.name}.inputSchema missing`).toBeDefined();
      expect(t.inputSchema.type, `${t.name}.inputSchema.type`).toBe("object");
      expect(t.inputSchema.properties, `${t.name}.inputSchema.properties missing`).toBeDefined();
    }
  });
});

describe("manifest contract — index_set_image_embedding inputSchema is enabled-only", () => {
  it("accepts only {enabled: boolean} — provider/model/apiKey removed", () => {
    const schema = toolByName.get("index_set_image_embedding")!.inputSchema;
    expect(Object.keys(schema.properties)).toEqual(["enabled"]);
    expect(schema.properties.enabled.type).toBe("boolean");
    expect(schema.required).toEqual(["enabled"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty("provider");
    expect(schema.properties).not.toHaveProperty("model");
    expect(schema.properties).not.toHaveProperty("apiKey");
  });
});

describe("manifest contract — input schema length & pattern guards", () => {
  it("index_search.query caps at 2000 chars (covers the former chat_preview.question)", () => {
    const q = toolByName.get("index_search")!.inputSchema.properties.query;
    expect(q.maxLength).toBe(2000);
    expect(q.minLength).toBe(1);
  });

  it("index_scan.paths caps array + item length (former document_index_scan.paths)", () => {
    const p = toolByName.get("index_scan")!.inputSchema.properties.paths;
    expect(p.maxItems).toBe(200);
    expect(p.minItems).toBe(1);
    expect(p.items.maxLength).toBe(4096);
    expect(p.items.minLength).toBe(1);
  });

  it("index_get_document.pages enforces worker _PAGES_RE pattern", () => {
    const pages = toolByName.get("index_get_document")!.inputSchema.properties.pages;
    expect(pages.maxLength).toBe(200);
    expect(pages.pattern).toBe("^[0-9,\\-\\s]{1,200}$");
  });

  it("index_get_document.includeStructure is a closed boolean flag", () => {
    const schema = toolByName.get("index_get_document")!.inputSchema;
    expect(schema.properties.includeStructure.type).toBe("boolean");
    expect(schema.additionalProperties).toBe(false);
  });

  it("index_folders.folder enforces absolute / ~ / . prefix (former index_add_folder.folder)", () => {
    const f = toolByName.get("index_folders")!.inputSchema.properties.folder;
    expect(f.pattern).toBe("^([A-Za-z]:[\\\\/]|/|~|\\.)");
    expect(f.maxLength).toBe(4096);
  });

  it("index_folders.folders caps array + item length (former index_add_folders.folders)", () => {
    const f = toolByName.get("index_folders")!.inputSchema.properties.folders;
    expect(f.maxItems).toBe(200);
    expect(f.minItems).toBe(1);
    expect(f.items.maxLength).toBe(4096);
  });
});

describe("normalizeUncRoot — user-supplied UNC allow-list entries", () => {
  it("accepts well-formed `\\\\server\\share` prefixes and canonicalizes them", () => {
    expect(normalizeUncRoot("\\\\nas01.example.com\\users$")).toBe(
      "\\\\nas01.example.com\\users$",
    );
    expect(normalizeUncRoot("\\\\server\\share\\subdir")).toBe("\\\\server\\share\\subdir");
  });

  it("strips trailing slashes and folds forward slashes to backslashes", () => {
    expect(normalizeUncRoot("\\\\server\\share\\")).toBe("\\\\server\\share");
    expect(normalizeUncRoot("//server/share/sub")).toBe("\\\\server\\share\\sub");
    expect(normalizeUncRoot("\\\\server\\share\\\\\\")).toBe("\\\\server\\share");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeUncRoot("  \\\\server\\share  ")).toBe("\\\\server\\share");
  });

  it("rejects blanket / overly-short prefixes (no entry can open the whole UNC namespace)", () => {
    expect(normalizeUncRoot("\\\\")).toBeNull();
    expect(normalizeUncRoot("\\\\server")).toBeNull();
    expect(normalizeUncRoot("\\\\server\\")).toBeNull();
  });

  it("rejects Windows device-namespace prefixes (\\\\?\\ and \\\\.\\)", () => {
    expect(normalizeUncRoot("\\\\?\\C:\\Windows")).toBeNull();
    expect(normalizeUncRoot("\\\\.\\pipe\\foo")).toBeNull();
  });

  it("rejects non-UNC / malformed / non-string / NUL-injected inputs", () => {
    expect(normalizeUncRoot("C:\\foo")).toBeNull();
    expect(normalizeUncRoot("/etc/passwd")).toBeNull();
    expect(normalizeUncRoot("")).toBeNull();
    expect(normalizeUncRoot("   ")).toBeNull();
    expect(normalizeUncRoot(null)).toBeNull();
    expect(normalizeUncRoot(undefined)).toBeNull();
    expect(normalizeUncRoot(42)).toBeNull();
    expect(normalizeUncRoot("\\\\server\\share\0evil")).toBeNull();
  });

  it("rejects entries longer than 4096 chars (DoS / config-bloat guard)", () => {
    const longShare = "\\\\server\\share\\" + "x".repeat(4100);
    expect(normalizeUncRoot(longShare)).toBeNull();
  });
});

describe("manifest contract — configSchema allowedUncRoots", () => {
  it("declares allowedUncRoots as an empty-by-default string array (host's configSchema validator forbids items.minLength/maxLength/pattern, so item-level validation lives in normalizeUncRoot at runtime)", () => {
    const schema = manifest.configSchema.properties.allowedUncRoots;
    expect(schema).toBeDefined();
    expect(schema.type).toBe("array");
    expect(schema.default).toEqual([]);
    expect(schema.items.type).toBe("string");
    // Host's PluginManifest schema (SDK v5.7+) only allows `type` on
    // configSchema array items — `minLength`, `maxLength`, `pattern` are
    // rejected by Ave's manifest validator with "unknown property".
    // The runtime guard (normalizeUncRoot) carries the real validation
    // and silently drops malformed entries; covered separately above.
    expect(schema.items).not.toHaveProperty("minLength");
    expect(schema.items).not.toHaveProperty("maxLength");
    expect(schema.items).not.toHaveProperty("pattern");
  });
});

describe("manifest contract — runtime/startup hardening", () => {
  it("startupTimeoutMs is at least 30000 (worker first-boot needs 30s on slow machines)", () => {
    expect(manifest.startupTimeoutMs).toBeGreaterThanOrEqual(30000);
  });

  it("eventSubscriptions declares the host theme broadcast only", () => {
    expect(manifest.eventSubscriptions).toEqual([
      { type: "host.theme.changed" },
    ]);
  });

  it("emittedEvents stay under host-recognized PUBLIC index.* namespace (matches knowledge-index capability)", () => {
    const events: string[] = manifest.emittedEvents;
    for (const e of events) {
      expect(e).toMatch(/^index\./);
    }
    expect(manifest.capabilities).toContain("knowledge-index");
  });

  it("secret-typed config fields keep format: 'secret'", () => {
    const cfg = manifest.configSchema.properties;
    expect(cfg.embeddingApiKey.format).toBe("secret");
    expect(cfg.imageCaptionApiKey.format).toBe("secret");
  });
});

describe("manifest contract — opt-in index alerts", () => {
  it("declares both index signals as summary-only and off by default", () => {
    expect(manifest).not.toHaveProperty("notificationEvents");
    expect(manifest.alerts.kinds.map((kind: { id: string }) => kind.id)).toEqual([
      "index-scan-completed",
      "index-folders-changed",
    ]);
    for (const kind of manifest.alerts.kinds) {
      expect(kind.defaultEnabled).toBe(false);
      expect(kind.visibility).toBe("summary-only");
      expect(kind).not.toHaveProperty("osNotification");
      expect(kind.slots).toBeUndefined();
    }
    expect(manifest.emittedEvents).toEqual(expect.arrayContaining([
      "index.scan.completed",
      "index.folders.changed",
    ]));
  });

  it("declares the existing one-time rescan suggestion source", () => {
    expect(manifest.alerts.suggestions).toEqual([RESCAN_OVERLAY_SOURCE]);
  });
});

// ─── Ambient axis 3: process spawning ────────────────────────────────────
// The plugin is routed out-of-process, and the ONE thing that route rests on
// is that its ambient reach is what the host mediates. Spawning is the axis
// with no runtime signal when it comes back: the sandbox's seatbelt profile
// carries `(allow process-exec)`, so a reintroduced spawn does not fail — it
// runs, quietly, and the confinement argument stops being true without
// anything going red. A structural check is the only thing that notices.
describe("the plugin does not spawn processes itself", () => {
  const SOURCES = [
    "hostPlugin.ts",
    "localIndexerPlugin.ts",
    "egressBroker.ts",
    "workerClient.ts",
    "folderIndexer.ts",
    "indexingFiles.ts",
    "indexState.ts",
    "rescanSuggestion.ts",
  ];

  it.each(SOURCES)("%s imports no process-spawning module", (file) => {
    const source = readFileSync(join(__dirname, "..", "src", file), "utf-8");
    // Import form only. The WORDS `spawn` and `execFile` appear legitimately —
    // `hostApi.spawnWorker` is the mediated form and is named in prose all over
    // these files — so matching the name rather than the import is the
    // mentions-as-reach error the routing SOT warns about.
    expect(source).not.toMatch(/from\s+["']node:child_process["']/u);
    expect(source).not.toMatch(/from\s+["']child_process["']/u);
    expect(source).not.toMatch(/require\(\s*["'](node:)?child_process["']\s*\)/u);
  });

  it("reaches the worker through hostApi.spawnWorker and nothing else", () => {
    const source = readFileSync(join(__dirname, "..", "src", "localIndexerPlugin.ts"), "utf-8");
    // The mediated call site still exists. Without this the test above would
    // also pass on a build that had lost the ability to start a worker at all.
    expect(source).toMatch(/this\.options\.spawnWorker\(/u);
  });

  it("asks the host for a mapped drive's UNC root", () => {
    const source = readFileSync(join(__dirname, "..", "src", "hostPlugin.ts"), "utf-8");
    // The drive lookup used to be a `powershell.exe` spawn here. It is now a
    // question put to the host, and this is what keeps the removal from being
    // mistaken for the feature having been dropped.
    expect(source).toMatch(/hostApi\.resolveMappedDriveRoot\(/u);
  });
});
