/**
 * EgressBroker — the plugin-side answer to the worker's provider egress
 * (embeddings + image captioning).
 *
 * Threat model
 * ------------
 * The Python worker is UNTRUSTED for credentials. It parses attacker-controlled
 * documents (PDF/PPTX/images) and runs a large transitive dependency tree
 * (openai + httpx2 + …) in-process. A worker holding the real provider key
 * plus free outbound network could (a) exfiltrate the host's shared chat key
 * and (b) call any endpoint. The broker removes both capabilities:
 *
 *   - the worker holds no credential and no token at all;
 *   - the worker cannot NAME an upstream host — the broker resolves the
 *     upstream itself, per logical channel (embedding/caption), from the
 *     host's trusted defaults / SSRF-validated custom endpoint. A worker
 *     request (or a fully compromised one) can only carry
 *     `{ method, path-remainder, allow-listed headers, body }`.
 *
 * Transport: worker stdio control v1. The worker sends one request per
 * provider HTTP call — `egress_embedding` or `egress_caption` — and this
 * broker answers it from `handle.onRequest`. There is no listener, port,
 * socket or token: only this plugin can answer that channel, because only
 * the host-owned pipe reaches the worker.
 *
 * Every answer is HTTP-shaped (`{ status, headers, body }`), refusals
 * included (403 egress-denied, 413, 429 with Retry-After), so the worker's SDK
 * and its failure classification see exactly what they saw when this was an
 * HTTP proxy. Only a malformed request is a JSON-RPC error.
 *
 * For a host key, hostFetch attaches the lease credential inside the host;
 * for a plugin-owned key, the broker supplies the provider header. Neither key
 * reaches the worker.
 */

import type { ApiKeyLease } from "@ave/plugin-contract";

/** The worker-to-plugin methods, one per logical egress channel. */
export const EGRESS_EMBEDDING_METHOD = "egress_embedding";
export const EGRESS_CAPTION_METHOD = "egress_caption";

/** Largest worker control frame (`WORKER_CONTROL_FRAME_BYTES_MAX`), excluding its newline. */
export const WORKER_FRAME_BYTES_MAX = 16 * 1024 * 1024;

/**
 * Largest caption image, in raw bytes, the relay carries: its base64 data URL
 * (4/3 of the raw size, 14.67 MiB at the cap) plus the request around it must
 * fit one 16 MiB frame. The worker refuses a larger image before sending
 * (`worker/stdio_egress.py`, same value); this side refuses a caption request
 * whose body could only hold a larger one.
 */
export const CAPTION_IMAGE_BYTES_MAX = 11 * 1024 * 1024;

/** Room in a caption request for everything that is not the image: prompt, JSON, model. */
export const CAPTION_ENVELOPE_BYTES_MAX = 512 * 1024;

/** Largest caption request body: the cap's base64 length plus the envelope. */
export const CAPTION_REQUEST_BYTES_MAX = Math.ceil(CAPTION_IMAGE_BYTES_MAX / 3) * 4 + CAPTION_ENVELOPE_BYTES_MAX;

/** Room an answer keeps for its own JSON fields and string escaping inside the frame. */
const ANSWER_FRAME_HEADROOM_BYTES = 64 * 1024;

/** Provider auth header schemes the broker can inject host-side. */
export type EgressAuthScheme = "bearer" | "api-key";

/**
 * Host-side resolution for one logical channel, recomputed fresh per request
 * via the channel thunk — never stored on the broker. `apiKey` is present only
 * in plugin-key mode. A host-key request carries a lease instead. The worker
 * has no input into either credential choice.
 */
export interface EgressChannelResolution {
  /** Host-resolved upstream base (trusted default or SSRF-validated custom). */
  upstreamBaseUrl: string;
  /** Real provider key. Empty string ⇒ no credit ⇒ upstream 401 ⇒ BM25-only. */
  apiKey?: string;
  /** The host-owned credential is used only by hostFetch. */
  lease?: ApiKeyLease;
  /** Which auth header to inject for this upstream. */
  authScheme: EgressAuthScheme;
}

