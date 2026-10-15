/**
 * Theme is the HOST's, and this plugin does not carry it.
 *
 * The rule has not changed — theme propagation must never become plugin
 * surface — but what satisfies it has. This plugin used to subscribe to
 * `host.theme.changed`, validate the payload, and push it to its own detached
 * recorder window over a private IPC channel. It had to: the window was the
 * plugin's, so nobody else could paint it.
 *
 * The window is the host's now, and the recorder card is served by the same
 * plugin UI shell a sidebar card gets — a shell that already primes and
 * subscribes theme. Relaying as well would give the card two sources for one
 * value, and the stale one would be this plugin's.
 *
 * So the assertions below are about ABSENCE, and absence is easy to satisfy by
 * accident: a plugin that lost theme support entirely passes every one of
 * them. The positive half lives in `recorderCardThemeTarget.test.ts`, which
 * requires the card to actually prime — against its own shell, because it
 * shares a document with the dock and with other plugins' slots.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import createPlugin from "../src/hostPlugin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_PLUGIN_SRC = readFileSync(join(__dirname, "..", "src", "hostPlugin.ts"), "utf8");

type EventHandler = (data: unknown) => void;

function makeContext() {
  const root = mkdtempSync(join(tmpdir(), "ave-meeting-test-theme-"));
  const events = new Map<string, EventHandler>();
  mkdirSync(join(root, "sessions"), { recursive: true });

  return {
    events,
    context: {
      pluginId: "meeting",
      pluginRoot: root,
      hostRoot: root,
      pluginDataDir: root,
      log: (_msg: string) => { /* no-op */ },
      hostApi: {
        emitEvent: (_type: string, _data?: unknown) => { /* no-op */ },
        onEvent: (type: string, handler: EventHandler) => {
          events.set(type, handler);
          return () => events.delete(type);
        },
        getSecret: (_key: string): string | null => null,
        logEvent: vi.fn(),
        onShutdown: (_h: () => void | Promise<void>) => { /* no-op */ },
      },
    },
  };
}

describe("theme stays host-owned", () => {
  it("keeps theme propagation off the plugin tool surface", async () => {
    const { context } = makeContext();
    const plugin = await createPlugin(context);

    expect(plugin.handlers).not.toHaveProperty("meeting_propagate_theme");
    expect(plugin.handlers).not.toHaveProperty("meeting_get_ui_config");
    for (const name of Object.keys(plugin.handlers)) {
      expect(name, `"${name}" puts theme on the tool surface`).not.toMatch(/theme/i);
    }
  });

  it("does not subscribe to host.theme.changed at all", async () => {
    // Stronger than the old rule, which allowed the subscription so long as it
    // did not become a tool. A subscription now means the plugin has decided
    // it is the one to paint something, and the only thing it could paint is
    // a card whose document belongs to the dock.
    const { context, events } = makeContext();
    await createPlugin(context);

    expect([...events.keys()]).not.toContain("host.theme.changed");
  });

  it("holds no theme payload and no channel to push one down", () => {
    // Source-shape, because the runtime signal is absent by construction:
    // nothing subscribes, so nothing would ever run to be observed. A cached
    // payload plus a send is the shape the old relay had, and it is the shape
    // that would come back.
    expect(HOST_PLUGIN_SRC).not.toContain("lastThemePayload");
    expect(HOST_PLUGIN_SRC).not.toMatch(/["']meeting-floating:(get-)?theme["']/);
    // The send, not the word: `webContents` still appears in comments that
    // explain what the sender-keyed ACL used to be, and a match on the bare
    // identifier would make writing that history a test failure.
    expect(HOST_PLUGIN_SRC).not.toMatch(/webContents\s*(as[^;]*)?\)?\s*[.\[]\s*["']?send/u);
  });
});
