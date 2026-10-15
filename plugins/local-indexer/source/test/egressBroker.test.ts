import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EGRESS_TOKEN_HEADER,
  EgressBroker,
  EgressLeaseDenied,
  egressBrokerTransportFor,
  egressBrokerWorkerArgs,
  type EgressBrokerInfo,
  type EgressChannel,
  type EgressChannelResolution,
  type EgressUpstreamFetch,
} from "../src/egressBroker.js";
import type { ApiKeyLease } from "@ave/plugin-contract";

// ── Test harness ─────────────────────────────────────────────────────────
// Each test starts a REAL loopback broker and a stub upstream transport so the
// security logic (token auth, channel routing, allow-list, auth-scheme rewrite,
// host-resolved upstream) is exercised end-to-end without any network. Every
// invariant test is written to FAIL if the invariant were violated.

const REAL_HOST_KEY = "sk-REAL-HOST-CHAT-KEY-do-not-leak";
const REAL_AZURE_KEY = "AZURE-REAL-KEY-do-not-leak";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
}

function makeUpstreamStub(): { fetch: EgressUpstreamFetch; calls: Captured[]; body: () => Buffer } {
  const calls: Captured[] = [];
  let responseBody = Buffer.from(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
  const fetch: EgressUpstreamFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: responseBody,
    };
  };
  return {
    fetch,
    calls,
    body: () => responseBody,
  };
}

const brokers: EgressBroker[] = [];
async function startBroker(opts: {
  embedding: EgressChannel;
  caption: EgressChannel;
  token?: string;
  isUpstreamAllowed?: (url: string) => boolean;
  upstreamFetch?: EgressUpstreamFetch;
  logEvent?: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;
}): Promise<{ broker: EgressBroker; baseUrl: string; token: string }> {
  const token = opts.token ?? "session-token-abc123";
  const broker = new EgressBroker({
    token,
    channels: { embedding: opts.embedding, caption: opts.caption },
    isUpstreamAllowed: opts.isUpstreamAllowed ?? (() => true),
    upstreamFetch: opts.upstreamFetch,
    logEvent: opts.logEvent,
  });
  brokers.push(broker);
  const info = await broker.start();
  return { broker, baseUrl: info.baseUrl, token };
}

afterEach(async () => {
  while (brokers.length) {
    const b = brokers.pop();
    await b?.stop();
  }
});

const openaiEmbedChannel = (apiKey = REAL_HOST_KEY): EgressChannel => async () => ({
  upstreamBaseUrl: "https://api.openai.com/v1",
  apiKey,
  authScheme: "bearer",
});