/**
 * Thunk resolving a channel binding host-side, fresh per request. Async because
 * the key half of the resolution comes from the host keychain, which the host
 * reads asynchronously.
 */
export type EgressChannel = (signal?: AbortSignal) => Promise<EgressChannelResolution>;

export class EgressLeaseDenied extends Error {
  constructor(readonly reason: string) {
    super("egress denied");
  }
}

export interface EgressUpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** The host-owned upstream transport (hostFetch in production, injectable for tests). */
export type EgressUpstreamFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer; lease?: ApiKeyLease; signal?: AbortSignal },
) => Promise<EgressUpstreamResponse>;

/** What the worker sends: one provider HTTP request, minus its authority and auth. */
export interface EgressRelayRequest {
  method: string;
  /** Path and query below the channel, as the SDK built it (`/embeddings`, `/openai/deployments/…?api-version=…`). */
  path: string;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: "base64";
}

/** What the worker gets back: the upstream's (or the broker's own) HTTP answer. */
export interface EgressRelayAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding?: "base64";
}

export interface EgressBrokerOptions {
  /** Channel resolvers — host-side, fresh per request. */
  channels: { embedding: EgressChannel; caption: EgressChannel };
  /**
   * Defence-in-depth allow-list gate on the host-resolved upstream base. The
   * worker cannot name a host, so this only ever sees host-controlled URLs;
   * it exists so a future channel-resolver bug cannot silently exfiltrate.
   */
  isUpstreamAllowed: (url: string) => boolean;
  /** Upstream transport: the plugin's hostFetch adapter. */
  upstreamFetch: EgressUpstreamFetch;
  /** Host-only audit sink (never secret material). */
  logEvent?: (
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
  /** Upstream request timeout (ms). Default 60s (covers slow vision calls). */
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const ALLOWED_METHODS = new Set(["GET", "POST"]);
const PATH_MAX = 8192;

/**
 * Allow-list of request headers the broker forwards to the upstream.
 * Everything else is dropped — defense-in-depth: a compromised worker cannot
 * inject `OpenAI-Organization`, `accept-encoding` (gzip-confusion attack where
 * the upstream returns a compressed body the worker cannot decode), or any
 * other header onto the authenticated upstream request. Auth headers are added
 * by the broker separately, host-side, after this rewrite.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "openai-beta", // Azure OpenAI feature-flag header (assistants API beta)
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

function joinUpstream(baseUrl: string, remainder: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (!remainder || remainder === "/") return base;
  return `${base}${remainder}`;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function authHeaderFor(scheme: EgressAuthScheme, key: string): [string, string] {
  switch (scheme) {
    case "api-key":
      return ["api-key", key];
    case "bearer":
    default:
      return ["Authorization", `Bearer ${key}`];
  }
}

/** A worker path: absolute, below the channel, and unable to change the authority. */
function isSafeRemainder(path: string): boolean {
  if (path.length === 0 || path.length > PATH_MAX) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  // No whitespace, control characters, backslashes, authority markers or fragments.
  return !/[\s\u0000-\u001f\u007f\\#@]/.test(path);
}

function parseRelayRequest(params: unknown): EgressRelayRequest {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("egress request params must be an object");
  }
  const raw = params as Record<string, unknown>;
  if (typeof raw.method !== "string" || typeof raw.path !== "string") {
    throw new Error("egress request needs a method and a path");
  }
  if (raw.headers !== undefined && (typeof raw.headers !== "object" || raw.headers === null || Array.isArray(raw.headers))) {
    throw new Error("egress request headers must be an object");
  }
  if (raw.body !== undefined && typeof raw.body !== "string") {
    throw new Error("egress request body must be a string");
  }
  if (raw.bodyEncoding !== undefined && raw.bodyEncoding !== "base64") {
    throw new Error("egress request bodyEncoding must be \"base64\" when present");
  }
  return {
    method: raw.method,
    path: raw.path,
    headers: raw.headers as Record<string, string> | undefined,
    body: raw.body as string | undefined,
    bodyEncoding: raw.bodyEncoding as "base64" | undefined,
  };
}

/** The upstream body as the worker receives it: text when it is UTF-8, base64 otherwise. */
function encodeAnswerBody(body: Buffer): { body: string; bodyEncoding?: "base64" } {
  try {
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(body) };
  } catch {
    return { body: body.toString("base64"), bodyEncoding: "base64" };
  }
}

export class EgressBroker {
  private readonly opts: EgressBrokerOptions;
  private readonly timeoutMs: number;

