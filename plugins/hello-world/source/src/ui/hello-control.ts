/**
 * Sidebar panel: the renderer imports this module, takes its default export
 * and calls it with the node to paint into and a bridge for calling this
 * plugin's tools. It returns the function that removes what it painted.
 */
interface MountArgs {
  root: HTMLElement;
  bridge: { callTool(name: string, args: Record<string, unknown>): Promise<unknown> };
}

export default function mount({ root, bridge }: MountArgs): () => void {
  root.innerHTML = "";
  const doc = root.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.style.cssText = "padding:16px;display:flex;flex-direction:column;gap:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;";
  const title = doc.createElement("h2");
  title.textContent = "Hello World";
  title.style.cssText = "margin:0;font-size:18px;font-weight:600;";
  const input = doc.createElement("input");
  input.placeholder = "이름 입력 (기본: World)";
  input.style.cssText = "padding:8px 10px;border:1px solid #3a3a44;border-radius:6px;background:#111;color:#e4e4e8;font-size:14px;";
  const button = doc.createElement("button");
  button.textContent = "hello_world 호출";
  button.style.cssText = "padding:8px 14px;background:#6a6aff;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:14px;";
  const out = doc.createElement("pre");
  out.style.cssText = "margin:0;padding:10px;border-radius:6px;background:#0c0c11;color:#a9f59c;font-size:13px;white-space:pre-wrap;word-break:break-all;";
  out.textContent = "대기 중…";
  button.onclick = async () => {
    out.textContent = "호출 중…";
    try {
      const result = await bridge.callTool("hello_world", input.value ? { name: input.value } : {});
      out.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      out.textContent = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  wrap.append(title, input, button, out);
  root.append(wrap);
  return () => {
    root.innerHTML = "";
  };
}
