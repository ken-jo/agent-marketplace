import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createPlugin from "../src/hostPlugin.js";
import { GUIDE_SESSION_ID } from "../src/demo/guideSession.js";
import type { SessionMetadata } from "../src/persistence/sessionMetadata.js";
import type { PersistedSession } from "../src/persistence/sessionStore.js";

function makeContext() {
  const root = mkdtempSync(join(tmpdir(), "ave-meeting-guide-"));
  mkdirSync(join(root, "sessions"), { recursive: true });
  return {
    root,
    context: {
      pluginId: "meeting",
      pluginRoot: root,
      hostRoot: root,
      pluginDataDir: root,
      log: (_msg: string) => { /* noop */ },
      hostApi: {
        emitEvent: () => { /* noop */ },
        onEvent: () => { /* noop */ },
        getSecret: () => null,
        logEvent: () => { /* noop */ },
        onShutdown: () => { /* noop */ },
        config: {
          get: () => undefined,
          onChange: () => () => { /* noop */ },
        },
      },
    },
  };
}

describe("bundled guide session", () => {
  it("appears in meeting_sessions and resolves through meeting_session_detail as read-only", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const sessions = await plugin.handlers.meeting_sessions();
      expect(Array.isArray(sessions)).toBe(true);
      const guideMeta = (sessions as SessionMetadata[]).find(
        (item) => item.sessionId === GUIDE_SESSION_ID,
      );
      expect(guideMeta).toBeDefined();
      expect(guideMeta?.title).toBe("가이드: 회의 플러그인으로 회의록 만들기");
      expect(guideMeta?.readOnlyGuide).toBe(true);

      const detail = await plugin.handlers.meeting_session_detail({ sessionId: GUIDE_SESSION_ID });
      expect(detail).toBeTruthy();
      expect((detail as PersistedSession).sessionId).toBe(GUIDE_SESSION_ID);
      expect((detail as PersistedSession).readOnlyGuide).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
