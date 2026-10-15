import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createPlugin from "../src/hostPlugin.js";
import type { StoredPrep } from "../src/persistence/prepStore.js";

type EmittedEvent = {
  type: string;
  data: unknown;
};

function makeContext() {
  const root = mkdtempSync(join(tmpdir(), "ave-meeting-scheduled-"));
  mkdirSync(join(root, "sessions"), { recursive: true });
  const emitted: EmittedEvent[] = [];
  return {
    root,
    emitted,
    context: {
      pluginId: "meeting",
      pluginRoot: root,
      hostRoot: root,
      pluginDataDir: root,
      log: (_msg: string) => { /* noop */ },
      hostApi: {
        emitEvent: (type: string, data?: unknown) => {
          emitted.push({ type, data });
        },
        onEvent: () => () => {},
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

describe("scheduled meeting registration tools", () => {
  it("returns a clarification request instead of throwing when scheduled single registration has no meeting data", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_scheduled_meeting({});

      expect(result).toMatchObject({
        ok: false,
        needsInput: true,
        missing: ["meetingData"],
      });
      expect((result as { message?: string }).message).toContain("참석자와 회의 링크는 선택 정보");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a clarification request instead of throwing when bulk registration has no meeting list", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_scheduled_meetings({});

      expect(result).toMatchObject({
        ok: false,
        needsInput: true,
        missing: ["meetings", "events"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("manually registers a meeting from title and time and focuses it by default", async () => {
    const { root, emitted, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_manual_meeting({
        title: "회의록 사용법 안내",
        scheduledStart: "2026-05-20T15:00:00+09:00",
        scheduledEnd: "2026-05-20T16:00:00+09:00",
        category: "\uC77C\uBC18",
        organizer: "Ave 가이드",
        location: "온라인",
        participants: ["회의 진행자", "참석자"],
        agenda: ["회의 전 안내 카드 확인", "녹음 시작", "회의록 생성"],
      });

      expect(result).toMatchObject({
        ok: true,
        source: "manual",
        focusInUi: true,
      });

      const current = await plugin.handlers.meeting_get_prep();
      expect(current).toMatchObject({
        title: "회의록 사용법 안내",
        scheduledStart: "2026-05-20T15:00:00+09:00",
      });

      const registeredEvent = emitted.filter((event) => event.type === "meeting.prep.registered").pop();
      expect(registeredEvent?.data).toMatchObject({
        count: 1,
        source: "manual",
        focusInUi: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks the user to choose a category before registering when category is missing", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_manual_meeting({
        title: "Category required meeting",
        scheduledStart: "2026-05-20T15:00:00+09:00",
      });

      expect(result).toMatchObject({
        ok: false,
        needsCategorySelection: true,
        missing: ["category"],
      });
      expect((result as { categories?: string[] }).categories).toContain("\uC77C\uBC18");
      expect(await plugin.handlers.meeting_list_preps()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks for category registration before accepting a new explicit category", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_manual_meeting({
        title: "신규 카테고리 회의",
        scheduledStart: "2026-05-20T15:00:00+09:00",
        category: "신규전략",
      });

      expect(result).toMatchObject({
        ok: false,
        needsCategoryRegistration: true,
        unknownCategories: ["신규전략"],
      });

      const categories = await plugin.handlers.meeting_categories();
      expect((categories as { categories: string[] }).categories).toContain("일반");
      expect((categories as { categories: string[] }).categories).not.toContain("신규전략");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attaches the latest summary from the matched category to a new prep", async () => {
    const { root, context } = makeContext();
    try {
      writeFileSync(join(root, "sessions", "prev-project.json"), JSON.stringify({
        sessionId: "prev-project",
        context: { title: "지난 프로젝트 회의", category: "프로젝트" },
        category: "프로젝트",
        transcript: [],
        intermediateSummaries: [],
        finalized: true,
        createdAt: "2026-05-19T01:00:00.000Z",
        updatedAt: "2026-05-19T01:30:00.000Z",
        finalSummary: {
          title: "지난 프로젝트 회의",
          summary: "지난 프로젝트 회의 요약입니다.",
          highlights: [],
          actionItems: [],
          createdAt: "2026-05-19T01:30:00.000Z",
        },
      }), "utf-8");

      const plugin = await createPlugin(context);
      await plugin.handlers.meeting_register_manual_meeting({
        title: "프로젝트 후속 회의",
        scheduledStart: "2026-05-20T15:00:00+09:00",
        category: "프로젝트",
        agenda: ["지난 회의 review", "다음 단계"],
      });

      const current = await plugin.handlers.meeting_get_prep();
      expect(current).toMatchObject({
        category: "프로젝트",
        previousSummary: {
          title: "지난 프로젝트 회의",
          summary: "지난 프로젝트 회의 요약입니다.",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets manual meeting registration avoid stealing the current prep when requested", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      await plugin.handlers.meeting_open_prep({
        context: {
          id: "current-prep",
          title: "Current prep",
          scheduledStart: "2026-05-20T09:00:00+09:00",
          category: "\uC77C\uBC18",
        },
      });

      const result = await plugin.handlers.meeting_register_manual_meeting({
        title: "백그라운드 등록 가이드",
        scheduledStart: "2026-05-20T17:00:00+09:00",
        category: "\uC77C\uBC18",
        agenda: ["\uBC30\uACBD \uCEE8\uD14D\uC2A4\uD2B8 \uACF5\uC720"],
        focusInUi: false,
      });

      expect(result).toMatchObject({
        ok: true,
        source: "manual",
        focusInUi: false,
      });

      const current = await plugin.handlers.meeting_get_prep();
      expect(current).toMatchObject({ id: "current-prep" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a legacy top-level webexUrl for manual registration", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      await plugin.handlers.meeting_register_manual_meeting({
        title: "Webex 회의록 생성 가이드",
        scheduledStart: "2026-05-20T18:00:00+09:00",
        category: "\uC77C\uBC18",
        agenda: ["Webex \uC811\uC18D \uD655\uC778"],
        webexUrl: "https://example.webex.com/meet/robot-sync",
        focusInUi: false,
      });

      const preps = await plugin.handlers.meeting_list_preps();
      const prep = (preps as StoredPrep[]).find((item) => item.title === "Webex 회의록 생성 가이드");
      expect(prep?.conference).toMatchObject({
        type: "webex",
        joinUrl: "https://example.webex.com/meet/robot-sync",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a raw calendar watcher event payload for real-time registration", async () => {
    const { root, emitted, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_scheduled_meeting({
        event: {
          id: "graph-event-1",
          subject: "Teams 회의 녹음 가이드",
          start: "2026-05-20T10:00:00+09:00",
          end: "2026-05-20T11:00:00+09:00",
          location: "Online",
          category: "\uC77C\uBC18",
          bodyText: "캘린더 watcher 에서 전달된 예정 회의입니다.",
          agendaText: "- 진행 현황 공유\n- 녹음 전 체크",
          organizer: { name: "캘린더 연동", address: "calendar-sync@example.com" },
          attendees: [
            { name: "회의 진행자", address: "host@example.com", status: "accepted" },
            { name: "참석자", address: "attendee@example.com", status: "tentative" },
          ],
          isOnlineMeeting: true,
          onlineMeetingUrl: "https://teams.microsoft.com/l/meetup-join/ave-sync",
        },
        source: "calendar-sync",
      });

      expect(result).toMatchObject({
        ok: true,
        id: "graph-event-1",
        source: "calendar-sync",
        focusInUi: false,
      });

      const preps = await plugin.handlers.meeting_list_preps();
      const prep = (preps as StoredPrep[]).find((item) => item.id === "graph-event-1");
      expect(prep).toMatchObject({
        id: "graph-event-1",
        title: "Teams 회의 녹음 가이드",
        scheduledStart: "2026-05-20T10:00:00+09:00",
        scheduledEnd: "2026-05-20T11:00:00+09:00",
        location: "Online",
        organizer: "캘린더 연동",
        agenda: ["진행 현황 공유", "녹음 전 체크"],
      });
      expect(prep?.participants).toEqual(["회의 진행자", "참석자"]);
      expect(prep?.conference).toMatchObject({
        type: "teams",
        joinUrl: "https://teams.microsoft.com/l/meetup-join/ave-sync",
      });

      const registeredEvent = emitted.filter((event) => event.type === "meeting.prep.registered").pop();
      expect(registeredEvent?.data).toMatchObject({
        id: "graph-event-1",
        count: 1,
        source: "calendar-sync",
        focusInUi: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns needsAgenda when scheduled registration has no agenda source", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_scheduled_meeting({
        id: "flat-scheduled-meeting",
        title: "평평한 payload 예정 회의",
        scheduledStart: "2026-05-20T12:00:00+09:00",
        scheduledEnd: "2026-05-20T12:30:00+09:00",
        category: "\uC77C\uBC18",
        source: "video-meeting",
      });

      expect(result).toMatchObject({
        ok: false,
        needsAgenda: true,
        missing: ["agenda"],
      });
      expect(await plugin.handlers.meeting_list_preps()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts minimal top-level meeting fields when agenda is provided, without participants or joinUrl", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_scheduled_meeting({
        id: "flat-scheduled-meeting",
        title: "평평한 payload 예정 회의",
        scheduledStart: "2026-05-20T12:00:00+09:00",
        scheduledEnd: "2026-05-20T12:30:00+09:00",
        category: "\uC77C\uBC18",
        agenda: ["등록 흐름 확인"],
        source: "video-meeting",
      });

      expect(result).toMatchObject({
        ok: true,
        id: "flat-scheduled-meeting",
        source: "video-meeting",
        focusInUi: false,
      });

      const preps = await plugin.handlers.meeting_list_preps();
      const prep = (preps as StoredPrep[]).find((item) => item.id === "flat-scheduled-meeting");
      expect(prep).toMatchObject({
        title: "평평한 payload 예정 회의",
        scheduledStart: "2026-05-20T12:00:00+09:00",
        scheduledEnd: "2026-05-20T12:30:00+09:00",
      });
      expect(prep?.participants).toBeUndefined();
      expect(prep?.conference).toBeUndefined();
      expect(prep?.agenda).toEqual(["등록 흐름 확인"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores top-level agenda aliases so the pre-meeting UI can render today's agenda", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_scheduled_meeting({
        id: "today-agenda-meeting",
        title: "오늘 안건 확인 회의",
        scheduledStart: "2026-05-20T14:00:00+09:00",
        category: "\uC77C\uBC18",
        todayAgenda: "1. 지표 확인\n2. 릴리즈 일정 결정",
      });

      expect(result).toMatchObject({
        ok: true,
        id: "today-agenda-meeting",
      });

      const preps = await plugin.handlers.meeting_list_preps();
      const prep = (preps as StoredPrep[]).find((item) => item.id === "today-agenda-meeting");
      expect(prep?.agenda).toEqual(["지표 확인", "릴리즈 일정 결정"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts agenda and Webex URL from calendar/mail body text", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_scheduled_meeting({
        event: {
          id: "mail-webex-1",
          subject: "Webex 제품 싱크",
          start: "2026-05-20T15:00:00+09:00",
          category: "일반",
          bodyText: [
            "Webex 회의입니다.",
            "참여: https://example.webex.com/meet/product-sync",
            "안건",
            "- 이슈 공유",
            "- 다음 액션 정리",
          ].join("\n"),
        },
      });

      expect(result).toMatchObject({ ok: true, id: "mail-webex-1" });
      const preps = await plugin.handlers.meeting_list_preps();
      const prep = (preps as StoredPrep[]).find((item) => item.id === "mail-webex-1");
      expect(prep?.agenda).toEqual(["이슈 공유", "다음 액션 정리"]);
      expect(prep?.conference).toMatchObject({
        type: "webex",
        joinUrl: "https://example.webex.com/meet/product-sync",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a Webex URL when the meeting is Webex-related", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_scheduled_meeting({
        id: "webex-no-url",
        title: "Webex 고객 싱크",
        scheduledStart: "2026-05-20T16:00:00+09:00",
        category: "일반",
        agenda: ["고객 이슈 확인"],
      });

      expect(result).toMatchObject({
        ok: false,
        needsWebexUrl: true,
        missing: ["webexUrl"],
      });
      expect(await plugin.handlers.meeting_list_preps()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers a reserved meeting without stealing the currently opened prep", async () => {
    const { root, emitted, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      await plugin.handlers.meeting_open_prep({
        context: {
          id: "manual-focus",
          title: "Current prep",
          organizer: "Ave",
          scheduledStart: "2026-05-20T09:00:00+09:00",
          category: "\uC77C\uBC18",
        },
      });

      const result = await plugin.handlers.meeting_register_scheduled_meeting({
        context: {
          id: "meeting-guide-room",
          title: "회의실 예약 후 녹음 가이드",
          organizer: "일정 연동",
          scheduledStart: "2026-05-20T13:00:00+09:00",
          scheduledEnd: "2026-05-20T14:00:00+09:00",
          category: "\uC77C\uBC18",
          location: "서울 본사 10층 회의실 A",
          agenda: ["회의실 예약 내용 확인"],
        },
        source: "room-reservation",
      });

      expect(result).toMatchObject({
        ok: true,
        id: "meeting-guide-room",
        source: "room-reservation",
        focusInUi: false,
      });

      const current = await plugin.handlers.meeting_get_prep();
      expect(current).toMatchObject({ id: "manual-focus" });

      const preps = await plugin.handlers.meeting_list_preps();
      expect(Array.isArray(preps)).toBe(true);
      expect((preps as Array<{ id: string }>).map((item) => item.id)).toEqual(
        expect.arrayContaining(["manual-focus", "meeting-guide-room"]),
      );

      const registeredEvent = emitted.filter((event) => event.type === "meeting.prep.registered").pop();
      expect(registeredEvent?.data).toMatchObject({
        id: "meeting-guide-room",
        count: 1,
        source: "room-reservation",
        focusInUi: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bulk-registers scheduled meetings and emits a summary event", async () => {
    const { root, emitted, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_scheduled_meetings({
        meetings: [
          {
            id: "teams-sync-1",
            title: "Teams 정기 회의 녹음 가이드",
            organizer: "캘린더 연동",
            scheduledStart: "2026-05-20T15:00:00+09:00",
            category: "\uC77C\uBC18",
            agenda: ["Teams 연결 확인"],
            conference: { type: "teams", joinUrl: "https://teams.microsoft.com/l/meetup-join/teams-sync-1" },
          },
          {
            id: "zoom-sync-2",
            title: "Zoom 외부 회의 업로드 가이드",
            organizer: "캘린더 연동",
            scheduledStart: "2026-05-20T16:00:00+09:00",
            category: "\uC77C\uBC18",
            agenda: ["외부 회의 업로드 흐름 확인"],
            conference: { type: "zoom", joinUrl: "https://example.zoom.us/j/1234567890" },
          },
        ],
        source: "video-meeting",
      });

      expect(result).toMatchObject({
        ok: true,
        count: 2,
        source: "video-meeting",
      });
      expect((result as { ids: string[] }).ids).toEqual(["teams-sync-1", "zoom-sync-2"]);

      const preps = await plugin.handlers.meeting_list_preps();
      expect((preps as Array<{ id: string }>).map((item) => item.id)).toEqual(
        expect.arrayContaining(["teams-sync-1", "zoom-sync-2"]),
      );

      const registeredEvent = emitted.filter((event) => event.type === "meeting.prep.registered").pop();
      expect(registeredEvent?.data).toMatchObject({
        ids: ["teams-sync-1", "zoom-sync-2"],
        count: 2,
        source: "video-meeting",
        focusInUi: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts raw calendar events for bulk registration", async () => {
    const { root, emitted, context } = makeContext();
    try {
      const plugin = await createPlugin(context);

      const result = await plugin.handlers.meeting_register_scheduled_meetings({
        events: [
          {
            id: "watcher-1",
            subject: "Webex 전사 생성 가이드",
            start: "2026-05-20T17:00:00+09:00",
            end: "2026-05-20T18:00:00+09:00",
            category: "\uC77C\uBC18",
            isOnlineMeeting: true,
            onlineMeetingUrl: "https://example.webex.com/meet/ave-sync",
            bodyText: "안건\n- Webex 접속 확인\n- 전사 생성",
          },
          {
            id: "watcher-2",
            subject: "오프라인 회의록 생성 가이드",
            start: "2026-05-20T18:30:00+09:00",
            end: "2026-05-20T19:00:00+09:00",
            category: "\uC77C\uBC18",
            location: "서울 본사 10층 회의실 B",
            bodyText: "안건\n- 오프라인 회의록 생성",
          },
        ],
        source: "calendar-sync",
      });

      expect(result).toMatchObject({
        ok: true,
        count: 2,
        source: "calendar-sync",
      });
      expect((result as { ids: string[] }).ids).toEqual(["watcher-1", "watcher-2"]);

      const preps = await plugin.handlers.meeting_list_preps();
      const mapped = new Map((preps as StoredPrep[]).map((item) => [item.id, item]));
      expect(mapped.get("watcher-1")?.conference).toMatchObject({
        type: "webex",
        joinUrl: "https://example.webex.com/meet/ave-sync",
      });
      expect(mapped.get("watcher-2")?.location).toBe("서울 본사 10층 회의실 B");

      const registeredEvent = emitted.filter((event) => event.type === "meeting.prep.registered").pop();
      expect(registeredEvent?.data).toMatchObject({
        ids: ["watcher-1", "watcher-2"],
        count: 2,
        source: "calendar-sync",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // v0.5.16 — manual meeting tool requires agenda + accepts optional
  // previousSummary. Following tests lock the new contract.
  it("returns needsAgenda fail-soft when agenda is missing (after category gate passes)", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);
      const result = await plugin.handlers.meeting_register_manual_meeting({
        title: "안건 누락 회의",
        scheduledStart: "2026-05-26T15:00:00+09:00",
        category: "일반",
      });
      expect(result).toMatchObject({
        ok: false,
        needsAgenda: true,
        missing: ["agenda"],
      });
      expect((result as { message?: string }).message).toContain("회의 안건");
      expect(await plugin.handlers.meeting_list_preps()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts agendaText / agendaItems / todayAgenda as agenda aliases (scheduled-tool parity)", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);
      const r1 = await plugin.handlers.meeting_register_manual_meeting({
        id: "manual-alias-1",
        title: "agendaText alias",
        scheduledStart: "2026-05-26T15:00:00+09:00",
        category: "일반",
        agendaText: "- 1번\n- 2번",
      });
      expect(r1).toMatchObject({ ok: true, source: "manual" });

      const r2 = await plugin.handlers.meeting_register_manual_meeting({
        id: "manual-alias-2",
        title: "agendaItems alias",
        scheduledStart: "2026-05-26T16:00:00+09:00",
        category: "일반",
        agendaItems: ["A"],
        focusInUi: false,
      });
      expect(r2).toMatchObject({ ok: true });

      const r3 = await plugin.handlers.meeting_register_manual_meeting({
        id: "manual-alias-3",
        title: "todayAgenda alias",
        scheduledStart: "2026-05-26T17:00:00+09:00",
        category: "일반",
        todayAgenda: ["B"],
        focusInUi: false,
      });
      expect(r3).toMatchObject({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores previousSummary verbatim when caller provides { title, summary }", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);
      await plugin.handlers.meeting_register_manual_meeting({
        title: "이전 요약 포함",
        scheduledStart: "2026-05-26T15:00:00+09:00",
        category: "일반",
        agenda: ["AI", "BI"],
        previousSummary: {
          title: "지난 회의",
          summary: "핵심 결정 사항 X",
        },
      });
      const current = await plugin.handlers.meeting_get_prep();
      expect(current).toMatchObject({
        previousSummary: {
          title: "지난 회의",
          summary: "핵심 결정 사항 X",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("silently drops malformed previousSummary (whitespace-only / array-shape)", async () => {
    const { root, context } = makeContext();
    try {
      const plugin = await createPlugin(context);
      await plugin.handlers.meeting_register_manual_meeting({
        title: "잘못된 previousSummary",
        scheduledStart: "2026-05-26T15:00:00+09:00",
        category: "일반",
        agenda: ["x"],
        previousSummary: { summary: "   " },
      });
      const current = await plugin.handlers.meeting_get_prep();
      expect((current as { previousSummary?: unknown }).previousSummary).toBeUndefined();

      // Array-shape previousSummary — Array.isArray guard should drop.
      await plugin.handlers.meeting_register_manual_meeting({
        id: "manual-array-shape",
        title: "배열 previousSummary",
        scheduledStart: "2026-05-26T16:00:00+09:00",
        category: "일반",
        agenda: ["y"],
        previousSummary: [{ summary: "should be dropped" }],
        focusInUi: false,
      });
      const preps = await plugin.handlers.meeting_list_preps();
      const stored = (preps as StoredPrep[]).find((p) => p.id === "manual-array-shape");
      expect((stored as { previousSummary?: unknown })?.previousSummary).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
