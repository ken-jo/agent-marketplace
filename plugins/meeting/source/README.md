# Ave Meeting 0.10.3

Requires Ave 0.14.2 / host protocol 5. Views use the MCP Apps SDK and standard host-context theme variables.
Snapshot tools and the app-only, cursor-based `meeting_wait_changes` refresh views without a private channel.
Users or agents explicitly request prep, recording and summaries. Automatic calendar subscriptions are removed.
Copying minutes/links requests clipboard write permission; refused writes show an error. No clipboard reads.

회의 녹음·전사·준비·요약을 제공하는 MCP stdio 익스텐션입니다. 사이드바와 플로팅 녹음 카드는 자체 포함 HTML로 제공되며, `@modelcontextprotocol/ext-apps`의 `App.connect()`와 `callServerTool()`로 서버 도구를 호출합니다. 오디오 캡처, 업로드 임시 파일, STT host fetch, 비밀 임대 및 FFmpeg worker는 서버에 유지됩니다.

## 설치
```bash
bun install
```

빌드 산출물:
- ESM: `dist/index.js`
- CJS: `dist/index.cjs`
- 타입: `dist/index.d.ts`

## 개발 명령어
```bash
bun run typecheck
bun test
bun run build
bun run clean
```

## 대형 파일 업로드용 FFmpeg

25MB 초과 업로드는 파일을 chunk로 받은 뒤 FFmpeg/FFprobe로 오디오를 분할해 STT에 전달합니다. 익스텐션은 부팅할 때마다 현재 OS/CPU에 맞는 런타임 유무를 확인하고, 없으면 백그라운드로 `pluginDataDir/vendor/ffmpeg/<platform-arch>/bin`에 다운로드합니다. 익스텐션 시작 자체는 다운로드를 기다리지 않으며, 대형 업로드 실행 시점에는 설치 완료를 기다린 뒤 FFmpeg를 호출합니다.

실행 파일 탐색 순서:

1. `AVE_MEETING_FFMPEG_PATH` / `AVE_MEETING_FFPROBE_PATH`
2. `AVE_MEETING_FFMPEG_DIR`
3. `pluginDataDir/vendor/ffmpeg/<platform-arch>/bin`
4. `dist/vendor/ffmpeg/<platform-arch>/bin`
5. 시스템 `PATH`

익스텐션 관리 런타임 기본 대상:

- Windows: `win32-x64`, `win32-arm64` — BtbN `lgpl-shared`
- Linux: `linux-x64`, `linux-arm64` — BtbN `lgpl-shared`
- macOS: `darwin-x64`, `darwin-arm64` — ColorsWind macOS LGPL shared build

기본 아카이브는 플랫폼마다 고정된 릴리스 태그(BtbN 은 월말 autobuild, 2년 보존)와 그 아카이브의 sha256 으로 `src/ffmpegRuntime.ts` 에 고정되어 있습니다. 다운로드는 호스트의 `hostFetch` 를 거쳐 8 MiB HTTP Range 조각으로 받고(호스트 응답 상한 16 MiB), 압축 해제 전에 sha256 을 확인합니다. 맞지 않으면 설치를 거부하고 아카이브를 지웁니다.

자동 다운로드를 끄려면 `AVE_MEETING_FFMPEG_AUTO_INSTALL=0`을 설정하세요. 특정 사내 미러나 검증된 빌드를 쓰려면 `AVE_MEETING_FFMPEG_VENDOR_URL` 또는 `AVE_MEETING_FFMPEG_VENDOR_<PLATFORM>_URL`로 HTTPS artifact URL을 지정할 수 있습니다. 이 URL 은 매니페스트 `networkAccess` 가 허용한 호스트에 있어야 하고, 같은 릴리스 디렉터리에 그 아카이브 항목이 있는 `checksums.sha256` 이 있어야 합니다(BtbN 릴리스 형식). 항목이 없거나 파일이 없으면 설치를 거부합니다. `gpl`, `gpl-shared`, `nonfree` artifact로 바꾸지 마세요.

로컬 개발에서 미리 vendor에 설치하려면:

