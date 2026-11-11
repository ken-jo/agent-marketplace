import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => {
  const context: Record<string, unknown> = { theme: "dark" };
  return {
    context,
    app: {
      connect: async () => {},
      getHostContext: () => context,
      onhostcontextchanged: undefined as undefined | ((delta: unknown) => void),
      close: async () => {},
    },
  };
});
vi.mock("@modelcontextprotocol/ext-apps", () => ({ App: class { constructor() { return state.app; } } }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("hello reference view host context", () => {
  it.each([{ locale: "ko" }, { styles: { variables: { "--color-text-primary": "white" } } }])("keeps dark mode when a partial update omits theme: %j", async delta => {
    const style = { colorScheme: "", setProperty: vi.fn() };
    const nodes: Record<string, unknown> = { pre: { textContent: "" }, button: { disabled: true }, input: { value: "" } };
    vi.stubGlobal("document", { documentElement: { style }, getElementById: () => ({ innerHTML: "", querySelector: (name: string) => nodes[name] }) });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    await import("../src/ui/hello-control");
    expect(style.colorScheme).toBe("dark");
    Object.assign(state.context, delta);
    state.app.onhostcontextchanged?.(delta);
    expect(style.colorScheme).toBe("dark");
  });
});
