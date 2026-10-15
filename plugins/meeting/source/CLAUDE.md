# Meeting Plugin — Claude Code Directives

## Architecture Reference

The extension contract is `../ave/docs/design/plugin-hostapi-protocol.md` and the
"Extension Runtime" section of `../ave/docs/architecture/architecture.md`.
Current status and blockers: `../TODO.md`.

## Project Structure

```
src/
  hostPlugin.ts          — Plugin entry (self-registration via HostApi)
  index.ts               — Barrel exports
  types.ts               — TranscriptSegment, MeetingContext, Summary types
  providers.ts           — SttProvider, SummaryProvider interfaces
  pipeline/
    meetingPipeline.ts   — Core orchestration (session state, retry, summary triggers)
  recorder/
    electronMeetingRecorder.ts — Event emitter wrapper for Electron
  adapters/
    openaiWhisperSttProvider.ts — Whisper STT (multi-model, diarization)
    hostLlmSummaryProvider.ts   — Summary via host LLM (hostApi.callLlm; structured JSON output)
    mockProviders.ts            — Mock STT/Summary for testing
  persistence/
    sessionStore.ts      — JSON file session persistence + crash recovery
  utils/
    retry.ts             — Exponential backoff with rate-limit handling
  ui/
    meeting-control.html — UI template
    meeting-control.js   — UI controller (sidebar slot)
```

## Key Design Decisions

- **Error handling**: STT/Summary providers THROW on error (never swallow with empty return)
- **Retry**: Pipeline-level retry (3x STT, 2x summary), NOT provider-level
- **Model detection**: `whisper-1` uses `verbose_json`, newer models use `json`
- **Diarization**: `gpt-4o-transcribe-diarize` model → speaker field in segments
- **Session persistence**: JSON files via SessionStore, crash recovery via `listUnfinished()`

## HostApi Contract

This plugin registers itself through `context.hostApi`:
- Canonical method IDs: `meeting_start`, `meeting_push_chunk`, `meeting_stop`, `meeting_transcript`, `meeting_sessions`
- Events emitted: meeting.started, meeting.ended, meeting.summary.created, meeting.error
- Summary persistence: final summary is written to local `SessionStore`
  (JSON file under `pluginDataDir`); not via `hostApi.saveNote`. UI reads
  back via `meeting_session_detail`.
- Tasks: meeting plugin no longer creates host tasks (host TaskService removed).
  Action items are broadcast as part of `meeting.summary.created` payload
  (`actionItems` field) for downstream consumer plugins to surface.

## TODO Tracking

Update `../TODO.md` only when the change completes, discovers, or alters a tracked item;
keep per-change detail in the PR.
