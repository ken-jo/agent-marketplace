import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "hello-world", version: "0.4.0" });
const root = document.getElementById("app")!;
root.innerHTML = `<style>
body { background:var(--color-background-primary,#fff); color:var(--color-text-primary,#222); font-family:var(--font-sans,sans-serif); padding:16px; }
form { display:grid; gap:12px; } input,button { padding:8px; font:inherit; } pre { white-space:pre-wrap; }
</style><h2>Hello World</h2><form><label>Name <input name="name" placeholder="World"></label><button disabled>Call hello_world</button></form><pre role="status">Connecting…</pre>`;
const output = root.querySelector("pre")!;
const button = root.querySelector("button")!;
const applyContext = (context: ReturnType<typeof app.getHostContext>) => {
  for (const [key, value] of Object.entries(context?.styles?.variables ?? {})) {
    if (value !== undefined) document.documentElement.style.setProperty(key, value);
  }
  document.documentElement.style.colorScheme = context?.theme ?? "light dark";
};
app.onhostcontextchanged = applyContext;
root.querySelector("form")!.onsubmit = async event => {
  event.preventDefault();
  button.disabled = true;
  try {
    const name = root.querySelector("input")!.value;
    const result = await app.callServerTool({ name: "hello_world", arguments: name ? { name } : {} });
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally { button.disabled = false; }
};
window.addEventListener("pagehide", () => { void app.close(); }, { once: true });
try {
  await app.connect();
  applyContext(app.getHostContext());
  button.disabled = false;
  output.textContent = "Ready";
} catch (error) { output.textContent = `Connection failed: ${String(error)}`; }