describe("EgressBroker — token authentication", () => {
  it("relays when the correct egress token is presented", async () => {
    const upstream = makeUpstreamStub();
    const { baseUrl, token } = await startBroker({
      embedding: openaiEmbedChannel(),
      caption: openaiEmbedChannel(),
      upstreamFetch: upstream.fetch,
    });
    const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST",
      headers: { [EGRESS_TOKEN_HEADER]: token, "content-type": "application/json" },
      body: JSON.stringify({ input: ["hi"] }),
    });
    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
  });

  it("returns 403 and does NOT relay when the token is missing (blocks other local processes)", async () => {
    const upstream = makeUpstreamStub();
    const { baseUrl } = await startBroker({
      embedding: openaiEmbedChannel(),
      caption: openaiEmbedChannel(),
      upstreamFetch: upstream.fetch,
    });
    const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST",
      body: JSON.stringify({ input: ["hi"] }),
    });
    expect(res.status).toBe(403);
    // Mutation guard: a broker that skipped auth would have relayed.
    expect(upstream.calls).toHaveLength(0);
  });

  it("returns 403 for a wrong token (rejects wrong-length and same-length tokens; impl uses timingSafeEqual)", async () => {
    const upstream = makeUpstreamStub();
    const { baseUrl } = await startBroker({
      embedding: openaiEmbedChannel(),
      caption: openaiEmbedChannel(),
      token: "the-real-session-token",
      upstreamFetch: upstream.fetch,
    });
    for (const wrong of ["x", "the-real-session-toke", "the-real-session-tokenX", "totally-different"]) {
      const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
        method: "POST",
        headers: { [EGRESS_TOKEN_HEADER]: wrong },
        body: "{}",
      });
      expect(res.status).toBe(403);
    }
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("EgressBroker — host-resolved upstream + auth-scheme rewrite", () => {
  it("strips worker-set auth and injects the real host key (the key never round-trips to the worker)", async () => {
    const upstream = makeUpstreamStub();
    const { baseUrl, token } = await startBroker({
      embedding: openaiEmbedChannel(REAL_HOST_KEY),
      caption: openaiEmbedChannel(REAL_HOST_KEY),
      upstreamFetch: upstream.fetch,
    });
    const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST",
      headers: {
        [EGRESS_TOKEN_HEADER]: token,
        // A compromised worker tries to smuggle its own auth + token onward.
        authorization: "Bearer worker-forged-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: ["hi"] }),
    });
    expect(res.status).toBe(200);
    const call = upstream.calls[0];
    // Real host key injected, worker's forged auth dropped.
    expect(call.headers.Authorization ?? call.headers.authorization).toBe(`Bearer ${REAL_HOST_KEY}`);
    expect(JSON.stringify(call.headers)).not.toContain("worker-forged-key");
    // Token header never forwarded upstream.
    expect(Object.keys(call.headers).map((k) => k.toLowerCase())).not.toContain(EGRESS_TOKEN_HEADER);
    // The real key is NEVER echoed back to the worker in the response body.
    const body = await res.text();
    expect(body).not.toContain(REAL_HOST_KEY);
  });

  it("resolves the upstream HOST host-side — the worker only controls the path remainder", async () => {
    const upstream = makeUpstreamStub();
    const { baseUrl, token } = await startBroker({
      embedding: openaiEmbedChannel(),
      caption: openaiEmbedChannel(),
      upstreamFetch: upstream.fetch,
    });
    // Worker addresses an arbitrary path; it cannot change the host.
    await fetch(`${baseUrl}/egress/embedding/v1/embeddings?model=x`, {
      method: "POST",
      headers: { [EGRESS_TOKEN_HEADER]: token },
      body: "{}",
    });
    const call = upstream.calls[0];
    expect(new URL(call.url).host).toBe("api.openai.com");
    expect(call.url).toBe("https://api.openai.com/v1/v1/embeddings?model=x");
  });

  it("injects the correct auth scheme per channel/provider (Bearer / api-key)", async () => {
    const cases: Array<{ scheme: EgressChannelResolution["authScheme"]; key: string; header: string; value: string }> = [
      { scheme: "bearer", key: REAL_HOST_KEY, header: "Authorization", value: `Bearer ${REAL_HOST_KEY}` },
      { scheme: "api-key", key: REAL_AZURE_KEY, header: "api-key", value: REAL_AZURE_KEY },
    ];
    for (const c of cases) {
      const upstream = makeUpstreamStub();
      const channel: EgressChannel = async () => ({
        upstreamBaseUrl: "https://res.cognitiveservices.azure.com",
        apiKey: c.key,
        authScheme: c.scheme,
      });
      const { baseUrl, token } = await startBroker({
        embedding: channel,
        caption: channel,
        upstreamFetch: upstream.fetch,
      });
      await fetch(`${baseUrl}/egress/caption/computervision/imageanalysis:analyze`, {
        method: "POST",
        headers: { [EGRESS_TOKEN_HEADER]: token },
        body: "imgbytes",
      });
      const call = upstream.calls[0];
      expect(call.headers[c.header]).toBe(c.value);
    }
  });

  it("preserves the P0 plugin-own-key decision — the broker injects exactly the key the channel resolver returns", async () => {
    // Custom untrusted endpoint ⇒ the host channel resolver returns the
    // plugin-own key (NOT the host key). The broker must forward that verbatim.
    const PLUGIN_OWN_KEY = "plugin-own-user-key";
    const upstream = makeUpstreamStub();
    const customChannel: EgressChannel = async () => ({
      upstreamBaseUrl: "https://lmstudio.internal.example/v1",
      apiKey: PLUGIN_OWN_KEY,
      authScheme: "bearer",
    });
    const { baseUrl, token } = await startBroker({
      embedding: customChannel,
      caption: customChannel,
      isUpstreamAllowed: (url) => new URL(url).host === "lmstudio.internal.example",
      upstreamFetch: upstream.fetch,
    });
    await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST",
      headers: { [EGRESS_TOKEN_HEADER]: token },
      body: "{}",
    });
    const call = upstream.calls[0];
    expect(call.headers.Authorization).toBe(`Bearer ${PLUGIN_OWN_KEY}`);
    expect(JSON.stringify(call.headers)).not.toContain(REAL_HOST_KEY);
  });
});

