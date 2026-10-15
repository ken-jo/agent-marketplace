/**
 * EgressBroker — host-mediated reverse proxy for the Python worker's provider
 * egress (embeddings + image captioning).
 *
 * Threat model
 * ------------
 * The Python worker is UNTRUSTED for credentials. It parses attacker-controlled
 * documents (PDF/PPTX/images) and runs a large transitive dependency tree
 * (openai + httpx + …) in-process. A worker holding the real provider key plus
 * free outbound network can (a) exfiltrate the host's shared chat key and
 * (b) call any endpoint. The broker removes both capabilities:
 *
 *   - the worker holds only a per-session BROKER TOKEN, never the provider key;
 *   - the worker cannot NAME an upstream host — the broker resolves the upstream
 *     host-side, per logical channel (embedding/caption), from the host's own
 *     trusted defaults / SSRF-validated custom endpoint. A worker-supplied (or
 *     fully compromised) request can only carry `{ path-remainder, body }`.
 *
 * The broker terminates worker→broker as plain loopback HTTP. For a host key,
 * hostFetch attaches the lease credential inside the host; for a plugin-owned
 * key, the broker supplies the provider header. Neither key reaches the worker.
 *
 * Two transports, one policy: a bind-mounted Unix-domain socket where a
 * confined child cannot bind loopback, loopback TCP on an ephemeral port where
 * `listen(path)` is not a Unix socket. `egressBrokerTransportFor` is where that
 * is decided; the token check below is transport-independent, so neither
 * address is reachable without it.
 *
 * This module is intentionally a clean, self-contained interface owned by the
 * plugin adapter so it can later be lifted into ave as a host capability
 * (and unified with `hostApi.hostFetch`) without a rewrite.
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"; // egress-gate: allow — EgressBroker IS the host-mediated egress chokepoint (the loopback listener that replaces the worker's direct provider egress); this is the legitimate single egress point, the Tier-A analog for the worker process
import { Agent as HttpsAgent, request as httpsRequest } from "node:https"; // egress-gate: allow — broker upstream client: the one allow-listed provider TLS egress point, replacing per-worker direct egress
import type { ApiKeyLease } from "@ave/plugin-contract";

/** Per-channel URL prefixes the worker addresses; the broker routes by these. */
export const EGRESS_EMBEDDING_PATH = "/egress/embedding";
export const EGRESS_CAPTION_PATH = "/egress/caption";

/** Dedicated header carrying the per-session broker token (NOT the provider key). */
export const EGRESS_TOKEN_HEADER = "x-ave-egress-token";

/** Provider auth header schemes the broker can inject host-side. */
export type EgressAuthScheme = "bearer" | "api-key";

/**
 * Host-side resolution for one logical channel, recomputed fresh per request
 * via the channel thunk — never stored on the broker. `upstreamBaseUrl` and
 * `apiKey` is present only in plugin-key mode. A host-key request carries a
 * lease instead. The worker has no input into either credential choice.
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

/** Pluggable upstream transport (injectable for tests). */
export type EgressUpstreamFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer; lease?: ApiKeyLease; signal?: AbortSignal },
) => Promise<EgressUpstreamResponse>;

export type EgressTransport =
  | { kind: "tcp"; host?: string; port?: number }
  | { kind: "uds"; socketPath: string };

/** File name of the Unix socket, inside the directory the host registered. */
const UDS_FILE_NAME = "egress.sock";

/**
 * How the broker binds, decided once, from the platform.
 *
 * On darwin and linux: a Unix-domain socket in `socketDir`, the one directory
 * the host registers with the sandbox for this purpose (a socket in the
 * plugin's writable data dir is refused — creating a SOCKET is a separate,
 * directory-scoped allow). Loopback TCP is not available to a confined plugin
 * child there: macOS refuses the bind outright, and Linux binds it into a
 * network namespace the worker is not in, which is worse because the failure
 * then surfaces at the worker's first request rather than at the bind.
 *
 * On win32: loopback TCP on an ephemeral port. `server.listen({ path })` there
 * is not AF_UNIX at all — libuv creates a NAMED PIPE, whose address has to live
 * under `\\.\pipe\`, so a filesystem path is refused by `CreateNamedPipeW` and
 * arrives as EACCES with no socket file left behind. A pipe is not usable as
 * the address either way: the worker reaches the broker through httpx, which
 * can pin its transport to a Unix socket but not to a Windows pipe. Loopback is
 * bindable there because the Windows confinement is a filesystem one and puts
 * the child in no network namespace, and the per-session token — checked on
 * every request in `handle()` before any routing — is what keeps the port from
 * being an opening for other local processes.
 *
 * Returns null when the platform binds a Unix socket and no directory to bind
 * it in was supplied; the caller decides what a missing directory means.
 */
