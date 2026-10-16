# Changelog  

## [0.10.2] - Unreleased

Removes the retired product name from the plugin. Requires Ave 0.14.0 and
host protocol 3, as before.

### Changed — breaking for local overrides

- The ffmpeg overrides are read as `AVE_MEETING_FFMPEG_PATH`,
  `AVE_MEETING_FFPROBE_PATH`, `AVE_MEETING_FFMPEG_DIR`,
  `AVE_MEETING_FFMPEG_AUTO_INSTALL` and `AVE_MEETING_FFMPEG_VENDOR_URL`.
  A variable exported under the former prefix is no longer read.
- The panel keeps its choices under `ave.meeting.*`: the preferred
  microphone, capture mode, summary length and session category filter
  return to their defaults once.
- The UI root class is `.ave-meeting-ui` and the package name is
  `@ave/plugin-meeting`.

### Fixed

- The `meeting-summary` alert inherits the `work-assistant` choice from the
  official source `ave`. It named a source id the app no longer uses, so a
  still-installed `work-assistant` never held the choice.

## [0.10.0] - Unreleased

Requires Ave 0.14.0 and host protocol 3 (`requires.hostProtocol: "3"`).
Apps that serve protocol 2 (0.12.x, 0.13.x) keep 0.9.3.

### Changed — host protocol 3

- The manifest declares `hostProtocol: "3"` and `minAppVersion: "0.14.0"`.
- The recorder and panel UI read the host's `--ave-*` theme tokens.
- The display name is "Ave Meeting", and host-update messages name Ave.
  Tools, settings, events, the former-prefix `*_MEETING_FFMPEG_*` overrides
  (renamed in 0.10.2) and stored sessions are unchanged.

## [0.9.3] - 2026-10-09

Requires Ave 0.12.0 and host protocol 2 (`requires.hostProtocol: "2"`).
Ave 0.11.x keeps 0.9.0.

### Changed — speech-to-text through host credential leases

- The STT provider gets the OpenAI or Azure key as a host lease
  (`resolveApiKey` with lease exposure) and calls the provider through the
  host's mediated `hostFetch`; the key never enters the extension process.
- One lease per active recording session, shared by concurrent first chunks,
  and released on every terminal path: finished, failed summary, cancel and
  shutdown.
- Direct and staged uploads send at most 15 MiB of audio per multipart
  request, under the host's 16 MiB wire cap; longer audio is segmented.
- Package descriptions use the extension vocabulary.

### Removed — work-assistant relay

- The `work_assistant.calendar.sync.requested`,
  `work_assistant.meeting.prep.requested` and
  `work_assistant.meeting.recording.requested` grants, subscriptions and
  handlers. Calendar automation comes only from ms-graph's calendar events.
  Rows keep work-assistant's `mscal-…` and `wa-…` identities, so preps it
  registered stay the same entries. The `configInherits` and alert migration
  metadata are unchanged.

### Fixed — calendar automation after a restart

- Which meetings already opened their prep or started their recording is kept
  in `calendar-automation-claims.json` through the storage HostApi, not only in
  memory. A restart inside a meeting's 5-minute prep window no longer opens the
  prep again. Each claim expires one hour after its meeting ends and is then
  dropped from the file.

### Fixed — FFmpeg runtime download under host protocol 2

- The managed FFmpeg archive (27–80 MB) comes down through `hostFetch` in
  8 MiB HTTP Range slices, under the host's 16 MiB response ceiling. Slices
  are combined only under one strong ETag and a consistent `Content-Range`;
  an asset replaced mid-download starts over from zero once.
- Every platform's archive is pinned to a dated release and its sha256, and
  is verified before extraction. BtbN builds move from `latest` to the
  September 2026 month-end autobuild. A URL override needs a
  `checksums.sha256` entry in its release.
- The archive is removed from `_downloads` after the install, including when
  its sum or its extraction fails.
- The pinned archive must be exactly its pinned size, and an override is
  capped at 200 MB; both are refused from the first slice, before anything is
  written. Concurrent installs into one data directory (also through a
  symlink) share one install.