describe("EgressBroker — allow-list gate", () => {
  it("returns 403 and does NOT relay when the resolved upstream is not allow-listed", async () => {
    const upstream = makeUpstreamStub();
    const evilChannel: EgressChannel = async () => ({
      upstreamBaseUrl: "https://evil.attacker.example/v1",
      apiKey: REAL_HOST_KEY,
      authScheme: "bearer",
    });
    const logs: Array<[string, Record<string, unknown>]> = [];
    const { baseUrl, token } = await startBroker({
      embedding: evilChannel,
      caption: evilChannel,
      isUpstreamAllowed: (url) => {
        const h = new URL(url).host;
        return h === "api.openai.com" || h.endsWith(".openai.azure.com");
      },
      upstreamFetch: upstream.fetch,
      logEvent: (_lvl, event, fields) => logs.push([event, fields]),
    });
    const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST",
      headers: { [EGRESS_TOKEN_HEADER]: token },
      body: "{}",
    });
    expect(res.status).toBe(403);
    // Mutation guard: a broker without the gate would have made the call.
    expect(upstream.calls).toHaveLength(0);
    // The refusal is audited and never includes the key.
    const refused = logs.find(([e]) => e === "local_indexer.egress_refused");
    expect(refused).toBeDefined();
    expect(JSON.stringify(logs)).not.toContain(REAL_HOST_KEY);
    const body = await res.text();
    expect(body).not.toContain(REAL_HOST_KEY);
  });

  it("returns 404 for an unknown channel prefix", async () => {
    const upstream = makeUpstreamStub();
    const { baseUrl, token } = await startBroker({
      embedding: openaiEmbedChannel(),
      caption: openaiEmbedChannel(),
      upstreamFetch: upstream.fetch,
    });
    const res = await fetch(`${baseUrl}/egress/reranker/x`, {
      method: "POST",
      headers: { [EGRESS_TOKEN_HEADER]: token },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("EgressBroker — relay correctness + lifecycle", () => {
  it("uses a fresh public lease per request and releases after the buffered relay", async () => {
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
    const { baseUrl, token } = await startBroker({
      embedding: channel, caption: channel, upstreamFetch,
    });
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
        method: "POST", headers: { [EGRESS_TOKEN_HEADER]: token }, body: "{}",
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(i + 1));
    }
    expect(seen).toEqual(["lease-1", "lease-2"]);
  });

  it("maps lease and effect denials to one terminal event without relay", async () => {
    for (const reason of ["audience-not-allowlisted", "lease-unavailable", "effect-boundary-denied"]) {
      const logEvent = vi.fn();
      const upstreamFetch = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
      const channel: EgressChannel = async () => { throw new EgressLeaseDenied(reason); };
      const { baseUrl, token } = await startBroker({
        embedding: channel, caption: channel, upstreamFetch, logEvent,
      });
      const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
        method: "POST", headers: { [EGRESS_TOKEN_HEADER]: token }, body: "{}",
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "egress-denied", reason, terminal: true });
      expect(upstreamFetch).not.toHaveBeenCalled();
      expect(logEvent.mock.calls.filter(([, event]) => event === "indexer.egress.denied")).toHaveLength(1);
    }
  });

  it("maps host rate limiting to 429 with Retry-After", async () => {
    const channel: EgressChannel = async () => {
      throw Object.assign(new Error("limited"), { code: "rate-limited", retryAfterMs: 2400 });
    };
    const { baseUrl, token } = await startBroker({ embedding: channel, caption: channel });
    const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST", headers: { [EGRESS_TOKEN_HEADER]: token }, body: "{}",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3");
  });

  it("releases a revoked lease and returns one terminal denial", async () => {
    const release = vi.fn(async () => {});
    const lease: ApiKeyLease = {
      exposure: "lease", leaseId: "revoked-lease", vendor: "openai",
      release, onClosed: () => () => {},
    };
    const channel: EgressChannel = async () => ({
      upstreamBaseUrl: "https://api.openai.com/v1", lease, authScheme: "bearer",
    });
    const logEvent = vi.fn();
    const upstreamFetch = vi.fn(async () => {
      throw Object.assign(new Error("revoked"), { code: "lease-unavailable" });
    });
    const { baseUrl, token } = await startBroker({ embedding: channel, caption: channel, upstreamFetch, logEvent });
    const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST", headers: { [EGRESS_TOKEN_HEADER]: token }, body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "egress-denied", reason: "lease-unavailable", terminal: true });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls.filter(([, event]) => event === "indexer.egress.denied")).toHaveLength(1);
  });

  it("maps an aborted leased use to terminal 499 and releases it", async () => {
    const release = vi.fn(async () => {});
    const lease: ApiKeyLease = {
      exposure: "lease", leaseId: "aborted-lease", vendor: "openai",
      release, onClosed: () => () => {},
    };
    const channel: EgressChannel = async () => ({
      upstreamBaseUrl: "https://api.openai.com/v1", lease, authScheme: "bearer",
    });
    const upstreamFetch = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const { baseUrl, token } = await startBroker({ embedding: channel, caption: channel, upstreamFetch });
    const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST", headers: { [EGRESS_TOKEN_HEADER]: token }, body: "{}",
    });
    expect(res.status).toBe(499);
    expect(await res.json()).toEqual({ error: "egress-denied", reason: "cancelled", terminal: true });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("relays a large (64-batch) request body and returns the upstream body verbatim", async () => {
    let seenBody: Buffer | undefined;
    const bigResponse = Buffer.from(JSON.stringify({ data: Array.from({ length: 64 }, () => ({ embedding: [0.1, 0.2, 0.3] })) }));
    const upstreamFetch: EgressUpstreamFetch = async (_url, init) => {
      seenBody = init.body;
      return { status: 200, headers: { "content-type": "application/json" }, body: bigResponse };
    };
    const { baseUrl, token } = await startBroker({
      embedding: openaiEmbedChannel(),
      caption: openaiEmbedChannel(),
      upstreamFetch,
    });
    const batch = JSON.stringify({ input: Array.from({ length: 64 }, (_v, i) => `chunk-${i}`) });
    const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST",
      headers: { [EGRESS_TOKEN_HEADER]: token, "content-type": "application/json" },
      body: batch,
    });
    expect(res.status).toBe(200);
    expect(seenBody?.toString()).toBe(batch);
    const parsed = (await res.json()) as { data: unknown[] };
    expect(parsed.data).toHaveLength(64);
  });

  it("maps a transport failure to 502 for bounded worker retry", async () => {
    const upstreamFetch: EgressUpstreamFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { baseUrl, token } = await startBroker({
      embedding: openaiEmbedChannel(),
      caption: openaiEmbedChannel(),
      upstreamFetch,
    });
    const res = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST",
      headers: { [EGRESS_TOKEN_HEADER]: token },
      body: "{}",
    });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(REAL_HOST_KEY);
  });

  it("is listening when start() resolves and refuses connections after stop()", async () => {
    const upstream = makeUpstreamStub();
    const { broker, baseUrl, token } = await startBroker({
      embedding: openaiEmbedChannel(),
      caption: openaiEmbedChannel(),
      upstreamFetch: upstream.fetch,
    });
    // Listening immediately after start().
    const ok = await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST",
      headers: { [EGRESS_TOKEN_HEADER]: token },
      body: "{}",
    });
    expect(ok.status).toBe(200);
    await broker.stop();
    expect(broker.info).toBeNull();
    // After stop the port is closed.
    await expect(
      fetch(`${baseUrl}/egress/embedding/embeddings`, {
        method: "POST",
        headers: { [EGRESS_TOKEN_HEADER]: token },
        body: "{}",
      }),
    ).rejects.toThrow();
  });

  it("rejects construction without a token", () => {
    expect(
      () =>
        new EgressBroker({
          token: "",
          channels: { embedding: openaiEmbedChannel(), caption: openaiEmbedChannel() },
          isUpstreamAllowed: () => true,
        }),
    ).toThrow();
  });
});

