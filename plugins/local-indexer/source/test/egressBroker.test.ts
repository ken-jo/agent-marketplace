import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiKeyLease } from "@ave/plugin-contract";
import {
  CAPTION_IMAGE_BYTES_MAX,
  CAPTION_REQUEST_BYTES_MAX,
  EGRESS_CAPTION_METHOD,
  EGRESS_EMBEDDING_METHOD,
  EgressBroker,
  EgressLeaseDenied,
  WORKER_FRAME_BYTES_MAX,
  type EgressChannel,
  type EgressChannelResolution,
  type EgressRelayAnswer,
  type EgressUpstreamFetch,
} from "../src/egressBroker.js";

// The broker answers the worker's egress requests (worker stdio control v1,
// worker → plugin). Each test drives `handleWorkerRequest` the way the host
// relays a worker request, with a stub upstream, so every invariant fails if
// it were violated: the worker never sees a key, never names a host, and every
// refusal is an HTTP-shaped answer.

const REAL_HOST_KEY = "sk-REAL-HOST-CHAT-KEY-do-not-leak";
const REAL_AZURE_KEY = "AZURE-REAL-KEY-do-not-leak";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
  lease?: ApiKeyLease;
}

function makeUpstreamStub(responseBody = JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] })): {
  fetch: EgressUpstreamFetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetch: EgressUpstreamFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, lease: init.lease });
    return { status: 200, headers: { "content-type": "application/json", "content-length": "9" }, body: Buffer.from(responseBody) };
  };
  return { fetch, calls };
}

function makeBroker(opts: {
  embedding?: EgressChannel;
  caption?: EgressChannel;
  isUpstreamAllowed?: (url: string) => boolean;
  upstreamFetch?: EgressUpstreamFetch;
  audit?: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;
  requestTimeoutMs?: number;
}): EgressBroker {
  return new EgressBroker({
    channels: { embedding: opts.embedding ?? openaiChannel(), caption: opts.caption ?? openaiChannel() },
    isUpstreamAllowed: opts.isUpstreamAllowed ?? (() => true),
    upstreamFetch: opts.upstreamFetch ?? makeUpstreamStub().fetch,
    audit: opts.audit,
    requestTimeoutMs: opts.requestTimeoutMs,
  });
}

const openaiChannel = (apiKey = REAL_HOST_KEY): EgressChannel => async () => ({
  upstreamBaseUrl: "https://api.openai.com/v1",
  apiKey,
  authScheme: "bearer",
});

function ask(
  broker: EgressBroker,
  params: Record<string, unknown>,
  method = EGRESS_EMBEDDING_METHOD,
  signal = new AbortController().signal,
): Promise<EgressRelayAnswer> {
  return broker.handleWorkerRequest(method, params, signal);
}

const embeddingRequest = (extra: Record<string, unknown> = {}) => ({
  method: "POST",
  path: "/embeddings",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: ["hi"] }),
  ...extra,
});

describe("EgressBroker — worker requests it answers", () => {
  it("answers exactly egress_embedding and egress_caption", () => {
    expect(EgressBroker.handles(EGRESS_EMBEDDING_METHOD)).toBe(true);
    expect(EgressBroker.handles(EGRESS_CAPTION_METHOD)).toBe(true);
    expect(EgressBroker.handles("egress_reranker")).toBe(false);
    for (const method of [EGRESS_EMBEDDING_METHOD, EGRESS_CAPTION_METHOD]) {
      expect(method).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/);
    }
    // The worker sends exactly these names.
    const python = readFileSync(join(__dirname, "..", "worker", "stdio_egress.py"), "utf-8");
    expect(python).toContain(`"embedding": "${EGRESS_EMBEDDING_METHOD}"`);
    expect(python).toContain(`"caption": "${EGRESS_CAPTION_METHOD}"`);
  });

  it("refuses an unknown channel as a request error, without relaying", async () => {
    const upstream = makeUpstreamStub();
    const broker = makeBroker({ upstreamFetch: upstream.fetch });
    await expect(ask(broker, embeddingRequest(), "egress_reranker")).rejects.toThrow(/unknown worker request/);
    expect(upstream.calls).toHaveLength(0);
  });

  it("refuses malformed params as a request error", async () => {
    const broker = makeBroker({});
    await expect(broker.handleWorkerRequest(EGRESS_EMBEDDING_METHOD, null, new AbortController().signal)).rejects.toThrow(/object/);
    await expect(ask(broker, { method: "POST" })).rejects.toThrow(/path/);
    await expect(ask(broker, embeddingRequest({ body: 42 }))).rejects.toThrow(/body/);
  });
});