- The startup FFmpeg check runs from `onPublished` instead of the factory, so
  a generation that is still preparing no longer logs two
  `plugin_hostapi_denied` warnings on every boot.

## [0.9.0] - 2026-10-09

Requires Ave 0.11.0, the release that carries the host alert contract.

### Added — meeting alerts and calendar automation owned by meeting

- Two alert kinds, both off until you turn them on in the extension's Alerts
  settings: `summary-ready` (title, up to three highlights and action items)
  and `summary-degraded` (summary only). Former work-assistant users inherit
  their meeting-summary choice.
- Calendar automation (`calendarAutomationEnabled`, off by default, turned on
  for former work-assistant users): prep registration from ms-graph's
  `calendar.events.loaded`, `calendar.event.added`, `upcoming` and
  `starting`, a prep five minutes before start and the recorder at start.
  Meeting asks ms-graph for the two-day snapshot when the automation starts.
- Rows, preps and recording sessions keep work-assistant's identities
  (`mscal-…`, `wa-…`), so a work-assistant that is still loaded and meeting's
  own automation register, open and record each meeting once.

### Removed

- The OS notifications for `meeting.summary.created` and
  `meeting.summary.degraded` (`notificationEvents`). Summary notifications
  stop until you turn on the `summary-ready` or `summary-degraded` kind.

### Kept until the follow-on release

- The `work_assistant.*.requested` relay handlers, for a work-assistant that
  is still installed during the transition.

## [0.8.6] - 2026-10-09

### Changed

- Dev: vitest 4 → 5.0.1, ported from the former standalone meeting repository.
- CLAUDE.md points at the current extension contract.

## [0.8.5] - 2026-09-24

### Changed — built in the official marketplace repository

- The source moved into `ken-jo/agent-marketplace` under
  `plugins/<name>/source/`, and releases are built there: the zip is a
  release asset of that repository, pinned by sha256 in the plugin's
  descriptor.
- The plugin SDK is gone. Types and `flattenAgentPluginsManifest` come
  from the host's own contract, vendored at Ave v0.10.0 (the
  `plugin-contract` package, then under the former package scope), and the
  tsup preset from the `plugin-build` package under the same scope.
- `installPolicy` and `publisher` are removed from `plugin.json`: the git
  marketplace installs and locks nothing through a package's own manifest.
- `requires.minAppVersion` is `0.10.0`, the contract this version compiles
  against.

## [0.8.4] - 2026-08-29

### Changed — the manifest drift guards now read the bundled UI

`validate-hostapi.mjs` and `validate-events.mjs` walked TypeScript only, so a
`bridge.callTool("…")` or `bridge.onEvent("…")` in `src/ui/*.js` could name a
tool or event `plugin.json` no longer declares and both guards stayed green.
The host does not: a tool without `"app"` visibility is rejected at the IPC
boundary, and an event no manifest emits is never forwarded to the webview.

Both guards now scan `src/ui/**/*.js` through one shared scanner
(`scripts/ui-bridge-usage.mjs`), so they cannot disagree about what the UI
references. A `bridge.callTool` literal must name a tool carrying `"app"`
visibility. A `bridge.onEvent` literal must name an event the host actually
forwards to the UI: this plugin's own `emittedEvents`, a foreign event listed
in `eventSubscriptions`, or a host broadcast — `host.theme.changed` reaches
every plugin webview from the host itself, so `primeTheme` needs no
declaration and the guard does not demand one. Only string literals are
matched, after comments are stripped; a name built at runtime is not checked,
and optional chaining is treated as the call it is. `test/manifest.test.ts`
reads the same scan instead of its own regex and path list.

Both guards take `--root <dir>`; a named root that has no `plugin.json` or
`src/` is reported (exit 2) rather than treated as nothing to check.

`test/uiBridgeDriftGuards.test.ts` runs both guards as subprocesses against
temp plugin roots (`--root`) and proves each rule fires: dropping a UI-called
tool's `"app"` visibility fails, dropping a UI-subscribed event from
`emittedEvents` fails, and a control root passes.

## [0.8.3] - 2026-08-27