describe("EgressBroker — header allow-list (FIX 1 + FIX 3)", () => {
  it("strips accept-encoding from the forwarded request so the upstream never returns gzip", async () => {
    // FIX 1: without stripping accept-encoding the upstream (api.openai.com)
    // returns a gzip body; the broker strips content-encoding from the response
    // so the worker gets compressed bytes with NO encoding header → JSON decode
    // failure → ALL brokered embedding/caption egress silently degrades to BM25.
    // Assert: accept-encoding is absent from the headers the broker forwards.
    const upstream = makeUpstreamStub();
    const { baseUrl, token } = await startBroker({
      embedding: openaiEmbedChannel(),
      caption: openaiEmbedChannel(),
      upstreamFetch: upstream.fetch,
    });
    await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST",
      headers: {
        [EGRESS_TOKEN_HEADER]: token,
        "content-type": "application/json",
        "accept-encoding": "gzip, deflate, br", // worker (or openai SDK) may set this
      },
      body: JSON.stringify({ input: ["hi"] }),
    });
    const call = upstream.calls[0];
    const forwardedKeys = Object.keys(call.headers).map((k) => k.toLowerCase());
    expect(forwardedKeys).not.toContain("accept-encoding");
  });

  it("drops arbitrary worker-injected headers not on the allow-list", async () => {
    // FIX 3: a compromised worker must not be able to inject arbitrary headers
    // (OpenAI-Organization, x-custom-attack-header, etc.) onto the upstream.
    const upstream = makeUpstreamStub();
    const { baseUrl, token } = await startBroker({
      embedding: openaiEmbedChannel(),
      caption: openaiEmbedChannel(),
      upstreamFetch: upstream.fetch,
    });
    await fetch(`${baseUrl}/egress/embedding/embeddings`, {
      method: "POST",
      headers: {
        [EGRESS_TOKEN_HEADER]: token,
        "content-type": "application/json",
        "openai-organization": "worker-injected-org-id",
        "x-custom-attack": "malicious-value",
        "user-agent": "worker-custom-agent",
      },
      body: "{}",
    });
    const call = upstream.calls[0];
    const forwardedKeys = Object.keys(call.headers).map((k) => k.toLowerCase());
    // Allow-listed headers pass through.
    expect(forwardedKeys).toContain("content-type");
    // Non-allow-listed headers are dropped.
    expect(forwardedKeys).not.toContain("openai-organization");
    expect(forwardedKeys).not.toContain("x-custom-attack");
    expect(forwardedKeys).not.toContain("user-agent");
  });
});