```bash
bun run install:ffmpeg
bun run install:ffmpeg -- --platform linux-x64
bun run install:ffmpeg -- --all
bun run build
```

배포 산출물에는 명시적으로 vendoring한 런타임만 `dist/vendor/ffmpeg`에 복사됩니다. 일반 마켓플레이스 설치는 첫 부팅 다운로드 경로를 사용합니다.

## 제공 Extension API

메서드 ID는 `meeting_start`, `meeting_push_chunk` 등의 underscore convention을 따릅니다. 두 패널은 `ui://meeting/control`, `ui://meeting/recorder` HTML 리소스를 사용합니다.

### 세션 제어
- `meeting_start` — 녹음 플로팅 윈도우 열기 및 회의 세션 시작
- `batch_processing_audio` — 내부/고급용 오디오 배치 처리 세션 시작
- `meeting_push_chunk` — 배치 세션에 PCM16LE 오디오 청크 전달
- `meeting_stop` — 회의 종료 및 최종 요약 반환
- `meeting_cancel` — 진행 중인 회의 세션 취소

### 전사 / 요약 조회
- `meeting_transcript` — 현재 세션 전사 조회
- `meeting_update_summary` — 세션 요약 수동 편집
- `meeting_regenerate_summary` — 요약 재생성

### 세션 목록 / 상세
- `meeting_sessions` — 최근 완료 세션 목록 조회
- `meeting_previous_sessions` — 이전 세션 목록 (페이지네이션)
- `meeting_sessions_by_category` — 카테고리별 세션 필터
- `meeting_session_detail` — 단일 세션 상세 조회
- `meeting_related_sessions` — 연관 세션 조회
- `meeting_link_sessions` — 세션 연결
- `meeting_unlink_sessions` — 세션 연결 해제
- `meeting_update_session_category` — 세션 카테고리 변경

### 카테고리
- `meeting_categories` — 카테고리 목록 조회
- `meeting_register_category` — 새 카테고리 등록

### 사전 등록(Prep)
- `meeting_open_prep` — 회의 사전 준비 화면 열기
- `meeting_register_manual_meeting` — 수동 회의 등록
- `meeting_register_scheduled_meeting` — 예약된 회의 단건 등록
- `meeting_register_scheduled_meetings` — 예약된 회의 일괄 등록
- `meeting_get_prep` — 특정 prep 조회
- `meeting_bulk_upsert_preps` — prep 일괄 upsert
- `meeting_list_preps` — prep 목록 조회
- `meeting_delete_prep` — prep 삭제

### 파일 / UI
- `meeting_upload_file` — 사전 녹음 파일(오디오/비디오) 업로드 후 STT + 요약
- `meeting_open_url` — 외부 URL 열기

## 화면 갱신

`meeting_view_state`로 초기화하고 `meeting_wait_changes` 결과의 cursor를 다음 요청에 전달합니다. 변경이 있으면 목록·상세·전사 snapshot을 다시 읽습니다. waitMs는 0–10000, 기록은 최대 256개, 동시 대기는 최대 16개입니다. 재시작·만료 cursor는 reset을 반환합니다.

## Capabilities
- `meeting-recorder`

## 빠른 사용 예시 (Electron Main Process)
```ts
import { MeetingPipeline, ElectronMeetingRecorder, MockSttProvider, MockSummaryProvider } from "@ave/plugin-meeting";

const pipeline = new MeetingPipeline({
  sttProvider: new MockSttProvider(),
  summaryProvider: new MockSummaryProvider(),
  intermediateEveryFinalSegments: 4,
});

const recorder = new ElectronMeetingRecorder(pipeline);
const sessionId = "meeting-2026-04-08";

recorder.on("intermediate-summary", (payload) => {
  process.stderr.write("meeting intermediate summary ready\n");
});

recorder.on("final-summary", (payload) => {
  process.stderr.write("meeting final summary ready\n");
});

recorder.start(sessionId, { locale: "ko", contextHint: "주간 제품 회의" });

await recorder.pushAudioChunk(sessionId, {
  pcm16leMono: Buffer.from([0x00, 0x01]),
  sampleRate: 16000,
  startSec: 0,
  endSec: 1.5,
});

await recorder.stop(sessionId);
```