### Fixed — the top tabs no longer divide the panel

The tabs were `flex: 1 1 96px`. Growing tabs are invisible in a narrow panel,
so this survived review; at the panel's 860px cap the two tabs each stretched
to about 430px and the tab bar became two enormous buttons. This is the exact
symptom the host used to compensate for by clamping every plugin panel to a
928px reading column, so removing that clamp is what made it visible.

Tabs now size to their labels (`flex: 0 1 auto`) and still wrap rather than
clip, which is what the shrink factor and `min-width` were always doing. A test
parses the declaration and asserts the grow factor is zero, so the assertion is
about the behaviour and not about how the shorthand is spelled.

## [0.8.2] - 2026-08-26

### Changed — design pass against the host DESIGN.md

A `prefers-reduced-motion` guard (the panel had none, which is a Mandatory
item), focus-visible rings, shadows demoted from hierarchy to elevation, and
Korean body copy lifted off the sub-12px sizes it had been set at.

## [0.8.1] - 2026-08-26

### Changed — the panel adapts to its width

`.mc-inner` was a fixed 580px. It is now fluid up to an 860px cap, and the top
nav wraps instead of clipping.

## [0.7.0] - 2026-08-25

### Changed — the floating recorder is a slot in the host's dock

Requires Ave with `hostApi.attachFloatingPanel`, and the plugin SDK
v12.9.0. There is no fallback: on a host without the dock, `meeting_start`
refuses and says so. A sidebar-only degradation would leave a recording running
with nothing on screen driving it, which is the failure a user cannot see.

**What this gives up.** The recorder used to build its own window — frameless,
transparent, always-on-top, positioned and resized by this plugin — through a
`require("electron")` whose specifier was held in a variable, and drive it over
twelve private `ipcMain` channels. That is Electron's main-process API reached
directly, and it was the last thing keeping this plugin in the host's own
process.

The card now gets a SLOT. Host chrome is always around its pixels, the geometry
is the host's, and the cap is on the whole dock rather than per slot — several
slots could otherwise add up to a full-height overlay. A transparent borderless
always-on-top surface a plugin can place and size freely is a clickjacking
primitive; one framed by host chrome at host-chosen coordinates is not.

Nothing in `src/hostPlugin.ts` resolves `electron` any more. The other user,
`shell.openExternal`, went to `hostApi.openExternalUrl` in 0.6.1.

### Changed — one recorder at a time, stated

The window registry was a `Map<sessionId, BrowserWindow>` that could never hold
two useful entries: the host permits one audio capture at a time, so a second
recorder would watch a recording that could not start. Attaching for a second
session is now REFUSED rather than opening beside the first — ending the
running recording is a decision, and not this code's to make.

That singleton is also the ACL. The IPC handlers resolved the caller's session
from the sender's `webContents.id` and ignored any sessionId in the payload,
so a window could only touch its own recording. Tool calls carry no sender, so
the rule is kept the only way that still holds: the recorder tools act on the
attached panel's session and ignore any sessionId in their arguments.

### Fixed — `meeting_stop` dropped the last seconds of the recording

`meeting_stop` ended the capture through `closeFloatingWindow`, which passes
`flush: false`, so the audio buffered since the last chunk boundary was
discarded before the summary ran. The floating window's Done button had its own
stop implementation that flushed, so the tail survived a click and was lost
whenever the assistant ended the meeting instead — and a recording rarely ends
on a chunk boundary, so this was most meetings stopped that way.

There is one stop path now, and it flushes.

### Fixed — the STT error banner could never appear

The banner was driven by the failure reply to the card's own chunk push, and
the card stopped pushing chunks when the host took over capture. A recording
that was silently not being transcribed — a 429 from the provider, say — showed
nothing at all.

The plugin holds the last ingest failure per session and returns it on
`meeting_recorder_levels`, which the card already polls at the rate chunks
arrive. A successful chunk clears it, so the banner clears itself.

### Removed

- `src/ui/recorder-window.js`, `recorder-window.html`,
  `recorder-window-preload.cjs` — replaced by `src/ui/recorder-card.js`, an
  `embedded-module` served by the host's plugin UI shell.