  constructor(opts: EgressBrokerOptions) {
    if (typeof opts.upstreamFetch !== "function") {
      throw new Error("EgressBroker requires the host-mediated upstreamFetch");
    }
    this.opts = opts;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** True for the worker requests this broker answers. */
  static handles(method: string): boolean {
    return method === EGRESS_EMBEDDING_METHOD || method === EGRESS_CAPTION_METHOD;
  }

  /**
   * Answer one worker egress request. Resolves an HTTP-shaped answer for
   * every policy outcome; throws only for a request that is not one.
   */
  async handleWorkerRequest(method: string, params: unknown, signal: AbortSignal): Promise<EgressRelayAnswer> {
    const channelName = method === EGRESS_EMBEDDING_METHOD
      ? "embedding"
      : method === EGRESS_CAPTION_METHOD ? "caption" : null;
    if (channelName === null) {
      throw new Error(`unknown worker request: ${method}`);
    }
    const request = parseRelayRequest(params);
    const startedAt = Date.now();
    const abort = new AbortController();
    const onWorkerAbort = () => abort.abort();
    if (signal.aborted) abort.abort();
    else signal.addEventListener("abort", onWorkerAbort, { once: true });
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    let lease: ApiKeyLease | undefined;
    try {
      const httpMethod = request.method.toUpperCase();
      if (!ALLOWED_METHODS.has(httpMethod)) {
        return this.deny(405, "egress method not allowed");
      }
      if (!isSafeRemainder(request.path)) {
        this.opts.logEvent?.("warn", "local_indexer.egress_refused", { channel: channelName, reason: "invalid path" });
        return this.deny(400, "invalid egress path");
      }

      const body = request.body === undefined
        ? Buffer.alloc(0)
        : request.bodyEncoding === "base64"
          ? Buffer.from(request.body, "base64")
          : Buffer.from(request.body, "utf8");
      if (channelName === "caption" && body.length > CAPTION_REQUEST_BYTES_MAX) {
        // The worker refuses an image over the cap before sending; a body this
        // large means one got through, so say which limit it broke.
        this.opts.logEvent?.("warn", "local_indexer.egress_refused", {
          channel: channelName,
          reason: "caption image over the relay cap",
          bytes: body.length,
        });
        return this.deny(
          413,
          `caption image exceeds the ${CAPTION_IMAGE_BYTES_MAX / (1024 * 1024)} MiB relay cap`,
        );
      }

      // Resolve upstream + key + scheme HOST-SIDE for that channel.
      const resolution = await this.opts.channels[channelName](abort.signal);
      lease = resolution.lease;
      if (lease && resolution.apiKey) throw new EgressLeaseDenied("credential-conflict");
      const upstreamBase = resolution.upstreamBaseUrl;
      if (!upstreamBase) {
        return this.deny(502, "channel upstream not configured");
      }

      // Allow-list gate (defence-in-depth) on the host-resolved base.
      if (!this.opts.isUpstreamAllowed(upstreamBase)) {
        this.opts.logEvent?.("warn", "local_indexer.egress_refused", {
          channel: channelName,
          upstreamHost: originOf(upstreamBase),
          reason: "upstream not allow-listed",
        });
        return this.deny(403, "upstream not allow-listed");
      }

      const upstreamUrl = joinUpstream(upstreamBase, request.path);
      if (originOf(upstreamUrl) !== originOf(upstreamBase)) {
        this.opts.logEvent?.("warn", "local_indexer.egress_refused", { channel: channelName, reason: "path changes the authority" });
        return this.deny(400, "invalid egress path");
      }

      // Rewrite headers: keep the allow-list, inject the real provider auth.
      const headers = this.rewriteRequestHeaders(request.headers ?? {});
      if (resolution.apiKey && !lease) {
        const [name, value] = authHeaderFor(resolution.authScheme, resolution.apiKey);
        headers[name] = value;
      }

      const upstream = await this.opts.upstreamFetch(upstreamUrl, {
        method: httpMethod,
        headers,
        body: body.length > 0 ? body : undefined,
        lease,
        signal: abort.signal,
      });

      const answer: EgressRelayAnswer = {
        status: upstream.status,
        headers: this.rewriteResponseHeaders(upstream.headers),
        ...encodeAnswerBody(upstream.body),
      };
      if (Buffer.byteLength(JSON.stringify(answer), "utf8") > WORKER_FRAME_BYTES_MAX - ANSWER_FRAME_HEADROOM_BYTES) {
        this.opts.logEvent?.("warn", "local_indexer.egress_upstream_error", { code: "response-too-large" });
        return this.deny(502, "upstream response too large for the worker channel");
      }

      // Audit (host-only, no secret material).
      this.opts.logEvent?.("info", "local_indexer.egress_brokered", {
        channel: channelName,
        upstreamHost: originOf(upstreamBase),
        status: upstream.status,
        bytesIn: body.length,
        bytesOut: upstream.body.length,
        latencyMs: Date.now() - startedAt,
      });
      return answer;
    } catch (err) {
      const code = err instanceof EgressLeaseDenied ? err.reason
        : typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
          ? err.code : "";
      if (err instanceof EgressLeaseDenied || [
        "lease-unavailable", "lease-audience-denied", "credential-conflict", "effect-boundary-denied",
      ].includes(code)) {
        this.opts.logEvent?.("warn", "indexer.egress.denied", { reason: code });
        return this.denyStructured(403, code);
      }
      if (code === "rate-limited") {
        const retryAfterMs = typeof err === "object" && err !== null && "retryAfterMs" in err
          && typeof err.retryAfterMs === "number" ? err.retryAfterMs : 1000;
        return this.denyStructured(429, code, {
          "retry-after": String(Math.max(1, Math.ceil(Math.min(5000, retryAfterMs) / 1000))),
        });
      }
      if (abort.signal.aborted || code === "aborted" || (err instanceof Error && err.name === "AbortError")) {
        return this.denyStructured(499, signal.aborted ? "cancelled" : "timeout");
      }
      this.opts.logEvent?.("warn", "local_indexer.egress_upstream_error", { code: "transport-failure" });
      return this.deny(502, "upstream request failed");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onWorkerAbort);
      if (lease) {
        try {
          await lease.release();
        } catch (err) {
          this.opts.logEvent?.("warn", "indexer.egress.lease_release_failed", {
            reason: err instanceof Error ? err.name : "unknown",
          });
        }
      }
    }
  }

  private denyStructured(status: number, reason: string, extra: Record<string, string> = {}): EgressRelayAnswer {
    return {
      status,
      headers: { "content-type": "application/json", ...extra },
      body: JSON.stringify({ error: "egress-denied", reason, terminal: status === 403 || status === 499 }),
    };
  }

  private deny(status: number, message: string): EgressRelayAnswer {
    return {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: message }),
    };
  }

  private rewriteRequestHeaders(incoming: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (typeof value !== "string") continue;
      if (FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) {
        out[key.toLowerCase()] = value;
      }
    }
    return out;
  }

  private rewriteResponseHeaders(incoming: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
      out[key] = value;
    }
    return out;
  }
}