export function egressBrokerTransportFor(
  platform: NodeJS.Platform,
  socketDir: string | undefined,
): EgressTransport | null {
  if (platform === "win32") return { kind: "tcp", host: "127.0.0.1", port: 0 };
  if (!socketDir) return null;
  return { kind: "uds", socketPath: resolve(socketDir, UDS_FILE_NAME) };
}

export interface EgressBrokerOptions {
  /** Per-session token the worker must present (constant-time compared). */
  token: string;
  /** Channel resolvers — host-side, fresh per request. */
  channels: { embedding: EgressChannel; caption: EgressChannel };
  /**
   * Defence-in-depth allow-list gate on the host-resolved upstream base. The
   * worker cannot name a host, so this only ever sees host-controlled URLs;
   * it exists so a future channel-resolver bug cannot silently exfiltrate.
   */
  isUpstreamAllowed: (url: string) => boolean;
  /** Transport binding. Default: loopback TCP ephemeral (127.0.0.1:0). */
  transport?: EgressTransport;
  /** Upstream transport override (tests). Default: the Node https/http client. */
  upstreamFetch?: EgressUpstreamFetch;
  /** Corporate CA PEM path for provider TLS (the broker terminates it now). */
  upstreamCaPath?: string | null;
  /** Host-only audit sink (never secret material). */
  logEvent?: (
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
  /** Upstream request timeout (ms). Default 60s (covers slow vision calls). */
  requestTimeoutMs?: number;
  /** Max relayed body size (request and response). Default 25 MiB. */
  maxBodyBytes?: number;
}

export interface EgressBrokerInfo {
  /** Loopback base URL the worker addresses (TCP). For UDS, the dummy authority. */
  baseUrl: string;
  transport: EgressTransport;
  /** Resolved socket path when transport is UDS, else null. */
  socketPath: string | null;
}

/**
 * The worker's boot arguments naming how to reach the broker, derived from what
 * the broker actually bound so the two can never disagree.
 *
 * Over a Unix socket the URL is only the authority the provider SDKs insist on
 * parsing (`http://localhost`, which nothing dials) and the socket path is what
 * decides where the bytes go. Over loopback TCP the URL is the real bound
 * address and there is no socket to name.
 */
export function egressBrokerWorkerArgs(info: EgressBrokerInfo): string[] {
  const args = ["--egress-broker-url", info.baseUrl];
  if (info.socketPath !== null) args.push("--egress-broker-uds", info.socketPath);
  return args;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY = 25 * 1024 * 1024;
const UDS_DUMMY_AUTHORITY = "http://localhost";

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

/** Constant-time token comparison that tolerates length mismatch safely. */
function tokensMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) {
    // Still run a compare against a same-length buffer to avoid leaking the
    // length distinction via early return timing.
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

function joinUpstream(baseUrl: string, remainder: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (!remainder) return base;
  return `${base}${remainder.startsWith("/") ? "" : "/"}${remainder}`;
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

export class EgressBroker {
  private readonly opts: EgressBrokerOptions;
  private readonly upstreamFetch: EgressUpstreamFetch;
  private readonly maxBodyBytes: number;
  private readonly timeoutMs: number;
  private server: Server | null = null;
  private boundInfo: EgressBrokerInfo | null = null;

  constructor(opts: EgressBrokerOptions) {
    if (!opts.token) {
      throw new Error("EgressBroker requires a non-empty session token");
    }
    this.opts = opts;
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.upstreamFetch = opts.upstreamFetch ?? this.defaultUpstreamFetch.bind(this);
  }

  get info(): EgressBrokerInfo | null {
    return this.boundInfo;
  }

  /** Bind the listener. Resolves only once the broker is actually listening. */
  async start(): Promise<EgressBrokerInfo> {
    if (this.boundInfo) return this.boundInfo;
    const transport: EgressTransport = this.opts.transport ?? { kind: "tcp" };
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        rejectPromise(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      if (transport.kind === "uds") {
        // A socket file outlives the process that bound it, so a run that died
        // without cleanup leaves one and `listen()` on the same path fails
        // EADDRINUSE — which reads as "another broker is already running" when
        // what is actually there is a dead file. Removed immediately before the
        // bind, because the plugin owns what it creates in this directory.
        try {
          unlinkSync(transport.socketPath);
        } catch {
          // Nothing there, which is the normal case.
        }
        server.listen({ path: transport.socketPath });
      } else {
        server.listen({ host: transport.host ?? "127.0.0.1", port: transport.port ?? 0 });
      }
    });

    if (transport.kind === "uds") {
      this.boundInfo = {
        baseUrl: UDS_DUMMY_AUTHORITY,
        transport,
        socketPath: transport.socketPath,
      };
    } else {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        await this.stop();
        throw new Error("EgressBroker failed to resolve a TCP address");
      }
      const host = transport.host ?? "127.0.0.1";
      this.boundInfo = {
        baseUrl: `http://${host}:${addr.port}`,
        transport: { kind: "tcp", host, port: addr.port },
        socketPath: null,
      };
    }
    return this.boundInfo;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const socketPath = this.boundInfo?.socketPath ?? null;
    this.server = null;
    this.boundInfo = null;
    if (!server) return;
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
    // `close()` stops accepting; it does not remove the file. Left behind, it
    // becomes what the next `start()` has to unlink — so a clean stop removes
    // it and that unlink stays the CRASH path rather than the normal one.
    if (socketPath !== null) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Already gone, which is the outcome this wanted anyway.
      }
    }
  }

  // ── request handling ──────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    let lease: ApiKeyLease | undefined;
    try {
      // 1. Authenticate the worker (constant-time). Blocks any other local
      //    process that happens to find the loopback port.
      const presented = headerValue(req.headers[EGRESS_TOKEN_HEADER]);
      if (!presented || !tokensMatch(this.opts.token, presented)) {
        return this.deny(res, 403, "missing or invalid egress token");
      }

      // 2. Identify the channel from the path prefix; the worker supplies only
      //    the remainder + body — never the upstream host.
      const rawUrl = req.url ?? "/";
      const channelMatch = this.matchChannel(rawUrl);
      if (!channelMatch) {
        return this.deny(res, 404, "unknown egress channel");
      }
      const { channelName, channel, remainder } = channelMatch;

      // 3. Resolve upstream + key + scheme HOST-SIDE for that channel.
      const resolution = await channel(abort.signal);
      lease = resolution.lease;
      if (lease && resolution.apiKey) throw new EgressLeaseDenied("credential-conflict");
      const upstreamBase = resolution.upstreamBaseUrl;
      if (!upstreamBase) {
        return this.deny(res, 502, "channel upstream not configured");
      }

      // 4. Allow-list gate (defence-in-depth) on the host-resolved base.
      if (!this.opts.isUpstreamAllowed(upstreamBase)) {
        this.opts.logEvent?.("warn", "local_indexer.egress_refused", {
          channel: channelName,
          upstreamHost: originOf(upstreamBase),
          reason: "upstream not allow-listed",
        });
        return this.deny(res, 403, "upstream not allow-listed");
      }

      const body = await this.readBody(req);
      if (body === null) {
        return this.deny(res, 413, "request body too large");
      }

      // 5. Rewrite headers: drop worker auth + token, inject the real provider
      //    auth for this channel's scheme.
      const upstreamUrl = joinUpstream(upstreamBase, remainder);
      const headers = this.rewriteRequestHeaders(req.headers);
      if (resolution.apiKey && !lease) {
        const [name, value] = authHeaderFor(resolution.authScheme, resolution.apiKey);
        headers[name] = value;
      }

      // 6. Relay (buffered, non-streaming). All worker egress is single POSTs.
      let upstream: EgressUpstreamResponse;
      try {
        upstream = await this.upstreamFetch(upstreamUrl, {
          method: (req.method ?? "GET").toUpperCase(),
          headers,
          body: body.length > 0 ? body : undefined,
          lease,
          signal: abort.signal,
        });
      } catch (err) {
        throw err;
      }

      // 7. Return upstream status + body verbatim.
      const respHeaders = this.rewriteResponseHeaders(upstream.headers);
      res.writeHead(upstream.status, respHeaders);
      res.end(upstream.body);

      // 8. Audit (host-only, no secret material).
      this.opts.logEvent?.("info", "local_indexer.egress_brokered", {
        channel: channelName,
        upstreamHost: originOf(upstreamBase),
        status: upstream.status,
        bytesIn: body.length,
        bytesOut: upstream.body.length,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err) {
      const code = err instanceof EgressLeaseDenied ? err.reason
        : typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
          ? err.code : "";
      if (err instanceof EgressLeaseDenied || [
        "lease-unavailable", "lease-audience-denied", "credential-conflict", "effect-boundary-denied",
      ].includes(code)) {
        this.opts.logEvent?.("warn", "indexer.egress.denied", { reason: code });
        return this.denyStructured(res, 403, code);
      }
      if (code === "rate-limited") {
        const retryAfterMs = typeof err === "object" && err !== null && "retryAfterMs" in err
          && typeof err.retryAfterMs === "number" ? err.retryAfterMs : 1000;
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil(Math.min(5000, retryAfterMs) / 1000))));
        return this.denyStructured(res, 429, code);
      }
      if (abort.signal.aborted || code === "aborted" || (err instanceof Error && err.name === "AbortError")) {
        return this.denyStructured(res, 499, "cancelled");
      }
      this.opts.logEvent?.("warn", "local_indexer.egress_upstream_error", { code: "transport-failure" });
      return this.deny(res, 502, "upstream request failed");
    } finally {
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

  private denyStructured(res: ServerResponse, status: number, reason: string): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "egress-denied", reason, terminal: status === 403 || status === 499 }));
  }

  private matchChannel(
    rawUrl: string,
  ): { channelName: "embedding" | "caption"; channel: EgressChannel; remainder: string } | null {
    for (const [name, prefix, channel] of [
      ["embedding", EGRESS_EMBEDDING_PATH, this.opts.channels.embedding],
      ["caption", EGRESS_CAPTION_PATH, this.opts.channels.caption],
    ] as const) {
      if (rawUrl === prefix || rawUrl.startsWith(`${prefix}/`) || rawUrl.startsWith(`${prefix}?`)) {
        const remainder = rawUrl.slice(prefix.length) || "/";
        return { channelName: name, channel, remainder };
      }
    }
    return null;
  }

  private rewriteRequestHeaders(
    incoming: IncomingMessage["headers"],
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (value === undefined) continue;
      if (FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) {
        out[key] = Array.isArray(value) ? value.join(", ") : String(value);
      }
    }
    return out;
  }

  private rewriteResponseHeaders(
    incoming: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
      out[key] = value;
    }
    return out;
  }

  private readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;
      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          aborted = true;
          resolvePromise(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!aborted) resolvePromise(Buffer.concat(chunks));
      });
      req.on("error", (err) => {
        if (!aborted) rejectPromise(err);
      });
    });
  }

  private deny(res: ServerResponse, status: number, message: string): void {
    const body = JSON.stringify({ error: message });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  }

  // ── default upstream transport (Node https/http client) ────────────────

  private defaultUpstreamFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: Buffer; lease?: ApiKeyLease },
  ): Promise<EgressUpstreamResponse> {
    if (init.lease) throw new Error("host lease requires mediated upstream fetch");
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;

    // Corporate-CA trust lives on the BROKER's upstream client now (the broker
    // terminates provider TLS). This mirrors the established optional-corp-CA
    // behaviour the worker had (`localIndexerPlugin.ts`: SSL_CERT_FILE is set
    // only when `~/.ave/certs/corp-ca.pem` exists). The plugin passes
    // `upstreamCaPath` only when that PEM exists, so a present-but-unreadable
    // file is a genuine fault and is allowed to surface (the request 502s)
    // rather than being silently downgraded to a different trust store.
    let agent: HttpsAgent | undefined;
    if (isHttps && this.opts.upstreamCaPath) {
      agent = new HttpsAgent({ ca: readFileSync(this.opts.upstreamCaPath) });
    }

    // The Node https/http client does NOT auto-follow 3xx redirects. A Location
    // response from the upstream never causes the broker to re-issue the
    // authenticated request, so a rogue upstream cannot steal the injected
    // provider key by redirecting to an attacker-controlled host.
    return new Promise<EgressUpstreamResponse>((resolvePromise, rejectPromise) => {
      const upstreamReq = requestFn(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: init.method,
          headers: init.headers,
          agent,
          timeout: this.timeoutMs,
        },
        (upstreamRes) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let overflowed = false;
          upstreamRes.on("data", (chunk: Buffer) => {
            if (overflowed) return;
            total += chunk.length;
            if (total > this.maxBodyBytes) {
              overflowed = true;
              upstreamRes.destroy();
              rejectPromise(new Error("upstream response too large"));
              return;
            }
            chunks.push(chunk);
          });
          upstreamRes.on("end", () => {
            if (overflowed) return;
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(upstreamRes.headers)) {
              if (value === undefined) continue;
              headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
            }
            resolvePromise({
              status: upstreamRes.statusCode ?? 502,
              headers,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      upstreamReq.on("error", rejectPromise);
      upstreamReq.on("timeout", () => {
        upstreamReq.destroy(new Error("upstream request timeout"));
      });
      if (init.body) upstreamReq.write(init.body);
      upstreamReq.end();
    });
  }
}

function headerValue(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? (value[0] ?? "") : value;
}