- The `host.theme.changed` subscription and the private theme channel. The
  shell primes and subscribes theme for the card, as it does for the sidebar; a
  second source for one value means one of them can be stale, and it would have
  been this plugin's.

### Added

- Manifest `ui` entry `meeting-recorder-card` (slot `floating`).
- Eight app-visibility-only tools the card calls: `meeting_recorder_state`,
  `_begin_capture`, `_levels`, `_microphones`, `_restart_capture`,
  `_set_paused`, `_resize`, `_close`. None carries an LLM description —
  enumerating microphones is something the card needs and nothing an assistant
  should be choosing to do.

  `_begin_capture` is separate from `meeting_start` because they are separate
  moments: `meeting_start` attaches the card, and a card cannot ask for audio
  before it exists.

## [0.5.42] - 2026-08-19

### Fixed — await the host keychain read for the plugin STT key

- `hostApi.getSecret` resolves asynchronously, so reading its result directly
  handed the `typeof value === "string"` guard a pending Promise and the saved
  `plugin.<id>.sttApiKey` was treated as absent.
- `apiKeySource=plugin` sessions consequently refused to start with
  `stt-key-unavailable:plugin-stt-key-missing` even with a key in the keychain.

## [0.5.41] - 2026-08-18

### Fixed — reject non-finite chunk timings at the push boundary

- `meeting_push_chunk` now asserts that `sampleRate`, `startSec` and `endSec`
  are finite numbers, and throws naming the offending field.
- Previously an omitted `startSec` became a `NaN` timestamp on the transcript
  segment and only surfaced much later, as a `meeting_transcript` read refused
  by the host's non-finite boundary check with no trace back to the push.
- The guard rejects rather than substituting a default: a chunk with no
  timestamp cannot be placed on the meeting timeline at all.

## [0.5.40] - 2026-08-09

### Fixed — align the sidebar UI with the inline-only host contract

- Remove the retired `ui[].window` size hint so current Ave hosts accept the
  Meeting manifest and render `meeting-control` in the sidebar.
- Keep the plugin-owned floating recorder window unchanged; it is independent
  from the removed host-owned auxiliary-window contract.
- Add a manifest invariant that prevents `ui[].window` from being reintroduced.

## [0.5.39] - 2026-08-03

### Changed — require candidate-scoped event authorization

- Publish the Meeting bundle for Ave app `0.5.11`, where a hidden Marketplace
  candidate is authorized with its own approved Work Assistant event grants.
- Raise `requires.minAppVersion` to `0.5.11` so older hosts cannot reject the
  candidate subscriptions by consulting the incumbent release's grants.

## [0.5.35] - 2026-07-23

### Added — plugin-owned first-run onboarding

- Declare bounded English/Korean first-task copy with explicit priority `10`; acceptance only prefills the visible composer through the host contract.
- Raise `requires.minAppVersion` to `0.5.7` and align the SDK pin to `v11.1.0` for the declarative onboarding schema.

## [0.5.34] - 2026-07-20

### Changed — event-only work-assistant integration and SDK v11.0.0

- Replace the work-assistant integration's direct plugin-tool path with event request/response handling.
- Bump the plugin SDK pin `v8.0.0` → `v11.0.0`; refresh `bun.lock`.

## [0.5.33] - 2026-07-11

### Changed — align to the plugin SDK v8.0.0

- Bump the plugin SDK pin `v7.0.0` → `v8.0.0`; refresh `bun.lock`.
- v8 removed the `runtime/electron` and `runtime/network` shim modules (their behavior moved into the host `hostApi`). This plugin has **no** shim call sites, so this is a pure pin bump — no source changes, no `minAppVersion` floor change.

## [0.5.26] - 2026-06-21

### Fixed — STT egress only through host-mediated fetch (no direct net)

