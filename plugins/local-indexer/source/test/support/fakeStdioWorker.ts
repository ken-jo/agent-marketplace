/**
 * A fake `StdioControlPluginWorker` handle for the plugin's tests.
 *
 * It behaves the way the host's handle is documented to: `request` resolves
 * with a scripted answer or rejects with a `WorkerControlError`, a second
 * `onRequest` registration throws, and when the incarnation ends every
 * pending call rejects with `worker-incarnation-ended` and `onExit` fires once.
 */
import {
  WorkerControlError,
  type PluginWorkerExitInfo,
  type PluginWorkerExitReason,
  type PluginWorkerSpec,
  type StdioControlPluginWorker,
  type WorkerControlRequestHandler,
  type WorkerControlRequestOptions,
} from "@ave/plugin-contract";

export type Responder = (params: unknown) => unknown;

/** A worker refusal, as the host reports a JSON-RPC error answer. */
export function workerRefusal(message: string, code = -32000): WorkerControlError {
  return new WorkerControlError("worker-request-failed", `worker answered ${code}`, { code, message });
}

export interface RecordedRequest {
  method: string;
  params: unknown;
  options?: WorkerControlRequestOptions;
}

export class FakeStdioWorker implements StdioControlPluginWorker {
  readonly control = "stdio-control-v1" as const;
  readonly pid: number | undefined;
  readonly requests: RecordedRequest[] = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  stopCalls = 0;
  ended = false;
  requestHandler: WorkerControlRequestHandler | null = null;

  private readonly responders = new Map<string, Responder>();
  private readonly stderrListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(info: PluginWorkerExitInfo) => void> = [];
  private readonly notificationListeners: Array<(method: string, params: unknown) => void> = [];
  private readonly pending = new Set<(err: Error) => void>();

  constructor(responders: Record<string, Responder> = {}, pid = 4242) {
    this.pid = pid;
    for (const [method, responder] of Object.entries(responders)) this.responders.set(method, responder);
  }

  /** Script (or re-script) the answer to one worker method. */
  respond(method: string, responder: Responder): this {
    this.responders.set(method, responder);
    return this;
  }

  callsOf(method: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method);
  }

  request(method: string, params?: unknown, options?: WorkerControlRequestOptions): Promise<unknown> {
    this.requests.push({ method, params, options });
    if (this.ended) {
      return Promise.reject(new WorkerControlError("worker-incarnation-ended", "the worker stopped"));
    }
    const responder = this.responders.get(method);
    if (!responder) {
      return Promise.reject(workerRefusal(`no method ${method}`, -32601));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const settle = (err: Error) => rejectPromise(err);
      this.pending.add(settle);
      const signal = options?.signal;
      const onAbort = () => {
        this.pending.delete(settle);
        rejectPromise(new WorkerControlError("worker-request-cancelled", "cancelled"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => responder(params))
        .then(
          (value) => {
            signal?.removeEventListener("abort", onAbort);
            if (this.pending.delete(settle)) resolvePromise(value);
          },
          (err) => {
            signal?.removeEventListener("abort", onAbort);
            if (this.pending.delete(settle)) rejectPromise(err);
          },
        );
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.ended) throw new WorkerControlError("worker-incarnation-ended", "the worker stopped");
    this.notifications.push({ method, params });
  }

  onRequest(handler: WorkerControlRequestHandler): void {
    if (this.requestHandler) throw new Error("onRequest: a handler is already registered");
    this.requestHandler = handler;
  }

  onNotification(listener: (method: string, params: unknown) => void): void {
    this.notificationListeners.push(listener);
  }

  onStderr(listener: (chunk: string) => void): void {
    this.stderrListeners.push(listener);
  }

  onExit(listener: (info: PluginWorkerExitInfo) => void): void {
    this.exitListeners.push(listener);
  }

  stop(): void {
    this.stopCalls += 1;
    this.end("stopped", null);
  }

  emitStderr(chunk: string): void {
    for (const listener of this.stderrListeners) listener(chunk);
  }

  /** The worker asks the plugin something, as the host relays it. */
  async askPlugin(method: string, params: unknown, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
    if (!this.requestHandler) throw new Error("the plugin registered no request handler");
    return this.requestHandler(method, params, signal);
  }

  /** End the incarnation: pending calls reject, onExit fires once. */
  end(reason: PluginWorkerExitReason = "exited", code: number | null = 1): void {
    if (this.ended) return;
    this.ended = true;
    for (const reject of this.pending) reject(new WorkerControlError("worker-incarnation-ended", "the worker stopped"));
    this.pending.clear();
    for (const listener of this.exitListeners) listener({ code, signal: null, reason });
  }
}

/** Default answers for a worker that started cleanly with an empty index. */
export function readyWorker(overrides: Record<string, Responder> = {}, info: Record<string, unknown> = {}): FakeStdioWorker {
  return new FakeStdioWorker({
    worker_health: () => ({ status: "ok", uptime_s: 1 }),
    runtime_info: () => ({
      index_root: "/state/workers/local-indexer-worker/index",
      state_dir: "/state/workers/local-indexer-worker",
      sqlite_path: "/state/workers/local-indexer-worker/index/fts5.sqlite",
      lance_path: "/state/workers/local-indexer-worker/index/vectors.lance",
      workspace: "/data/.local-indexer-workspace",
      document_count: 0,
      ...info,
    }),
    worker_shutdown: () => ({ bye: true }),
    ...overrides,
  });
}

/** A `spawnWorker` that hands out the given handles in order and records each spec. */
export function spawnSequence(...handles: StdioControlPluginWorker[]): {
  spawnWorker: (spec: PluginWorkerSpec) => Promise<StdioControlPluginWorker>;
  specs: PluginWorkerSpec[];
} {
  const specs: PluginWorkerSpec[] = [];
  const queue = [...handles];
  return {
    specs,
    spawnWorker: async (spec) => {
      specs.push(spec);
      const next = queue.shift();
      if (!next) throw new Error("spawnSequence: no more worker handles");
      return next;
    },
  };
}