describe("EgressBroker — allowed requests", () => {
  it("relays to the host-resolved upstream with the real key, and returns the body verbatim", async () => {
    const upstream = makeUpstreamStub();
    const broker = makeBroker({ upstreamFetch: upstream.fetch });
    const answer = await ask(broker, embeddingRequest());
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ data: [{ embedding: [0.1, 0.2] }] });
    expect(answer.bodyEncoding).toBeUndefined();
    // Hop headers are dropped from the answer.
    expect(answer.headers).toEqual({ "content-type": "application/json" });
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/embeddings");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe(`Bearer ${REAL_HOST_KEY}`);
    expect(call.body?.toString()).toBe(JSON.stringify({ input: ["hi"] }));
    // The key never travels back to the worker.
    expect(JSON.stringify(answer)).not.toContain(REAL_HOST_KEY);
  });

  it("strips worker-set auth and drops every header off the allow-list", async () => {
    const upstream = makeUpstreamStub();
    const broker = makeBroker({ upstreamFetch: upstream.fetch });
    await ask(broker, embeddingRequest({
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        authorization: "Bearer worker-forged-key",
        "api-key": "worker-forged-key",
        "accept-encoding": "gzip",
        "OpenAI-Organization": "org-evil",
        "x-custom": "1",
      },
    }));
    const headers = upstream.calls[0]!.headers;
    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      Authorization: `Bearer ${REAL_HOST_KEY}`,
    });
    expect(JSON.stringify(headers)).not.toContain("worker-forged-key");
  });

  it("joins the worker's path to the upstream base — the worker only controls the remainder", async () => {
    const upstream = makeUpstreamStub();
    const broker = makeBroker({ upstreamFetch: upstream.fetch });
    await ask(broker, embeddingRequest({ path: "/v1/embeddings?model=x" }));
    expect(upstream.calls[0]!.url).toBe("https://api.openai.com/v1/v1/embeddings?model=x");
  });

  it("injects the correct auth scheme per channel/provider (Bearer / api-key)", async () => {
    const cases: Array<{ scheme: EgressChannelResolution["authScheme"]; key: string; header: string; value: string }> = [
      { scheme: "bearer", key: REAL_HOST_KEY, header: "Authorization", value: `Bearer ${REAL_HOST_KEY}` },
      { scheme: "api-key", key: REAL_AZURE_KEY, header: "api-key", value: REAL_AZURE_KEY },
    ];
    for (const c of cases) {
      const upstream = makeUpstreamStub();
      const channel: EgressChannel = async () => ({
        upstreamBaseUrl: "https://res.openai.azure.com",
        apiKey: c.key,
        authScheme: c.scheme,
      });
      const broker = makeBroker({ caption: channel, upstreamFetch: upstream.fetch });
      await ask(broker, embeddingRequest({ path: "/openai/deployments/vision/chat/completions?api-version=2024-08-01-preview" }), EGRESS_CAPTION_METHOD);
      const call = upstream.calls[0]!;
      expect(call.url).toBe("https://res.openai.azure.com/openai/deployments/vision/chat/completions?api-version=2024-08-01-preview");
      expect(call.headers[c.header]).toBe(c.value);
    }
  });

  it("injects exactly the key the channel resolver returns (the plugin-own key for a custom endpoint)", async () => {
    const PLUGIN_OWN_KEY = "plugin-own-user-key";
    const upstream = makeUpstreamStub();
    const custom: EgressChannel = async () => ({
      upstreamBaseUrl: "https://lmstudio.internal.example/v1",
      apiKey: PLUGIN_OWN_KEY,
      authScheme: "bearer",
    });
    const broker = makeBroker({
      embedding: custom,
      isUpstreamAllowed: (url) => new URL(url).host === "lmstudio.internal.example",
      upstreamFetch: upstream.fetch,
    });
    await ask(broker, embeddingRequest());
    expect(upstream.calls[0]!.headers.Authorization).toBe(`Bearer ${PLUGIN_OWN_KEY}`);
    expect(JSON.stringify(upstream.calls[0]!.headers)).not.toContain(REAL_HOST_KEY);
  });

  it("uses a fresh lease per request, adds no auth header for it, and releases it after the relay", async () => {
    const release = vi.fn(async () => {});
    let nextId = 0;
    const channel: EgressChannel = async () => {
      const lease: ApiKeyLease = {
        exposure: "lease", leaseId: `lease-${++nextId}`, vendor: "openai",
        release, onClosed: () => () => {},
      };
      return { upstreamBaseUrl: "https://api.openai.com/v1", lease, authScheme: "bearer" };
    };
    const seen: string[] = [];
    const upstreamFetch: EgressUpstreamFetch = async (_url, init) => {
      expect(init.headers).not.toHaveProperty("Authorization");
      expect(init.headers).not.toHaveProperty("api-key");
      expect(release).toHaveBeenCalledTimes(seen.length);
      seen.push(init.lease!.leaseId);
      return { status: 200, headers: {}, body: Buffer.from("ok") };
    };
    const broker = makeBroker({ embedding: channel, upstreamFetch });
    for (let i = 0; i < 2; i++) {
      const answer = await ask(broker, embeddingRequest());
      expect(answer).toMatchObject({ status: 200, body: "ok" });
      expect(release).toHaveBeenCalledTimes(i + 1);
    }
    expect(seen).toEqual(["lease-1", "lease-2"]);
  });

  it("relays a 64-input batch and returns the upstream body", async () => {
    let seenBody: Buffer | undefined;
    const big = JSON.stringify({ data: Array.from({ length: 64 }, () => ({ embedding: [0.1, 0.2, 0.3] })) });
    const broker = makeBroker({
      upstreamFetch: async (_url, init) => {
        seenBody = init.body;
        return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(big) };
      },
    });
    const batch = JSON.stringify({ input: Array.from({ length: 64 }, (_v, i) => `chunk-${i}`) });
    const answer = await ask(broker, embeddingRequest({ body: batch }));
    expect(seenBody?.toString()).toBe(batch);
    expect((JSON.parse(answer.body) as { data: unknown[] }).data).toHaveLength(64);
  });

  it("carries a base64 request body and a non-UTF-8 answer body both ways", async () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    let seenBody: Buffer | undefined;
    const broker = makeBroker({
      upstreamFetch: async (_url, init) => {
        seenBody = init.body;
        return { status: 200, headers: {}, body: binary };
      },
    });
    const answer = await ask(broker, embeddingRequest({ body: binary.toString("base64"), bodyEncoding: "base64" }));
    expect(seenBody?.equals(binary)).toBe(true);
    expect(answer.bodyEncoding).toBe("base64");
    expect(Buffer.from(answer.body, "base64").equals(binary)).toBe(true);
  });
});