- STT(OpenAI Whisper) 업로드를 플러그인 직접 네트워크 호출에서 host-mediated `hostFetch` 경로로 전환합니다. 플러그인은 더 이상 직접 net 호출을 수행하지 않으며, 모든 egress는 host의 `networkAccess.allowedDomains` 게이트를 통과합니다.
- `plugin.json`에 STT egress 대상 도메인(`openai.azure.com`, `cognitiveservices.azure.com`, `services.ai.azure.com`, `api.openai.com`)을 `networkAccess.allowedDomains`로 선언합니다 (Tier A Phase 1).
- direct-net fallback 제거 후 `hostFetch` 관련 주석을 정정합니다.

> **Publish 전용 버전 범프.** 이 수정(PR #177 host-mediated egress)은 이전에 published 된 v0.5.25 *태그 이후* `main`에 머지되었으나, marketplace 는 SemVer 태그(`plugin.json.version` 일치)로만 publish 되므로 설치된 클라이언트에 전달되지 못했습니다. v0.5.26 은 이미 머지된 #177 수정을 배포하기 위한 것입니다 — *이 PR 자체*는 버전/CHANGELOG 만 바꾸는 publish 전용 변경이며 새 동작 코드를 추가하지 않습니다(동작 코드는 이미 main 에 존재).

#### 검증

- `bun run typecheck`
- `bun test test/apiKeySourceToggle.test.ts`

## [0.5.25] - 2026-06-01

### Fixed — reject endpoint URLs saved as plugin STT API keys

- `apiKeySource=plugin`에서 `sttApiKey` secret 값이 endpoint URL처럼 보이면 Whisper 업로드 전에 차단합니다.
- 해당 오류는 `meeting.error`에 `stt-key-unavailable:plugin-stt-key-is-url` reason으로 남기며, 실제 secret 값은 로그/이벤트에 쓰지 않습니다.
- OpenAI Whisper 파일 업로드 401 응답이 key material을 echo하는 경우 사용자 오류 메시지에서 redaction합니다.

#### 검증

- `bun run typecheck`
- `bun test test/apiKeySourceToggle.test.ts test/openaiWhisperSttProvider.test.ts`
## [0.5.24] - 2026-06-01

### Fixed — boot-time FFmpeg runtime bootstrap for large uploads

- 대형 업로드용 FFmpeg/FFprobe 런타임을 플러그인 부팅 시 현재 OS/arch 기준으로 확인하고, 없으면 `pluginDataDir/vendor/ffmpeg/<platform-arch>/bin`에 백그라운드 다운로드합니다.
- Windows x64/arm64, Linux x64/arm64, macOS x64/arm64 경로를 지원합니다. Windows/Linux는 BtbN LGPL shared build, macOS는 ColorsWind LGPL shared build를 사용합니다.
- 마켓플레이스 artifact에 특정 OS 바이너리를 강제로 묶지 않고, 명시적으로 vendoring한 런타임만 `dist/vendor/ffmpeg`에 복사합니다.
- 대형 업로드 실행 시점에는 다운로드 완료를 기다린 뒤 `ffprobe`/`ffmpeg`를 호출하며, Linux/macOS shared library 경로를 함께 주입합니다.

#### 검증

- `bun run typecheck`
- `bun run test` (285/285)
## [0.5.16] - 2026-05-26

### Changed — `meeting_register_manual_meeting`: agenda 필수 + previousSummary 선택 필드

> rebase 시 main 의 v0.5.15 (api key bug fix, PR #151) 가 이미 점유 — 이 PR 은 v0.5.16 으로 bump.

사용자가 채팅에서 직접 등록하는 manual meeting tool 의 inputSchema 강화. agenda 가 필수로 승격되고, previousSummary 객체 필드를 새로 받습니다. 이미 만들어진 일정을 가져오는 `meeting_register_scheduled_meeting` 과는 별개 — 자동 catch 가 어려운 manual 등록 케이스에 한정.

#### 변경

- `meeting_register_manual_meeting.inputSchema`:
  - `required` 에 `agenda` 추가 (LLM contract 강제)
  - `agenda` items 에 `maxLength: 512`, array `maxItems: 50` 캡
  - `agendaText` (선택 alias) 에 `maxLength: 8192`. agenda 미제공 시 자동 split.
  - `agendaItems` / `meetingAgenda` / `todayAgenda` alias 도 handler 단에서 처리 (scheduled-tool 과 parity)
  - **신규** `previousSummary?: { title?: string, summary: string }` — 같은 주제 직전 회의 요약. `title` `maxLength: 256`, `summary` `maxLength: 16384`. additionalProperties: false.
  - description 갱신: agenda + previousSummary 의미 명시
- `meeting_register_manual_meeting` 핸들러 (`src/hostPlugin.ts`):
  - agenda 누락 시 `throw` 가 아닌 **`{ ok:false, needsAgenda:true, missing:["agenda"], message:"..." }`** 반환 (`needsCategorySelection` 과 동일 fail-soft 패턴). categoryGate 통과 후 평가.
  - `resolveManualMeetingContext` 가 agenda alias 5개 (agenda / agendaItems / agendaText / meetingAgenda / todayAgenda) 모두 수용
  - previousSummary 파싱: Array.isArray 가드 추가 (배열 형태 입력 silent drop), summary 비어있으면 무시, 정상이면 normalised context 에 포함

#### Trade-off

- 기존 LLM 호출이 agenda 없이 manual_meeting 등록 시도하면 needsAgenda fail-soft 응답을 받음. throw 가 아니라 LLM 이 사용자에게 안건을 추가 질문 후 재호출 가능 — UX 단절 없음.
- previousSummary 는 **수동 입력 only** — 같은 카테고리의 자동 직전 요약 첨부 (hydratePrepContext 경로) 는 manual tool 에 적용되지 않음. 향후 parity 작업은 별도 PR (architect follow-up).

#### Self-review (4-agent cycle-1 → fix)

- Static HIGH-1 (Array.isArray 가드 누락) → fix
- Static HIGH-2 (needsAgenda 회귀 테스트 부재) → fix (3 신규 케이스)
- Static HIGH-3 (previousSummary 파싱 테스트 부재) → fix (positive + invalid case)
- Security MED (length cap drift, maxLength 누락) → fix (schema 에 maxLength/maxItems 추가)
- Plugin-audit should-fix (agenda alias parity, CHANGELOG 누락, version bump) → fix
- Architect APPROVE-WITH-NIT — schema description 의 impl note 제거. previousSummary auto-link parity 는 별도 PR.

#### 검증

- typecheck + test + build green (262/262 + 신규 케이스)

## [0.4.20] - 2026-05-20

### Fixed — v0.4.19 의 briefings → preps payload-key 변환 누락 hotfix (issue #122 후속)

#### 진단

v0.4.19 (PR #122) 가 storage 파일 rename (`briefings.json` → `preps.json`) 은 했지만 *payload key 자체는 변환 안 함*. v0.4.18 의 실제 disk 포맷은 `{ briefings: [...] }` 였는데, v0.4.19 의 `migrateLegacyFile()` 은 단순 `renameSync` 만 수행:

```
v0.4.18:  briefings.json = { "briefings": [...] }
v0.4.19:  preps.json     = { "briefings": [...] }   ← payload key 그대로
readMap:  parsed.preps   = undefined               → 빈 Map
list():   []                                       → 사용자 데이터 silent loss
```

**4-에이전트 셀프리뷰 2 round 가 이 버그를 못 잡은 이유**: 3 migration test fixture 가 모두 `{ preps: [...] }` (NEW key) 로 작성됨 — 진짜 v0.4.18 legacy 포맷을 검증 안 함. fixture 자체가 잘못된 가정 위에 있어서 false-pass.

#### Fix

`PrepStore.readMap` 가 두 key 모두 받음:

```ts
const raw = JSON.parse(...) as { preps?: unknown[]; briefings?: unknown[] };
const entries = raw.preps ?? raw.briefings ?? [];
```

자기 치유 메커니즘:
- v0.4.19 broken state 사용자 (preps.json 가 legacy payload 보유 + marker 박힘) → 첫 read 에서 readMap fallback 이 데이터 살림
- 다음 write (upsert / delete) 가 자연스럽게 `{ preps: [...] }` 로 정상 직렬화 → 디스크 normalize
- 별도 second migration / marker reset 불필요

테스트 보강:
- 기존 3 migration test fixture 를 진짜 v0.4.18 포맷 (`{ briefings: [...] }`) 으로 갱신
- 신규 회귀 잠금: "v0.4.19 broken state 복구" — preps.json + briefings payload + marker present → read fallback + write normalize 양쪽 검증

### Cross-plugin 영향

- agent-hub / Ave / work-assistant 모두 옛 이름 (`meeting_*_briefing`, `meeting.briefing.opened`) 호출/구독 0 hits (사전 확인 + v0.4.19 sweep 결과 그대로 유효)
- meeting plugin 단독 변경

### 검증

- typecheck / build PASS
- 232+ tests PASS (legacy fixture 갱신 + 신규 broken-state 회귀 잠금)
- validate:events PASS
- 4-에이전트 셀프리뷰 (Static / Security / Plugin Audit / Architect) No HIGH+

## [0.4.19] - 2026-05-19

### Changed — briefing → prep 이름 변경 + 모든 meeting 도구 description 에 disambiguation anchor 추가

**문제**: LLM 이 사용자 prompt "회의실 예약/조회" 시에도 meeting 플러그인의 5 briefing 도구를 잘못 호출하던 회귀. (1) 도구 이름의 "briefing" 이 회의(meeting) 맥락 외 다른 플러그인 도구군과 어휘 충돌, (2) 도구 description 이 "회의" 키워드만으로 다른 플러그인의 회의실(공간/시설) 자원 도구군과 구분 불가.

**Fix**:
- 5 도구 rename — `meeting_*_briefing` → `meeting_*_prep` (5건). 이벤트 `meeting.briefing.opened` → `meeting.prep.opened` 동반 rename.
- 모든 meeting 플러그인 도구 description 첫 줄에 negative anchor: "이 도구는 회의 *내용·녹음·요약* 용. 회의실(공간/시설 단위 자원) 예약·조회와 무관." — LLM routing 분기 명시.
- 내부 var / class / type / 주석 / UI 한국어 text 일관 sweep.
- agent-hub / Ave / work-assistant 모두 옛 이름 호출/구독 0건 확인. hard rename — compat alias 안 둠.

## Unreleased (#893)

### Changed
- Migrated to SDK v5.13 `hostApi.resolveApiKey({purpose:"stt", vendor:"openai", signal})` — drops ad-hoc `apiKeySource`/`resolveSttApiKey`/`onChange` boilerplate
- Killed silent `MockSttProvider` fallback; surfaces `meeting.error` event when host key unavailable
- Wired AbortController into Whisper fetch (in-flight cancel on stop / permission revoke)

### Security
- Publisher sanitized to a `-community` publisher id under the former name (open-source readiness)

## [0.4.2] - 2026-05-14

### Added
- 통합 환경설정 오버레이: 회의록 ⋯ 메뉴 진입점 "프롬프트 편집" → "환경설정" 로 변경, 오버레이가 **STT 설정** / **프롬프트** 두 탭으로 분리
- 신규 tools — `meeting_update_summary`, `meeting_regenerate_summary`, `meeting_update_ui_config`, `meeting_update_stt_config`, `meeting_get_ui_config`
- `meeting_get_ui_config` 응답에 내장 기본 프롬프트 (`defaultSummaryFinalPrompt`, `defaultSummaryIntermediatePrompt`) 포함 → webview 가 커스텀 입력 칸의 회색 placeholder 로 표시
- 사이드카 영속화 — `<pluginDataDir>/stt-settings.json`, `<pluginDataDir>/prompt-settings.json` (plugin restart 없이 즉시 적용)
- `meeting_upload_file` 사전녹음 파일 업로드 (25MB cap, pre-decode + post-decode 이중 게이트, `safeFileName` 으로 헤더/로그 인젝션 차단)
- `meeting_upload_file` per-session rate-limit (3 calls / 60s)
- `meeting_update_stt_config` 의 `sttBaseUrl` SSRF 검증 (http/https only, hostname 필수, embedded creds 거부, private/loopback 거부)
- `confirmDestructive()` DOM 모달 — destructive uiActions 도구 게이트 (`meeting_update_summary` 저장, `meeting_regenerate_summary` x2)
- `src/ui/meeting-control.html` CSP `<meta>` 추가 (`recorder-window.html` 정책 미러)
- `test/hardeningGuards.test.ts` — 58개 가드 테스트 추가

### Changed
- `plugin.json`: `packageName` 추가 — 옛 패키지 스코프의 `plugin-meeting` (마켓플레이스 매핑)
- `plugin.json`: `meeting_propagate_theme` inputSchema 강화 (bundleId/shell/tokens enum + `additionalProperties: false`), category `write` → `read` (transient fanout)
- `plugin.json`: `meeting_open_url` category `network` → `read` (host 가 OS 핸드오프만 수행)
- `plugin.json`: 신규 4개 write 도구에 `pathFields: []` 명시
- `plugin.json`: `configSchema.sttApiKey` 에 `format: "secret"`
- `plugin.json`: main-process 핸들러가 없던 `eventSubscriptions[host.theme.changed]` 제거 (webview 측 `bridge.onEvent` 가 처리)
- `package.json`: 사용하지 않는 `openai`/`ws` 를 `peerDependencies` + `devDependencies` 양쪽에서 제거 (어댑터는 `fetch()` 직접 사용)
- `src/hostPlugin.ts`: local `HostPluginContext` shadow type 제거 → the plugin SDK 의 `PluginRuntimeContext` 채택 (SoT 일원화)
- `src/hostPlugin.ts`: 사용 안 하던 `OpenAISummaryProvider` / `MockSummaryProvider` fallback 경로 삭제 — 단일 `HostLlmSummaryProvider` 경로

### Fixed
- `meeting.transcript.updated` 페이로드 키 `meetingId` → `sessionId` (다른 lifecycle 이벤트와 parity, agent-hub/calendar 등 downstream 구독 정상화)
- floating recorder window: `window.host.start` 실패 또는 `{ ok: false }` 시 silent 진행 대신 capture badge 에 에러 메시지 표시 후 즉시 return
- "No Fallback Code" optional-chain 일괄 제거 — `hostApi.config?.get`, `hostApi.logEvent?.(...)` 35+ 사이트, `hostApi.callLlm` 분기, `hostApi.onShutdown?.()` 모두 required 로 사용

### Security
- **STT API key 암호화**: Electron `safeStorage` (당시 옛 패키지 스코프 plugin SDK 의 `runtime/electron` 진입점) 로 sidecar 에 ciphertext + mask 만 저장. 기존 plaintext 사이드카 자동 감지 → 1회 마이그레이션. `safeStorage` 없을 때 plaintext 키 저장 거부
- legacy `.meeting-sessions` host-root 마이그레이션을 `<pluginDataDir>/.legacy-migration-done` marker 로 게이트 → 반복 호스트 네임스페이스 스캔 제거 (CLAUDE.md "Storage Namespace per Feature" 준수)
- floating recorder window 의 자동 `webContents.openDevTools({ mode: "detach" })` 제거 — production 빌드에서 DevTools 가 열리는 회귀 차단

## [0.4.4] - 2026-05-14

### Changed
- Removed internal UI/theme relay tools from `tools[]`, `uiActions[]`, and `toolSchemas`.
- Sidebar UI now reads render-only preferences through `bridge.config`.
- Floating recorder windows now receive host theme changes through the host plugin service loop and private IPC.

## [0.3.1] - 2026-05-09

### Changed
- `plugin.json`: declare `toolSchemas[*].category` for Q12 permission policy (read=5, write=8, meta=3)
  - read: meeting_list_briefings, meeting_get_briefing, meeting_sessions, meeting_session_detail, meeting_transcript
  - write: meeting_start, meeting_stop, meeting_cancel, meeting_push_chunk, meeting_upload_file, meeting_propagate_theme, meeting_bulk_upsert_briefings, meeting_delete_briefing
  - meta: meeting_open_url, meeting_open_briefing, meeting_open_floating_window

## [0.2.2] - prior
- Initial stable release