// ── Transport selection ──────────────────────────────────────────────────
// The chooser is a pure function precisely so the platform it decides for does
// not have to be the platform the test runs on.
describe("egressBrokerTransportFor", () => {
  it("binds loopback TCP on win32, where listen(path) makes a named pipe rather than a Unix socket", () => {
    expect(egressBrokerTransportFor("win32", "/irrelevant/sockets")).toEqual({
      kind: "tcp",
      host: "127.0.0.1",
      port: 0,
    });
  });

  it("needs no socket directory on win32 (nothing is bound in one there)", () => {
    expect(egressBrokerTransportFor("win32", undefined)).toEqual({
      kind: "tcp",
      host: "127.0.0.1",
      port: 0,
    });
  });

  it("binds a Unix socket in the host-registered directory on darwin and linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(egressBrokerTransportFor(platform, "/plugins/local-indexer/sockets")).toEqual({
        kind: "uds",
        socketPath: "/plugins/local-indexer/sockets/egress.sock",
      });
    }
  });

  it("returns null where a Unix socket is required and no directory was supplied", () => {
    expect(egressBrokerTransportFor("darwin", undefined)).toBeNull();
    expect(egressBrokerTransportFor("linux", "")).toBeNull();
  });
});

describe("egressBrokerWorkerArgs", () => {
  it("names the real bound address and no socket on TCP", () => {
    const info: EgressBrokerInfo = {
      baseUrl: "http://127.0.0.1:51823",
      transport: { kind: "tcp", host: "127.0.0.1", port: 51823 },
      socketPath: null,
    };
    expect(egressBrokerWorkerArgs(info)).toEqual([
      "--egress-broker-url",
      "http://127.0.0.1:51823",
    ]);
  });

  it("names the socket alongside the dummy authority on UDS", () => {
    const info: EgressBrokerInfo = {
      baseUrl: "http://localhost",
      transport: { kind: "uds", socketPath: "/sockets/egress.sock" },
      socketPath: "/sockets/egress.sock",
    };
    expect(egressBrokerWorkerArgs(info)).toEqual([
      "--egress-broker-url",
      "http://localhost",
      "--egress-broker-uds",
      "/sockets/egress.sock",
    ]);
  });
});