describe("EgressBroker — refused requests answer as HTTP and never relay", () => {
  it("refuses an upstream that is not allow-listed with 403, audited without the key", async () => {
    const upstream = makeUpstreamStub();
    const logs: Array<[string, Record<string, unknown>]> = [];
    const broker = makeBroker({
      embedding: async () => ({ upstreamBaseUrl: "https://evil.attacker.example/v1", apiKey: REAL_HOST_KEY, authScheme: "bearer" }),
      isUpstreamAllowed: (url) => new URL(url).host === "api.openai.com",
      upstreamFetch: upstream.fetch,
      audit: (_lvl, event, fields) => logs.push([event, fields]),
    });
    const answer = await ask(broker, embeddingRequest());
    expect(answer.status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
    expect(logs.find(([e]) => e === "local_indexer.egress_refused")).toBeDefined();
    expect(JSON.stringify(logs)).not.toContain(REAL_HOST_KEY);
    expect(JSON.stringify(answer)).not.toContain(REAL_HOST_KEY);
  });

  it("refuses a path that could change the authority or is not absolute", async () => {
    const upstream = makeUpstreamStub();
    const broker = makeBroker({
      embedding: async () => ({ upstreamBaseUrl: "https://api.openai.com", apiKey: REAL_HOST_KEY, authScheme: "bearer" }),
      upstreamFetch: upstream.fetch,
    });
    for (const path of ["@evil.example/x", "//evil.example/x", "embeddings", "/a\\b", "/a b", "/x#frag", "/x@evil.example", ""]) {
      const answer = await ask(broker, embeddingRequest({ path }));
      expect(answer.status, path).toBe(400);
    }
    expect(upstream.calls).toHaveLength(0);
  });

  it("refuses methods other than GET and POST", async () => {
    const upstream = makeUpstreamStub();
    const broker = makeBroker({ upstreamFetch: upstream.fetch });
    expect((await ask(broker, embeddingRequest({ method: "DELETE" }))).status).toBe(405);
    expect(upstream.calls).toHaveLength(0);
  });

  it("maps lease and effect denials to one terminal 403 event", async () => {
    for (const reason of ["audience-not-allowlisted", "lease-unavailable", "effect-boundary-denied"]) {
      const audit = vi.fn();
      const upstreamFetch = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
      const channel: EgressChannel = async () => { throw new EgressLeaseDenied(reason); };
      const broker = makeBroker({ embedding: channel, upstreamFetch, audit });
      const answer = await ask(broker, embeddingRequest());
      expect(answer.status).toBe(403);
      expect(JSON.parse(answer.body)).toEqual({ error: "egress-denied", reason, terminal: true });
      expect(upstreamFetch).not.toHaveBeenCalled();
      expect(audit.mock.calls.filter(([, event]) => event === "indexer.egress.denied")).toHaveLength(1);
    }
  });

  it("maps host rate limiting to 429 with Retry-After", async () => {
    const broker = makeBroker({
      embedding: async () => {
        throw Object.assign(new Error("limited"), { code: "rate-limited", retryAfterMs: 2400 });
      },
    });
    const answer = await ask(broker, embeddingRequest());
    expect(answer.status).toBe(429);
    expect(answer.headers["retry-after"]).toBe("3");
  });

  it("releases a revoked lease and returns one terminal denial", async () => {
    const release = vi.fn(async () => {});
    const lease: ApiKeyLease = { exposure: "lease", leaseId: "revoked", vendor: "openai", release, onClosed: () => () => {} };
    const upstreamFetch = vi.fn(async () => {
      throw Object.assign(new Error("revoked"), { code: "lease-unavailable" });
    });
    const broker = makeBroker({
      embedding: async () => ({ upstreamBaseUrl: "https://api.openai.com/v1", lease, authScheme: "bearer" }),
      upstreamFetch,
    });
    const answer = await ask(broker, embeddingRequest());
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toEqual({ error: "egress-denied", reason: "lease-unavailable", terminal: true });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("answers 499 when the worker withdraws the request, and releases the lease", async () => {
    const release = vi.fn(async () => {});
    const lease: ApiKeyLease = { exposure: "lease", leaseId: "cancelled", vendor: "openai", release, onClosed: () => () => {} };
    const workerCancel = new AbortController();
    const broker = makeBroker({
      embedding: async () => ({ upstreamBaseUrl: "https://api.openai.com/v1", lease, authScheme: "bearer" }),
      upstreamFetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    });
    const pending = ask(broker, embeddingRequest(), EGRESS_EMBEDDING_METHOD, workerCancel.signal);
    await new Promise((r) => setTimeout(r, 5));
    workerCancel.abort();
    const answer = await pending;
    expect(answer.status).toBe(499);
    expect(JSON.parse(answer.body)).toEqual({ error: "egress-denied", reason: "cancelled", terminal: true });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("times out a stuck upstream with 499 timeout", async () => {
    const broker = makeBroker({
      requestTimeoutMs: 10,
      upstreamFetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    });
    const answer = await ask(broker, embeddingRequest());
    expect(answer.status).toBe(499);
    expect(JSON.parse(answer.body).reason).toBe("timeout");
  });

  it("maps a transport failure to 502 for bounded worker retry", async () => {
    const broker = makeBroker({ upstreamFetch: async () => { throw new Error("ECONNREFUSED"); } });
    const answer = await ask(broker, embeddingRequest());
    expect(answer.status).toBe(502);
    expect(answer.body).not.toContain(REAL_HOST_KEY);
  });

  it("refuses an upstream answer that could not fit one worker frame", async () => {
    const huge = Buffer.alloc(WORKER_FRAME_BYTES_MAX, 0x61);
    const broker = makeBroker({ upstreamFetch: async () => ({ status: 200, headers: {}, body: huge }) });
    const answer = await ask(broker, embeddingRequest());
    expect(answer.status).toBe(502);
    expect(answer.body).toMatch(/too large/);
  });

  it("requires the host-mediated upstream transport", () => {
    expect(() => new EgressBroker({
      channels: { embedding: openaiChannel(), caption: openaiChannel() },
      isUpstreamAllowed: () => true,
      upstreamFetch: undefined as unknown as EgressUpstreamFetch,
    })).toThrow(/upstreamFetch/);
  });
});

describe("EgressBroker — caption relay cap", () => {
  it("is 11 MiB of raw image, and the largest request still fits one frame", () => {
    expect(CAPTION_IMAGE_BYTES_MAX).toBe(11 * 1024 * 1024);
    // The worker enforces the same number on its side.
    const python = readFileSync(join(__dirname, "..", "worker", "stdio_egress.py"), "utf-8");
    expect(python).toMatch(/^CAPTION_IMAGE_BYTES_MAX = 11 \* 1024 \* 1024$/m);
    expect(CAPTION_REQUEST_BYTES_MAX).toBeLessThan(WORKER_FRAME_BYTES_MAX);
  });

  it("relays a caption request at the cap", async () => {
    const upstream = makeUpstreamStub();
    const broker = makeBroker({ upstreamFetch: upstream.fetch });
    const body = "x".repeat(CAPTION_REQUEST_BYTES_MAX);
    const answer = await ask(broker, embeddingRequest({ path: "/responses", body }), EGRESS_CAPTION_METHOD);
    expect(answer.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
  });

  it("refuses a larger caption request with a visible 413, without resolving a credential", async () => {
    const upstream = makeUpstreamStub();
    const caption = vi.fn(openaiChannel());
    const audit = vi.fn();
    const broker = makeBroker({ caption, upstreamFetch: upstream.fetch, audit });
    const body = "x".repeat(CAPTION_REQUEST_BYTES_MAX + 1);
    const answer = await ask(broker, embeddingRequest({ path: "/responses", body }), EGRESS_CAPTION_METHOD);
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toEqual({ error: "caption image exceeds the 11 MiB relay cap" });
    expect(caption).not.toHaveBeenCalled();
    expect(upstream.calls).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith("warn", "local_indexer.egress_refused", expect.objectContaining({
      channel: "caption",
      reason: "caption image over the relay cap",
    }));
  });

  it("does not apply the caption cap to embeddings", async () => {
    const upstream = makeUpstreamStub();
    const broker = makeBroker({ upstreamFetch: upstream.fetch });
    const answer = await ask(broker, embeddingRequest({ body: "x".repeat(CAPTION_REQUEST_BYTES_MAX + 1) }));
    expect(answer.status).toBe(200);
  });
});
