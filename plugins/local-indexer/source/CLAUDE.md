# Local Indexer Plugin — Claude Code Directives

## Architecture Reference

The extension contract is `../ave/docs/design/plugin-hostapi-protocol.md` and the
"Extension Runtime" section of `../ave/docs/architecture/architecture.md`.
Current status and blockers: `../TODO.md`.

## Project Structure

```
src/
  hostPlugin.ts        — Host integration (chat preview + ranking)
  localIndexerPlugin.ts   — Python worker bridge (spawn over worker stdio control v1, readiness, restart)
  workerClient.ts      — One `handle.request` per worker method
  egressBroker.ts      — Answers the worker's egress_embedding / egress_caption requests via hostFetch
  indexMigration.ts    — 0.8.0 rebuild into the worker state directory; old index removed only after verification
  folderIndexer.ts     — Folder auto-scanner (30s polling, mtime detection)
  types.ts             — Public interfaces
  index.ts             — Barrel exports
  ui/
    indexer-control.html — UI template
    indexer-control.js   — UI controller (sidebar slot)
worker/
  local_indexer_worker.py — Worker entrypoint: asyncio stdin dispatcher + method table (logs to stderr only)
  stdio_control.py        — NDJSON JSON-RPC 2.0 peer (hello, cancel, shutdown, EOF)
  stdio_egress.py         — httpx2 transport that relays provider SDK calls to the plugin
  local_indexer.py        — Layer A parse + Layer B index pipeline
  local_indexer_search.py — BM25 + vector + RRF search
python-requirements.in/.lock — Python runtime deps (compiled via `uv pip compile`; shipped)
python-test-requirements.txt — test-only Python deps (pytest; not shipped)
```

## Architecture: 2-Layer Design

- **Layer A (Basic Parsing)**: File Watcher + Document Parser → raw text + metadata
- **Layer B (Intelligent Indexing)**: FTS5 (BM25) + Vector (lancedb) + Hybrid Ranker (RRF)

Current state: Layer B via Python subprocess. Layer A already covers
PDF, DOCX, PPTX, XLSX, HTML, Markdown, and TXT.

## Key Gaps

- Remaining parser backlog: CSV normalization, Image OCR
- SQLite FTS5: delegated to Python, not accessible from TypeScript
- Expand integration coverage around worker failure/recovery paths

## Phase Plan

- Phase 1 (current): Python subprocess for the local index core
- Phase 2 (future): Core logic Rust porting review

## TODO Tracking

Update `../TODO.md` only when the change completes, discovers, or alters a tracked item;
keep per-change detail in the PR.
