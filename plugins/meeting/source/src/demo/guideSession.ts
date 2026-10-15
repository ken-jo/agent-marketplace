import type { PersistedSession } from "../persistence/sessionStore.js";

export const GUIDE_SESSION_ID = "meeting-guide-demo";

const GUIDE_CREATED_AT = "2026-05-21T06:00:00.000Z";

export const BUNDLED_GUIDE_SESSION: PersistedSession = {
  sessionId: GUIDE_SESSION_ID,
  readOnlyGuide: true,
  context: {
    id: GUIDE_SESSION_ID,
    title: "가이드: 회의 플러그인으로 회의록 만들기",
    organizer: "Ave 가이드",
    participants: ["회의 진행자", "참석자"],
    description:
      "처음 사용하는 사용자가 예정 회의 확인, 녹음 시작, 회의록 생성, 파일 업로드 흐름을 한 번에 이해할 수 있도록 제공되는 읽기 전용 가이드입니다.",
  },
  transcript: [
    {
      id: "guide-seg-1",
      speaker: "회의 진행자",
      original:
        "회의가 예정되어 있으면 먼저 회의 전 안내 카드에서 제목, 시간, 안건, 화상회의 링크를 확인합니다. 참석자 정보는 있으면 좋지만 없어도 녹음과 회의록 생성은 진행할 수 있습니다.",
      startSec: 0,
      endSec: 13,
      isFinal: true,
      source: "batch",
      createdAt: GUIDE_CREATED_AT,
    },
    {
      id: "guide-seg-2",
      speaker: "참석자",
      original:
        "회의를 시작할 때는 녹음 버튼을 누르면 됩니다. 작은 녹음 창이 열리고, 마이크와 시스템 오디오를 캡처하면서 전사가 자동으로 쌓입니다.",
      startSec: 13,
      endSec: 25,
      isFinal: true,
      source: "batch",
      createdAt: GUIDE_CREATED_AT,
    },
    {
      id: "guide-seg-3",
      speaker: "회의 진행자",
      original:
        "회의가 끝나면 Done 버튼을 눌러 종료합니다. 그러면 플러그인이 전사를 바탕으로 요약, 하이라이트, 액션 아이템이 포함된 최종 회의록을 만듭니다.",
      startSec: 25,
      endSec: 39,
      isFinal: true,
      source: "batch",
      createdAt: GUIDE_CREATED_AT,
    },
    {
      id: "guide-seg-4",
      speaker: "참석자",
      original:
        "이미 녹음된 파일이 있다면 업로드로도 회의록을 만들 수 있습니다. 회의 중 실시간 녹음을 못 했거나, 외부 회의 녹음 파일을 정리할 때 유용합니다.",
      startSec: 39,
      endSec: 52,
      isFinal: true,
      source: "batch",
      createdAt: GUIDE_CREATED_AT,
    },
    {
      id: "guide-seg-5",
      speaker: "회의 진행자",
      original:
        "완료된 회의록은 목록에서 다시 열어볼 수 있고, 필요한 경우 제목이나 액션 아이템을 수정하거나 요약을 다시 생성할 수 있습니다.",
      startSec: 52,
      endSec: 64,
      isFinal: true,
      source: "batch",
      createdAt: GUIDE_CREATED_AT,
    },
  ],
  intermediateSummaries: [
    {
      coveredSegmentCount: 3,
      data: {
        summary:
          "회의 전 안내 카드에서 회의 정보를 확인한 뒤 녹음을 시작하고, 종료 시 최종 회의록을 생성하는 기본 흐름을 설명했습니다.",
        highlights: [
          "참석자 정보는 선택 정보이며 없어도 회의록 생성이 가능합니다.",
          "녹음 버튼을 누르면 floating recorder 창이 열리고 전사가 자동으로 누적됩니다.",
          "Done 버튼으로 종료하면 요약, 하이라이트, 액션 아이템이 생성됩니다.",
        ],
        coveredSegmentIds: ["guide-seg-1", "guide-seg-2", "guide-seg-3"],
        createdAt: GUIDE_CREATED_AT,
      },
    },
  ],
  finalized: true,
  finalSummary: {
    title: "회의 플러그인 사용 흐름 가이드",
    summary:
      "회의 플러그인은 예정 회의 정보를 확인하고, 녹음을 시작한 뒤, 종료 시 자동으로 회의록을 생성하는 흐름으로 사용할 수 있습니다. 예정 회의 카드에는 제목, 시간, 안건, 링크가 표시되며 참석자 정보는 선택 사항입니다. 녹음 버튼을 누르면 floating recorder 창이 열리고 전사가 누적되며, Done 버튼을 누르면 요약, 하이라이트, 액션 아이템이 포함된 최종 회의록이 만들어집니다. 이미 녹음된 파일이 있는 경우 업로드로도 회의록을 생성할 수 있고, 완료된 회의록은 목록에서 다시 열어 수정하거나 재생성할 수 있습니다.",
    highlights: [
      "예정 회의 카드에서 제목, 시간, 안건, 화상회의 링크를 먼저 확인합니다.",
      "참석자 정보는 선택 사항이며 비어 있어도 녹음과 회의록 생성이 가능합니다.",
      "녹음 버튼을 누르면 floating recorder 창이 열리고 전사가 자동으로 쌓입니다.",
      "Done 버튼으로 종료하면 요약, 하이라이트, 액션 아이템이 포함된 회의록이 생성됩니다.",
      "이미 녹음된 파일은 업로드 기능으로 회의록을 만들 수 있습니다.",
    ],
    actionItems: [
      "회의 전: 안내 카드에서 회의 제목, 시간, 안건, 링크를 확인합니다.",
      "회의 시작: 녹음 버튼을 눌러 floating recorder 창을 엽니다.",
      "회의 종료: Done 버튼을 눌러 최종 회의록을 생성합니다.",
      "회의 후: 회의록 목록에서 결과를 다시 열고 필요한 항목을 수정합니다.",
      "대체 경로: 녹음 파일이 이미 있다면 업로드로 회의록을 생성합니다.",
    ],
    createdAt: GUIDE_CREATED_AT,
    lengthTier: "medium",
  },
  createdAt: GUIDE_CREATED_AT,
  updatedAt: GUIDE_CREATED_AT,
};

export function isGuideSessionId(sessionId: string | undefined): boolean {
  return sessionId === GUIDE_SESSION_ID;
}

export function cloneBundledGuideSession(): PersistedSession {
  return JSON.parse(JSON.stringify(BUNDLED_GUIDE_SESSION)) as PersistedSession;
}
