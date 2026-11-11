import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { recorderText } from "../src/ui/recorderI18n.js";
import { createErrorConsumer, createPendingChanges, endedSessionToOpen, endedSessionToNotify, shouldRefreshView, deferCompletionNavigation } from "../src/ui/viewUpdates.js";

const recorder = readFileSync(new URL("../src/ui/recorder-card.js", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/ui/meeting-control.mjs", import.meta.url), "utf8");
function section(source: string, from: string, to: string) {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw Error("UI section not found");
  return source.slice(start, end);
}
function node(textContent = "", classes: string[] = []) {
  const values = new Set(classes);
  return { textContent, lastChild: { textContent }, title: "", dataset: {} as Record<string, string>,
    attributes: {} as Record<string, string>,
    setAttribute(key: string, value: string) { this.attributes[key] = value; },
    classList: {contains: (key: string) => values.has(key), add: (key: string) => values.add(key), remove: (...keys: string[]) => keys.forEach(key => values.delete(key))} };
}

describe("recorder locale repaint", () => {
  it("repaints every label on the real en to ko host-context callback", () => {
    const appSource = readFileSync(new URL("../src/ui/mcp-app.mjs", import.meta.url), "utf8").replace(/^import .*\n/, "").replaceAll("export ", "");
    const applyHostContext = runInNewContext(appSource + "\napplyHostContext");
    for (const state of ["initial", "ready", "empty", "unavailable"]) {
      let context = {locale: "en", theme: "light", styles: {variables: {}}};
      const controls = {tabs: node(), noteTab: node(), meetingTab: node(), modeToggle: node(), mixOpt: node(), micOnlyOpt: node(),
        cancelBtn: node(), pauseBtn: node(), doneBtn: node(), notes: node(), errorBanner: node(), captureBadge: node()};
      const option = (labelKey?: string, deviceSuffix?: string) => ({textContent: "", dataset: {...(labelKey ? {labelKey} : {}), ...(deviceSuffix ? {deviceSuffix} : {})}});
      const named = {textContent: "User-named microphone", dataset: {}};
      const micSelect = {...node(), dataset: {listState: state}, options: [option("defaultMicrophone"), option("microphonesUnavailable"), option("microphonesEmpty"), option(undefined, "123456"), named]};
      const globals = {...controls, micSelect, isPaused: false, finalizing: false, lastSttError: "429 quota",
        badgeMode: "mic" as string | null, badgeHint: undefined, badgeHintKey: "changingDevice" as string | undefined,
        t: (key: Parameters<typeof recorderText>[1]) => recorderText(context.locale, key),
      };
      const source = section(recorder, "function classifySttError(", "function showSttError(")
        + section(recorder, "function setCaptureBadge(", "function fmtTime(")
        + section(recorder, "function refreshRecorderLabels()", "applyHostContext(bridge.app, shell,");
      const refresh = runInNewContext(source + "\nrefreshRecorderLabels", globals);
      const app = {getHostContext: () => context, onhostcontextchanged: () => {}};
      const refreshWaveColor = vi.fn();
      // Execute the actual registration, including its theme and label callbacks.
      const registration = recorder.slice(recorder.indexOf("applyHostContext(bridge.app, shell,"), recorder.indexOf("// What session this card", recorder.indexOf("applyHostContext(bridge.app, shell,")));
      runInNewContext(registration, {applyHostContext, bridge: {app}, shell: {style: {setProperty: () => {}, removeProperty: () => {}}}, refreshRecorderLabels: refresh, refreshWaveColor});
      expect(controls.noteTab.textContent).toBe("Note");
      context = {...context, locale: "ko"};
      app.onhostcontextchanged();
      expect(controls.tabs.attributes["aria-label"]).toBe("녹음 보기");
      expect(controls.noteTab.textContent).toBe("노트");
      expect(controls.meetingTab.textContent).toBe("녹음");
      expect(controls.modeToggle.attributes["aria-label"]).toBe("캡처 모드");
      expect(controls.mixOpt.textContent).toBe("혼합");
      expect(controls.micOnlyOpt.textContent).toBe("마이크만");
      expect(controls.cancelBtn.lastChild.textContent).toBe(" 취소");
      expect(controls.pauseBtn.lastChild.textContent).toBe(" 일시 정지");
      expect(controls.doneBtn.lastChild.textContent).toBe(" 완료");
      expect(micSelect.title).toBe("마이크 선택");
      expect(micSelect.attributes["aria-label"]).toBe(state === "unavailable" ? "마이크 목록을 불러올 수 없습니다" : state === "empty" ? "마이크를 찾을 수 없습니다" : "마이크");
      expect(micSelect.options.map(item => item.textContent)).toEqual(["기본 마이크", "마이크 목록을 불러올 수 없습니다", "마이크를 찾을 수 없습니다", "마이크 (123456…)", "User-named microphone"]);
      expect(controls.notes.textContent).toBe("회의 요약이 아직 생성되지 않았습니다.\n몇 분간 대화가 누적되면 자동으로 표시됩니다.");
      expect(controls.errorBanner.textContent).toBe("OpenAI 한도 초과 — STT 일시 중단. platform.openai.com 에서 결제/한도 확인이 필요합니다.");
      expect(controls.captureBadge.textContent).toBe("🎤 마이크만 — 장치 변경 중…");
      expect(refreshWaveColor).toHaveBeenCalledTimes(2);
      globals.isPaused = true; globals.finalizing = true;
      controls.notes.classList.add("has-content"); controls.notes.textContent = "Actual meeting content";
      app.onhostcontextchanged();
      expect(controls.pauseBtn.lastChild.textContent).toBe(" 재개");
      expect(controls.doneBtn.lastChild.textContent).toBe("분석 중…");
      expect(controls.notes.textContent).toBe("Actual meeting content");
      for (const [mode, expected] of [[null, "녹음 시작 중…"], ["mic", "🎤 마이크만 캡처 중"], ["loopback", "🔊 + 🎤 시스템 오디오 + 마이크"]] as const) {
        globals.badgeMode = mode;
        globals.badgeHintKey = undefined;
        context = {...context, locale: "en"}; app.onhostcontextchanged();
        context = {...context, locale: "ko"}; app.onhostcontextchanged();
        expect(controls.captureBadge.textContent).toBe(expected);
      }
      for (const [error, expected] of [["401", "OpenAI 인증 실패 — 설정에서 API 키를 확인해주세요."], ["network", "네트워크 오류 — STT 호출 실패. 잠시 후 자동 재시도."], ["pause-denied", "녹음 상태 변경이 거부되었습니다."], ["Provider detail", "STT 오류: Provider detail"]] as const) {
        globals.lastSttError = error;
        context = {...context, locale: "en"}; app.onhostcontextchanged();
        context = {...context, locale: "ko"}; app.onhostcontextchanged();
        expect(controls.errorBanner.textContent).toBe(expected);
      }
    }
  });
});

describe("completion while another meeting is edited", () => {
  function fixture() {
    let editing = true;
    const pendingChanges = createPendingChanges();
    const setView = vi.fn(), renderCurrentView = vi.fn(), showSuccessToast = vi.fn();
    const callTool = vi.fn(async (name: string) => name === "meeting_view_state"
      ? {lastError: null, recorder: null, activeSessions: []} : {finalSummary: {title: "Meeting A title"}});
    const globals = {bridge: {callTool}, consumeError: createErrorConsumer(), pendingChanges, activeFloatingSessionId: "A",
      scope: {querySelector: () => editing ? {} : null}, viewArea: {querySelector: () => ({dataset: {tab: "summary"}})},
      currentView: "session-detail", selectedSessionId: "B", pendingSubTab: null, setView, renderCurrentView, showSuccessToast,
      showErrorToast: vi.fn(), shouldRefreshView, endedSessionToOpen, endedSessionToNotify, deferCompletionNavigation};
    const refresh = runInNewContext(section(sidebar, "  async function refreshChanges(", "  let refreshQueue") + "\nrefreshChanges", globals);
    return {refresh, globals, pendingChanges, setView, renderCurrentView, showSuccessToast, stopEditing: () => { editing = false; }};
  }
  it("save and cancel stay on B and name completed A in a toast", async () => {
    for (const _exit of ["save", "cancel"]) {
      const f = fixture();
      await f.refresh({changes: [{kind: "meeting.ended", sessionId: "A"}]});
      expect(f.setView).not.toHaveBeenCalled();
      f.stopEditing();
      await f.refresh({...f.pendingChanges.take(), reset: true});
      expect(f.setView).not.toHaveBeenCalled();
      expect(f.globals.selectedSessionId).toBe("B");
      expect(f.showSuccessToast).toHaveBeenCalledExactlyOnceWith("“Meeting A title” 회의가 종료되었습니다.");
      expect(f.renderCurrentView).toHaveBeenCalledTimes(1);
      expect(f.pendingChanges.take()).toBeNull();
    }
  });
  it("keeps B when the edit closes before the queued snapshot starts", async () => {
    const f = fixture();
    const schedule = runInNewContext(section(sidebar, "  function scheduleRefresh(", "  function flushPendingChanges(") + "\nscheduleRefresh", {
      refreshQueue: Promise.resolve(), scope: f.globals.scope, refreshChanges: f.refresh, deferCompletionNavigation,
    });
    const queued = schedule({changes: [{kind: "meeting.ended", sessionId: "A"}]});
    f.stopEditing();
    await queued;
    expect(f.setView).not.toHaveBeenCalled();
    expect(f.globals.selectedSessionId).toBe("B");
    expect(f.showSuccessToast).toHaveBeenCalledExactlyOnceWith("“Meeting A title” 회의가 종료되었습니다.");
  });
  it("still opens completed A automatically when no edit was open", async () => {
    const f = fixture(); f.stopEditing();
    await f.refresh({changes: [{kind: "meeting.ended", sessionId: "A"}]});
    expect(f.setView).toHaveBeenCalledExactlyOnceWith("session-detail", "A");
    expect(f.showSuccessToast).not.toHaveBeenCalled();
  });
});

describe("category dialog close", () => {
  it("flushes pending changes on close, cancel, submit, Escape and backdrop", async () => {
    const source = section(sidebar, "  function requestCategoryName()", "  function ");
    for (const action of ["close", "cancel", "submit", "escape", "backdrop"]) {
      const nodes: Array<{className: string; value: string; handlers: Record<string, (event?: unknown) => void>; remove: ReturnType<typeof vi.fn>}> = [];
      const el = (_tag: string, attrs: Record<string, string>) => {
        const item = {className: attrs?.class ?? "", value: "Fixture category", handlers: {} as Record<string, (event?: unknown) => void>,
          remove: vi.fn(), appendChild: () => {}, focus: () => {}, addEventListener(name: string, handler: (event?: unknown) => void) { this.handlers[name] = handler; }};
        nodes.push(item); return item;
      };
      const flushPendingChanges = vi.fn();
      const open = runInNewContext(source + "\nrequestCategoryName", {el, scope: {appendChild: () => {}}, flushPendingChanges, window: {setTimeout: () => {}}});
      const result = open();
      const find = (klass: string) => nodes.find(item => item.className.split(" ").includes(klass))!;
      if (action === "escape") find("category-dialog-input").handlers.keydown!({key: "Escape", preventDefault: () => {}});
      else if (action === "backdrop") { const overlay = find("category-dialog"); overlay.handlers.click!({target: overlay}); }
      else find(action === "close" ? "prompt-overlay-close" : action === "cancel" ? "prompt-overlay-cancel" : "prompt-overlay-save").handlers.click!();
      expect(await result).toBe(action === "submit" ? "Fixture category" : null);
      expect(find("category-dialog").remove).toHaveBeenCalledTimes(1);
      expect(flushPendingChanges).toHaveBeenCalledTimes(1);
    }
  });
});
