import { App } from '@modelcontextprotocol/ext-apps';

export async function connectView(name) {
  const app = new App({ name, version: __MEETING_APP_VERSION__ }, {}, { autoResize: false });
  await app.connect();
  const callTool = async (name, args = {}, options) => {
    const result = await app.callServerTool({ name, arguments: args }, options);
    if (result.isError) throw new Error('요청이 거부되었거나 실패했습니다.');
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result.content?.find(item => item.type === 'text')?.text;
    if (text === undefined) return null;
    try { return JSON.parse(text); } catch { return text; }
  };
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("pagehide", dispose);
    void app.close().catch(() => {});
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return {
    app, callTool,
    config: {
      get: async key => (await callTool('meeting_view_state')).config[key],
      set: (key, value) => callTool('meeting_set_prompt', { key, value }),
    },
    dispose,
  };
}

export function applyHostContext(app, target) {
  let painted = new Set();
  const paint = ctx => {
    const variables = ctx?.styles?.variables ?? {};
    for (const key of painted) if (!(key in variables)) target.style.removeProperty(key);
    painted = new Set(Object.keys(variables));
    target.style.colorScheme = ctx?.theme ?? 'light';
    for (const [key, value] of Object.entries(ctx?.styles?.variables ?? {})) {
      if (typeof value === 'string') target.style.setProperty(key, value);
    }
  };
  paint(app.getHostContext());
  app.onhostcontextchanged = () => paint(app.getHostContext());
}

/** One bounded outstanding request per view. Stop retries on unmount. */
export function watchChanges(client, refresh, onError = () => {}) {
  const controller = new AbortController();
  let stopped = false;
  const run = async () => {
    let cursor = '';
    while (!stopped) {
      try {
        const result = await client.callTool('meeting_wait_changes', { cursor, waitMs: 10000 }, { signal: controller.signal });
        if (stopped || result.closed) break;
        if (typeof result.cursor !== "string" || !Array.isArray(result.changes)) throw new Error("Invalid meeting change response");
        if (result.reset || result.changes.length) await refresh(result);
        cursor = result.cursor;
      } catch {
        if (!stopped) onError();
        if (!stopped) await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  };
  void run();
  const stop = () => { stopped = true; controller.abort(); window.removeEventListener("pagehide", stop); };
  window.addEventListener('pagehide', stop, { once: true });
  return stop;
}