## 모듈 구조
- `src/pipeline/meetingPipeline.ts`
  - 세션별 전사 누적
  - 중간 요약 트리거(세그먼트 단위)
  - 최종 요약 생성
- `src/recorder/electronMeetingRecorder.ts`
  - Electron 이벤트 중심 래퍼
  - `segment`, `intermediate-summary`, `final-summary`, `error` 이벤트 제공
- `src/providers.ts`
  - STT/요약 Provider 인터페이스
- `src/adapters/hostLlmSummaryProvider.ts`
  - 호스트 LLM을 통한 요약 Provider (`HostLlmSummaryProvider`). 모든 LLM
    egress 는 host (`hostApi.callLlm`) 를 경유한다.
- `src/adapters/summaryPrompts.ts`
  - 요약 프롬프트/파싱 공유 로직 (`HostLlmSummaryProvider` 사용)
- `src/adapters/openaiWhisperSttProvider.ts`
  - OpenAI Whisper 기반 STT Provider (`OpenAIWhisperSttProvider`)
- `src/adapters/mockProviders.ts`
  - 로컬 테스트용 Mock Provider
- `src/persistence/`
  - `sessionStore.ts` — 세션 데이터 영속화 (JSON)
  - `sessionMetadata.ts` — 세션 메타데이터 관리
  - `categoryStore.ts` — 카테고리 저장소
  - `prepStore.ts` — 회의 사전 등록(Prep) 저장소
- `src/utils/retry.ts`
  - STT/요약 호출용 지수 백오프 retry
- `src/types.ts`
  - 공유 타입 정의

## 요약 Provider 사용 (호스트 LLM 경유)
요약은 호스트에 주입된 `callLlm` 을 통해 현재 설정된 LLM 으로 위임한다 —
익스텐션이 자체 API 키를 들고 직접 vendor 로 egress 하지 않는다 (Tier A
host-mediated egress 계약).
```ts
import { MeetingPipeline, HostLlmSummaryProvider, MockSttProvider } from "@ave/plugin-meeting";

const summaryProvider = new HostLlmSummaryProvider({
  callLlm: context.hostApi.callLlm, // 호스트 주입 — 키/엔드포인트는 호스트가 관리
});

const pipeline = new MeetingPipeline({
  sttProvider: new MockSttProvider(), // 실제 구현으로 교체
  summaryProvider,
});
```

## OpenAI Whisper STT Provider 사용
```ts
import { MeetingPipeline, OpenAIWhisperSttProvider, MockSummaryProvider } from "@ave/plugin-meeting";

const sttProvider = new OpenAIWhisperSttProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-mini-transcribe",
  language: "ko",
});

const pipeline = new MeetingPipeline({
  sttProvider,
  summaryProvider: new MockSummaryProvider(), // 실제 구현으로 교체
});
```

## OpenAI Whisper 화자 분리(Diarization) 사용
```ts
import { MeetingPipeline, OpenAIWhisperSttProvider, toAudioDataUrl, MockSummaryProvider } from "@ave/plugin-meeting";

const sttProvider = new OpenAIWhisperSttProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-transcribe-diarize",
  chunkingStrategy: "auto",
  knownSpeakerNames: ["agent", "customer"],
  knownSpeakerReferences: [
    toAudioDataUrl(Buffer.from([0x01, 0x02]), "audio/wav"),
    toAudioDataUrl(Buffer.from([0x03, 0x04]), "audio/wav"),
  ],
});

const pipeline = new MeetingPipeline({
  sttProvider,
  summaryProvider: new MockSummaryProvider(),
});
```

`gpt-4o-transcribe-diarize` 사용 시 반환 세그먼트의 `speaker` 필드에 화자 라벨이 반영됩니다.

## Marketplace publishing

Extension builds do not create local sidecar signatures. Upload the build artifact
to the Ave marketplace; the marketplace validates and signs the final artifact,
and the host verifies that signed envelope during install.
