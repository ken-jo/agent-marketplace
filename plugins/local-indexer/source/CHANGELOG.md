# Changelog

## [0.7.0] - Unreleased

Requires Ave 0.14.0 and host protocol 3 (`requires.hostProtocol: "3"`).
Apps that serve protocol 2 (0.12.x, 0.13.x) keep 0.6.9.

### Changed — host protocol 3

- The manifest declares `hostProtocol: "3"` and `minAppVersion: "0.14.0"`,
  the Python runtime as `managedBy: "ave"`, and the path-bearing tool
  arguments under the `ave/pathFields` annotation.
- The host home comes from `PluginRuntimeContext.aveHome`; the default
  home, the corporate CA path and the Kiwi user dictionary move from
  `~/.ave` to `~/.ave` with the host.
- The panel reads the host's `--ave-*` theme tokens.
- The display name is "Ave Local Indexer". Tools, settings, events and
  stored data are unchanged.

## [0.6.9] - 2026-10-09

Requires Ave 0.12.0 and host protocol 2 (`requires.hostProtocol: "2"`).
AVE 0.11.x and earlier keep 0.6.8.

### Changed — provider egress through per-request leases

- The embedding and caption broker resolves a host key lease for each provider
  request, sends it through `hostFetch`, buffers the response and releases the
  lease. The Python worker receives only its broker token. A revoked or
  cancelled lease ends the request; it does not fall through to another
  transport. The OpenAI SDK's built-in retries are off in broker mode, so
  only the worker's own retry policy applies.
- Startup and warm-up claim provider presence only when the host issued an
  embedding lease.
- The manifest declares its sandbox: read access to the runtime and CA bundle
  directories, write access to the user-chosen `indexStorageRoot` and
  `workspace` directories (both new string settings; empty keeps the default
  location).

### Added — alerts

- Two summary-only alert kinds, off until you turn them on in the extension's
  Alerts settings: `index-scan-completed` and `index-folders-changed`. They
  carry no local paths. The nightly-rescan suggestion is declared in
  `alerts.suggestions`.

### Removed

- The OS notifications for `index.scan.completed` and
  `index.folders.changed` (`notificationEvents`), which Ave 0.12.0 no longer
  accepts. The bus events are unchanged.

## [0.6.8] - 2026-10-09

### Changed — dependency bumps ported from ave-plugin-local-indexer

- Python worker: openai 2.54.0 → 3.14.1. openai 3 uses HTTPX2 and no
  longer installs `httpx`, so the egress-broker Unix-socket transport in
  `worker/embedding_client.py` moved to `httpx2` (now a direct dependency,
  2.13.1). `test/egress_broker_uds_transport.test.py` drives the real SDK
  over the socket.
- Python worker: lancedb 0.37.1 → 0.38.0, pillow 12.1.1 → 12.3.0,
  pyarrow 25.0.0 → 25.0.1, uvicorn 0.52.4 → 0.53.0. The lock is
  regenerated with `uv pip compile`.
- Dev: vitest and @vitest/coverage-v8 4 → 5.0.1.

## [0.6.7] - 2026-09-24

### Changed — built in the official marketplace repository

- The source moved into `ken-jo/agent-marketplace` under
  `plugins/<name>/source/`, and releases are built there: the zip is a
  release asset of that repository, pinned by sha256 in the plugin's
  descriptor.
- `@ave/plugin-sdk` is gone. Types and `flattenAgentPluginsManifest` come
  from the host's own contract, vendored at ave v0.10.0
  (`@ave/plugin-contract`), and the tsup preset from `@ave/plugin-build`.
- `installPolicy` and `publisher` are removed from `plugin.json`: the git
  marketplace installs and locks nothing through a package's own manifest.
- `requires.minAppVersion` is `0.10.0`, the contract this version compiles
  against.

## [0.6.6] - 2026-09-04

### Fixed

- The Python worker outlived a host that died abnormally (SIGTERM, crash,
  `kill`): it was reparented to the init process and kept serving forever,
  one orphan per past host run. The host now spawns the worker with stdin as
  a liveness pipe — it carries no bytes and the OS closes it only when the
  host process is gone, in every death mode — and the worker watches that
  handle: on EOF it stops the server the way `/shutdown` does (WAL
  checkpoint, storage close) and exits after a short grace period even if
  the server is wedged. Whether the pipe is present is read from the handle
  itself (the socketpair end Node hands the child on macOS/Linux or the
  named pipe on Windows arms the watchdog; a character device such as
  `/dev/null` does not, since it reaches EOF immediately), so a host that
  still spawns with stdin ignored is unaffected.

## [0.6.5] - 2026-09-03

### Changed

- The document tools belong to this plugin alone. The `worker-client`
  capability and the `getWorkerClient()` the plugin object handed the host are
  both gone: the plugin runs out of process, so the host only ever leased a
  proxy that carried no such function, and its own knowledge tools were skipped
  on every boot while the capability declaration made the skip read as a plugin
  defect. Nothing on the host side consumed the handle, so removing it costs no
  behaviour — the same worker client still backs every `index_*` handler from
  inside the plugin.
- `index_get_document` takes `includeStructure`, which returns the page numbers
  that actually carry indexed chunks. That inventory is what the retired host
  `document_structure` tool returned, and it is not a restatement of
  `doc.pageCount`: pages the parser dropped never appear in it, so a caller
  picking a `pages` range no longer spends a round trip on a page the index does
  not hold. It stays an option on the existing tool rather than a seventh tool,
  because the model-visible surface is a deliberate six.

### Fixed

- The egress broker bound a Unix-domain socket on every platform, so on
  Windows the plugin never became healthy: `server.listen({ path })` there is
  a named pipe, whose address has to live under `\\.\pipe\`, and libuv refuses
  a filesystem path with `EACCES` — leaving no socket file behind, which is how
  the failure was told apart from an NTFS permission problem. How the broker
  binds is now one decision made from the platform: loopback TCP on an
  ephemeral port for Windows, the Unix socket in the host-registered directory
  everywhere else, where a confined plugin child cannot bind loopback at all. On
  the TCP transport the worker is handed the real bound URL and no socket path,
  which is the address its provider SDKs already dial when no socket is pinned;
  the per-session token is checked before any routing on both transports, so
  the loopback port is no more reachable than the socket. `pluginSocketDir` is
  required only on the platforms that bind a socket in it. (#272)

## [0.6.3] - 2026-08-29

### Fixed

- The image captioner labelled any file with an unknown extension as
  `image/png` and forwarded it whole. It now accepts only `.png`,
  `.jpg`/`.jpeg` and `.webp` — `.gif` is dropped, because the providers take
  only non-animated GIF and the magic bytes cannot tell the two apart —
  refuses a file over 20 MB (Azure OpenAI's per-image vision limit, applied
  to both providers) on `st_size` before reading it and again on a bounded
  read, so a file still growing under a watched folder cannot slip past the
  stat, and refuses a body whose magic bytes do not match its extension. A
  caption model is validated
  against the naming rule of the provider that will receive it (OpenAI model
  id, or Azure deployment name) before any SDK client is built. The BLIP
  `local` provider, unreachable since the local indexer was removed, is
  deleted along with its `transformers`/Pillow imports. (#111)
- `set_image_captioning` read an empty `model` as "keep current", so a
  provider switch pushed with the new provider's default (`""`) carried the
  previous provider's model — and endpoint, and api-version — across.
  Those three fields are now tri-state on the wire: `null`/omitted keeps,
  `""` resets to the provider default, a value sets. The host already sends
  every field on every push; `WorkerClient.setImageCaptioning` now types
  them as `string | null` with no defaults so a caller decides. On the host
  side an Azure value that is *derived* from the host key handle and could
  not be derived (the handle is refused transiently) is sent as `null`,
  keep — only an empty value the user configured is sent as `""`. The
  removed `local` provider is gone from the enum on both sides. (#112)

### Changed

- CI runs the Python worker suite (`pytest test/`, Python 3.12, locked
  dependencies via uv) alongside the shared TypeScript job; until now only
  the retrieval gate ran. `pillow` is declared directly — openpyxl only
  reads workbook images when it is importable, so the XLSX image path had
  never run. A test that removed the SQLite parent directory with `rmdir`
  assumed no WAL sidecars and failed on every platform; it removes the tree.
  (#113)

## [0.5.36] - 2026-08-24

### Fixed

- The image-caption radio labels in the settings panel showed mojibake instead
  of Korean. They were written that way in `dac772a` and have been wrong in
  every release since.

### Changed

- Run the shared `plugin-ci.yml` from `former_org/.github` instead of the
  copy of it that lived in this repo. The copy had drifted: unpinned action
  refs (`@v7`, `@v2.2.0`), a GitHub-hosted runner instead of the CI runner
  group, and no job timeout.

## [0.5.35] - 2026-08-24

### Changed

- Pin the shared reusable workflows to `6200e124`, a commit that is still
  reachable. The previous pins were orphaned by a history rewrite in
  `former_org/.github`, so every Actions run — including the `0.5.34` publish
  — died in 0s with *workflow was not found*. The workflow files are
  byte-identical at the old and new SHAs; only the name of the commit changed.
- Move the `@ave/plugin-sdk` devDependency pin to `v12.1.0`, the first release
  carrying the loopback grant `plugin.json` relies on. This supersedes the
  unpublished `0.5.34`, whose contents it otherwise matches.

## [0.5.34] - 2026-08-24

### Fixed — the `embeddingEndpoint` setting can reach a local server

- The setting exists for an OpenAI-compatible endpoint the user runs themselves
  (LM Studio, LiteLLM, an internal proxy), and the plugin already accepted
  `http://` loopback for `embeddingProvider="openai"`. The host did not: every
  request went out through `hostApi.hostFetch`, which was https-only over an
  allow-list that could not spell a loopback host, so the endpoint was denied
  before it was reached and every document ended in a 504.
- `networkAccess.allowedDomains` now declares `localhost`, `127.0.0.1` and
  `::1`. That declaration is the grant: the host permits cleartext http to those
  hosts only because they are named here, and only after proving the name
  resolves to loopback and nothing else. It opens neither the LAN nor any other
  host, and the host key is still withheld from a local endpoint — only the
  plugin's own key may be forwarded there.
- Raise `requires.minAppVersion` to `0.6.3`, the first app release whose
  manifest validator accepts the loopback literals.

## [0.5.33] - 2026-08-19

### Fixed — await the host keychain read for provider API keys

- `hostApi.getSecret` resolves asynchronously, so reading its result directly
  handed the `typeof s === "string"` guards a pending Promise: both the
  plugin-own slots (`embeddingApiKey` / `imageCaptionApiKey`) and the brokered
  host slots (`llm.apiKey.openai` / `llm.apiKey.azure-foundry`) read as absent.
- Scans silently degraded to BM25-only and the settings panel reported no API
  key for a key the user had saved.
- The egress channel thunk resolves its key host-side per request, so it now
  returns a promise; the broker's request handler already awaited its work.

## [0.5.31] - 2026-08-03

### Changed — require atomic host-managed Python candidate activation

- Publish the Local Indexer bundle for Ave app `0.5.11`, where Marketplace
  candidates receive their host-managed Python executable before activation.
- Raise `requires.minAppVersion` to `0.5.11` so older hosts cannot install this
  release and fail during the hidden candidate start.

## [0.5.26] - 2026-07-23

### Added — plugin-owned first-run onboarding

- Declare bounded English/Korean first-task copy with explicit priority `20`; acceptance only prefills the visible composer through the host contract.
- Raise `requires.minAppVersion` to `0.5.7` and align the SDK pin to `v11.1.0` for the declarative onboarding schema.

## [0.5.23] - 2026-07-11

### Changed — align to `@ave/plugin-sdk` v8.0.0

- Bump SDK pin `github:former_org/ave-plugin-sdk#v7.0.0` → `#v8.0.0`; refresh `bun.lock`.
- v8 removed the `runtime/electron` and `runtime/network` shim modules (they moved into the host's `hostApi`). This plugin has **no** shim call sites, so this is a pure pin bump — no source changes, no `minAppVersion` floor change.

## [0.5.18] - 2026-06-29

### Fixed
- **P1 — ledger parent-dir created with 0o700.** `writeRescanLedgerProposed`
  previously called `mkdir(dirname, {recursive:true})` without a `mode`,
  leaving the directory world-readable when created fresh (umask ~0o755).
  Now passes `{recursive:true, mode:0o700}` to match the storage-namespace
  rule (dirs 0o700, files 0o600). The ledger file was already written 0o600.
- **P2 — `countRegisteredFolders` base-path consistency.** `folders.json`
  entries were resolved via bare `resolve(f.trim())` (against `process.cwd()`),
  while `scanFolders` are resolved against `context.hostRoot`. A relative
  folder present in both sources would not deduplicate in the `Set`, inflating
  the count. Now both sources are resolved against `context.hostRoot` so the
  dedup is correct.
- **P3 — `rate_limited` no longer locks the propose-once ledger.**
  Previously `isStagingSuccess` treated `rate_limited` the same as `duplicate`,
  recording `proposedAt` and permanently suppressing future proposals. A
  rate-limited overlay may never have surfaced to the user; locking the ledger
  for it loses the proposal forever. `rate_limited` now falls through to the
  transient-denial path (alongside `capability_denied`, `invalid_source`,
  `loop_unavailable`) so the next wakeup retries. Only `accepted` and
  `duplicate` (overlay actually staged/deduped) lock the ledger.

## [0.5.17] - 2026-06-29

### Fixed
- **minAppVersion corrected to `0.4.2`.** 0.5.16 declared `minAppVersion: 0.5.0`
  as a forward reference, but the host capabilities this plugin depends on
  (`hasRoutineBySource`, the routine `source` marker, and session-scoped
  on-demand plugin activation) shipped in ave **0.4.2** (released
  2026-06-29). The 0.5.0 floor would have made the plugin refuse to install on
  the released app. `0.4.2` is the first released app version containing those
  capabilities (capability-before-publish ordering).

## [0.5.16] - 2026-06-29

### Added
- **Daily Help suggestion to set up a nightly rescan routine.** On launch, if
  there are registered folders, no existing rescan routine
  (`hasRoutineBySource`), and the suggestion has not been proposed before, the
  plugin proposes (via `triggerConversation`) a once-daily 22:00 routine that
  runs `index_scan` (incremental: mtime + content-hash short-circuit + orphan
  sweep). Accepting it creates an `llm-session` routine (leaves session history
  + a per-run summary). Propose-once: never re-proposed once a routine exists or
  the suggestion was shown (ledger at `~/.ave/plugins/local-indexer/`). The
  routine's prePrompt requests on-demand activation (`request_plugin`) if the
  plugin is disabled at fire time. Requires the host capabilities in app 0.4.2.
  Adds `host:overlay` + `lifecycle-observer` capabilities; re-pins the SDK to
  v5.19.0 (`hasRoutineBySource`).

## [0.5.15] - 2026-06-28

### Security
- **Host-mediated egress broker — remove the provider key from the Python
  worker (P3 ⑬).** The worker is untrusted for credentials (it parses
  attacker-controlled documents and runs a large transitive dependency tree
  in-process). It previously held the real provider key in memory across four
  holders and could open arbitrary outbound sockets. The new `EgressBroker`
  (`src/egressBroker.ts`, owned by `AveLocalIndexerPlugin`) closes both:
  - The plugin starts a loopback broker BEFORE spawning the worker and passes
    the worker only the broker base URL (`--egress-broker-url`) plus a
    per-session token (pushed over the control channel). The worker's four
    credential holders now carry only the token, never the provider key.
  - The worker addresses `<base>/egress/embedding` and `<base>/egress/caption`
    and can supply only `{ path-remainder, body }`. The broker resolves the
    upstream host **host-side per channel** (trusted defaults or the
    SSRF-validated custom endpoint), so a compromised worker cannot redirect
    the credential to an attacker host.
  - The broker reuses the P0 trust chokepoint verbatim
    (`resolveEmbeddingKeyForEndpoint` / `resolveCaptionKeyForEndpoint`): a
    custom untrusted endpoint still receives the plugin-own key, never the
    host key.
  - Token auth via `x-ave-egress-token` + `crypto.timingSafeEqual` (missing /
    wrong ⇒ 403, blocking other local processes). The broker uses an
    allow-list to drop all worker-supplied headers (preventing gzip-confusion
    attacks and arbitrary header injection) then injects the real provider auth
    host-side, auth-scheme aware per channel (OpenAI `Bearer`, Azure OpenAI
    `api-key`). The real key never appears in a response body returned to the
    worker. `node:https.request` does not auto-follow 3xx redirects, so a
    rogue upstream cannot steal the injected key via Location.
  - A host-side allow-list gate (`isTrustedEndpointUrl` or the validated custom
    endpoint) refuses any non-allow-listed upstream (403). Corporate-CA trust
    moved to the broker's upstream client (it terminates provider TLS now), and
    the worker's `OPENAI_API_KEY` dev opt-in is gated OFF when a broker is
    configured (it must not bypass the broker).
  - Transport-switchable from day one (loopback TCP for the MVP, UDS-ready) so
    the ASRT/netns end state is an additive flip, not a rewrite.

### Changed
- **Route renamed `/indexer/set_embedding_api_key` → `/indexer/set_egress_token`**
  (body field `api_key` → `token`) for honesty — the worker↔host contract moves
  together in this single-repo change. The pushed value is the broker token in
  broker mode (the embedding key on the legacy no-broker path).

## [0.5.14] - 2026-06-28

### Changed
- **Rebuilt the retrieval eval gate to MEASURE real embedding/reranker/OCR
  quality (Stage-0).** The old gate injected a fake `DeterministicEmbedder`
  (256-dim char-trigram) over a 25-doc, ceiling-saturated corpus, so its
  Recall@10 = 0.975 / nDCG@10 = 0.9584 measured ONLY the lexical path
  (Kiwi + FTS5 + RRF) — it said nothing about embedding quality. Citing it as an
  embedding-quality number was the over-claim caught in P1 #187. The gate is now
  split into two:
  - **Real-embedding env hook** in `eval/run_eval.py`: `build_embedder()` uses
    the production `OpenAIEmbeddingClient` (the worker's real
    `embedding_client.py`) when `EVAL_EMBEDDING_ENDPOINT` (+
    `EVAL_EMBEDDING_API_KEY`, optional `EVAL_EMBEDDING_MODEL` /
    `EVAL_EMBEDDING_DIMENSIONS`) is set, and falls back to the offline
    `DeterministicEmbedder` when it is not (so the default/offline PR gate runs
    with no key). `run()` takes an `embedder` DI seam; the result records which
    embedder ran.
  - **De-ceiling corpus**: grown 25 → 118 docs (117 Korean-heavy `.md` across 12
    vocabulary clusters + 1 OCR-target `.txt` fixture) and 20 → 43 graded
    queries (incl. paraphrastic queries whose gold doc is not the trivial top
    lexical hit). The lexical baseline is now **recall@10 = 0.7558 /
    nDCG@10 = 0.7117** — intentionally NOT saturated, leaving headroom to
    MEASURE an embedding/reranker lift on the nightly job.
- **Relabeled the deterministic gate** (`test/retrieval_eval.test.py`) as the
  **lexical-path regression guard ONLY** — it now injects `DeterministicEmbedder`
  explicitly (hermetic regardless of env) and asserts so, and its docstring +
  `eval/README.md` state it does NOT measure embedding/reranker/OCR quality.

### Added
- **Nightly real-embedding CI job** (`.github/workflows/retrieval-eval-real.yml`)
  — runs `run_eval.py` with the real embedding client on a schedule (03:00 KST)
  and on demand, records real Recall@10 / nDCG@10 as an artifact + job summary,
  and **skips gracefully** when no `EVAL_EMBEDDING_API_KEY` / `OPENAI_API_KEY`
  secret is present. A maintainer must add that secret (Settings → Secrets) to
  enable nightly real-embedding measurement.
- OCR-target text fixture `eval/corpus/ko-108-scanned-expense-receipt-ocr.txt`
  + query `q-ko-36` so the OCR recall path can be measured once OCR lands.
- `test/eval_real_embedding_hook.test.py` — covers the env hook (deterministic
  fallback without a key; real client correctly configured when the endpoint is
  set, verified config-only with no network call).
- `eval/README.md` runbook: the two-gate split, how to run the real-embedding
  eval locally, how to add corpus docs/queries, and the nightly-secret setup.

## [0.5.13] - 2026-06-28

### Fixed
- **DOCX page=1 collapse — boundary-loss bug fixed.** `_parse_docx` previously
  extracted all text from every page of a `.docx` file but assigned it all to
  `page=1`, losing page-boundary information. All content was indexed (no text
  was dropped) but every chunk reported the wrong page number, making page-level
  search results misleading for multi-page documents.

  The parser now uses python-docx ≥ 1.2.0 to detect page boundaries in two
  complementary passes across body children (paragraphs + tables in document
  order):
  - **Rendered breaks** (`w:lastRenderedPageBreak`): detected via
    `Run.iter_inner_content()` yielding `RenderedPageBreak` objects — written by
    Microsoft Word on save.
  - **Hard breaks**: `paragraph.paragraph_format.page_break_before` and
    `<w:br w:type="page"/>` runs — produced by LibreOffice, Google Docs export,
    and `python-docx`'s `add_page_break()`.

  When zero breaks of either type are detected (single-page or freshly generated
  DOCX without explicit markers), the document is treated as a single page and
  the condition is logged (`indexer.docx.no_page_breaks`) rather than silently
  discarded.

  python-docx is a pure-Python wheel with no native extensions. The
  `default.docx` template resource inside the wheel is not a native binary;
  installation succeeds under standard corporate EDR policies.

### Added
- `python-docx >= 1.2.0` to `python-requirements.in`.
- `test/docx_parser.test.py` — 13 new tests covering hard breaks,
  `page_break_before` format, no-break fallback + log, table content on correct
  page, no content loss, and end-to-end `index_file` page-count assertion.

## [0.5.12] - 2026-06-28

### Added
- **Boot reconcile pass — heal SQLite↔LanceDB vector drift.** On startup the
  host now calls `POST /indexer/reconcile` to detect and heal the residual
  crash window that the content-hash-after-Lance ordering narrows but cannot
  fully close: `index_file` commits `content_state='ok'` + the
  `embeddings_meta` rows BEFORE the Lance upsert, so a SIGKILL / OOM /
  power-loss between the sqlite commit and the Lance upsert leaves
  `embeddings_meta` rows whose `chunk_id` has NO Lance vector (and the doc
  silently has no vectors until something touches the file).
  - `LocalIndexer.reconcile()` compares the `embeddings_meta` chunk-id set
    against the Lance chunk-id set, both directions:
    **meta-without-vector** → the owning doc is marked for re-embed
    (`content_hash` forced NULL + `content_state='embed_failed'`) and returned
    to the host; **orphan vector** (a Lance chunk-id with no `embeddings_meta`
    row) → deleted from Lance.
  - Detect is **key-free** (detect + normalise only, no embedding); **heal**
    (re-embedding the drifted docs via a bounded reindex) runs lazily in the
    background warmup AFTER the warmup embedding-key push, and is **deferred**
    when no key is available yet (docs stay BM25-only until a future cycle).
    The re-embed is bounded to **50 drifted docs per cycle** to cap the cost on
    large drift; the remainder heal on the next startup.
  - Honest `embed_failed` docs carry no `embeddings_meta` rows, so they are
    never falsely flagged. `embeddings_meta` is the drift sensor and is **kept**.
- `_LanceVectorStore.list_chunk_ids()` — column-pruned enumeration of the
  chunk-ids that actually have a vector in Lance.
- `WorkerClient.reconcile()` + the `/indexer/reconcile` worker route.

## [0.5.11] - 2026-06-28

### Added

- **Configurable file-size guardrail (`maxFileSize`, default 50 MB).**
  Files exceeding the limit are recorded as `status='failed'` in the index
  and surfaced to the user as an explicit failure — not silently skipped.
  The limit, the actual file size, and the configured cap are all included
  in the error string so the failure is immediately actionable.
  Configurable via `plugin.json` configSchema (`maxFileSize`, integer bytes;
  `0` disables the check). Passed to the worker as `--max-file-size`.

- **Configurable chunk-count guardrail (`maxChunksPerDoc`, default 2000).**
  Documents that generate more chunks than the cap are truncated to the cap.
  The truncation is recorded explicitly in `IndexResult.errors[]` so it
  surfaces to the user rather than being a silent drop. Truncated documents
  are still indexed (the leading chunks remain fully searchable) and return
  `status='indexed'` — an outright failure is inappropriate here because
  partial indexing is better than no indexing for large documents.
  Configurable via `plugin.json` configSchema (`maxChunksPerDoc`, integer ≥ 1).
  Passed to the worker as `--max-chunks-per-doc`.

  **Enforcement points:**
  - `LocalIndexer.index_file()` — file size check before any parsing
    (`os.path.getsize` called once, result in `indexer.file.oversize` log event).
  - `LocalIndexer.index_file()` — chunk count cap applied after `_chunk()`,
    before tokenisation, embedding, and persistence.

  **No scan-concurrency cap** — the host scan loop (`folderIndexer.ts:370`)
  is already serial; there is no concurrency to cap.

## [0.5.10] - 2026-06-28

### Changed
- **Eager background indexing — dropped the vestigial worker queue and the
  idle-deferral wiring.** Watcher file events now index through the exact same
  direct path as a folder scan (`indexIfChanged` → `/indexer/reindex`) instead
  of being enqueued and deferred to host idle time. Indexing runs eagerly the
  moment a change is detected, off the user's interactive path: the worker is a
  separate process and the host dispatches scans/watcher events fire-and-forget
  (`void handleFileEvent`), so the user never waits on indexing.
- `/indexer/reindex` is now the **sole ingestion route**. It also counts
  failures in the `failed` metric (previously only the removed `/process_one`
  did).

### Removed
- Worker routes `POST /indexer/enqueue`, `POST /indexer/process_one`,
  `GET /indexer/state`, and `POST /embed/batch_flush`, plus `AppState.queue` /
  `_seq` and the `EnqueueRequest` / `ProcessOneRequest` / `EmbedBatchFlushRequest`
  models. The host drained `enqueue` → `process_one` in lockstep, so the
  worker-side priority queue (P0–P4) and the no-op batch-flush were dead weight.
- `WorkerClient.enqueue` / `processOne` / `getIndexerState` / `batchFlush` and
  their result types.
- `FolderAutoIndexer`'s `IdleScheduler` interface, `idleScheduler` field,
  `setIdleScheduler` setter, and the host plugin's `setIdleScheduler` method —
  the file-event queue branch is gone, so events flow straight through
  `indexIfChanged`.
- **Companion host change** (`ave`): the indexer's idle-scheduler wiring
  (`idleWorkerAdapter` + `setIdleScheduler` call). The shared
  `IdleSchedulerService` state machine is preserved for its non-indexer
  consumers (preference-refresh, post-turn, conversation-loop).

## [0.5.9] - 2026-06-28

### Added
- **Doc-level content-hash short-circuit — skip re-embedding unchanged docs.**
  The host re-indexes a file on any mtime change, but the most common triggers
  (an editor save with no edits, a metadata-only write, a cloud-sync touch)
  leave the file's visible content byte-identical. Previously every such touch
  re-paid the full embedding API cost. `documents.content_hash` now stores a
  sha256 over the document's normalized chunk text. On re-index, after chunking
  + tokenizing but before the embed call, `index_file` recomputes the hash and,
  if it matches the stored value **and** the prior run embedded cleanly
  (`content_state == 'ok'`), it reuses the existing chunks/vectors: the embed
  call and the SQLite/lance re-persist are both skipped and only `mtime_ms` is
  advanced. The result carries a new `unchanged=True` flag.
  - **embed_failed retry guard.** Docs in `content_state == 'embed_failed'`
    (text indexed, vectors missing) are **never** short-circuited — an
    unchanged-content re-index re-attempts embedding so a transient endpoint
    outage self-heals on the next scan.
  - **reindex teardown moved.** `reindex` no longer deletes the document's rows
    up front; it delegates to `index_file`, which resolves the existing
    `doc_id`, runs the short-circuit, and tears down the prior chunks_fts +
    lance vectors only when the content actually changed. This is what lets an
    unchanged doc avoid being torn down and rebuilt, and keeps `doc_id` stable
    across re-indexes.
  - **Migration.** `documents.content_hash TEXT` is added idempotently
    (`PRAGMA table_info` guard + `ALTER ... ADD COLUMN`, mirroring the
    `content_state` migration). Legacy rows backfill to NULL, which is treated
    as "changed" so the first re-index after upgrade recomputes and stores the
    hash. No rows are dropped.
  - **Crash-window safety.** `content_hash` is written to the `documents` row
    **only after the lance vector upsert succeeds** (not in `_persist_sqlite`
    before it). A SIGKILL/OOM between the sqlite commit and the lance upsert
    therefore leaves `content_hash=NULL`, which the short-circuit treats as
    "changed" — forcing a full reindex that self-heals the missing vectors. A
    row with `content_hash` set but no vectors in lance is impossible through any
    production code path. Proven by `test_crash_window_content_hash_set_only_after_lance_success`
    using an ordering-probe vector store (mutation-verified: patching
    `_persist_sqlite` to write the hash eagerly makes the test fail).
  - **Cost-saving proof.** A no-op (touch-only) re-index makes **zero** embed
    calls — proven by `test_touch_unchanged_content_short_circuits`, which spies
    on a `_CountingEmbeddingClient` and asserts `corpus_calls` does not advance.
    The retrieval eval gate (`test/retrieval_eval.test.py`, Recall@10 / nDCG@10
    over the KO/EN golden set) still passes unchanged, confirming the change
    leaves the retrieval *ranking* intact — but the eval gate injects a fake
    embedder, so it proves algorithm integrity, **not** the embed-skip plumbing;
    the counting-embedder unit test is the source of the cost-saving claim.

### Backlog (not in this PR)
- Whitespace-only-edit short-circuit: hash normalizes whitespace, so a
  whitespace-only change skips re-embedding while stored embeddings keep old
  whitespace representation (benign but observable).
- Stale `line_count`/`page_count` on short-circuit: both are not updated on a
  no-op reindex (cosmetic).
- Embedding-model change is not an invalidation key: switching `embedding_model`
  does not clear `content_hash`, so the first post-switch scan short-circuits
  docs that would benefit from re-embedding. Addressed by a future P3
  model-switch flow.

## [0.5.8] - 2026-06-28

### Changed (BREAKING)

- **LLM tool surface consolidated 12 → 6 (hard rename, no aliases).** The model
  now sees six tools instead of twelve, cutting the per-turn tool-schema token
  cost of this plugin by ~50% (six fewer tool definitions advertised on every
  request). The behavior of every absorbed operation is preserved verbatim —
  the original handler bodies are reused unchanged; the consolidated tools only
  add a discriminator that routes to them.

  Old → new mapping:

  | Old tool | New call |
  | --- | --- |
  | `chat_preview({question})` | `index_search({query, mode: "bm25"})` (returns the same `{question, documentCount, results, preview}` preview shape) |
  | `index_search({query, mode, topK})` | `index_search({query, mode, topK})` — unchanged for `mode: vector \| hybrid` |
  | `index_scan()` | `index_scan()` (no args = scan all registered folders) |
  | `index_refresh_folder({folder})` | `index_scan({folder})` |
  | `document_index_scan({paths})` | `index_scan({paths})` |
  | `index_folders()` | `index_folders({action: "list"})` (no args still lists) |
  | `index_add_folder({folder})` | `index_folders({action: "add", folder})` |
  | `index_add_folders({folders})` | `index_folders({action: "add", folders})` |
  | `index_remove_folder({folder})` | `index_folders({action: "remove", folder})` |

  Unchanged: `index_documents`, `index_get_document`, `index_scan_status`.

  **Migration required for saved routines / keywords.** This is a hard cut
  (owner decision A): there are **no compatibility aliases**. Any saved routine
  in `~/.ave/routine/routines.json` or external keyword binding that references
  an old tool id (`chat_preview`, `document_index_scan`, `index_refresh_folder`,
  `index_add_folder`, `index_add_folders`, `index_remove_folder`) will hard-fail
  with "tool not found" and must be rewritten to the new call shown above.
  `index_search({mode: "bm25"})` now returns the preview shape (was the
  structured `hits[]` list); use `mode: "hybrid"` (default) or `mode: "vector"`
  for `hits[]`.
## [0.5.7] - 2026-06-28

### Security
- **Removed the env LLM-key channel.** The host no longer injects the embedding
  API key into the worker process environment (`AVE_INDEXER_API_KEY`). That
  channel exposed the key via `/proc/<pid>/environ`, child-process inheritance,
  and crash dumps. The key now reaches the worker **only** through the runtime
  `POST /indexer/set_embedding_api_key` push and lives solely in worker-process
  memory. The worker boots with an empty key; the host pushes the credential on
  worker warmup, per index_scan, and on rotation (9-pref lifetime residency).

### Fixed
- **Push now feeds all three key consumers, not just the indexer.** Previously
  `/indexer/set_embedding_api_key` updated only `LocalIndexer`, while
  `SearchService` and `AppState` were seeded from the boot env. With the env
  channel removed, that would have silently degraded **query-time vector
  search** (which runs outside any index_scan window) to BM25-only. The push
  now also updates the new `SearchService.set_embedding_api_key` and
  `AppState.openai_api_key`, so vector search survives env removal.
  Verified by `test_push_feeds_all_three_and_revives_vector_search`: asserts
  `search_vector` returns `[]` before the push and real hits after it. The
  retrieval eval gate (Recall@10 0.975 / nDCG@10 0.9584, unchanged) confirms
  the env-removal left the retrieval *algorithm and ranking* unchanged; it does
  **not** verify key-feed plumbing because `run_eval.py` injects
  `DeterministicEmbedder` directly as `_embedding_client`, bypassing the key
  resolution path entirely.

### Added
- `SearchService.set_embedding_api_key` / `clear_embedding_key` and
  `LocalIndexer.clear_embedding_key` (overwrite-then-`None` memory scrub).
  `POST /shutdown` now scrubs the key from the indexer, the search service, and
  the AppState copy — timing is shutdown/rotation, **not** scan end, so the key
  stays resident while search can run.

### Preserved
- The item-4 trust chokepoint: the pushed bearer still flows through
  `resolveEmbeddingKeyForEndpoint`, so an untrusted custom `embeddingEndpoint`
  withholds the host LLM key and routes the plugin-own key instead.
- The `OPENAI_API_KEY` fallback in `embedding_client.py` (gated by
  `AVE_ALLOW_ENV_API_KEY=1`) is preserved. **This is a standalone-worker dev
  affordance only** — the host's whitelist-only spawn env (`localIndexerPlugin.ts`)
  excludes `OPENAI_API_KEY`, so this path is unreachable through the host. Only
  the host-injected `AVE_INDEXER_API_KEY` channel was removed.

## [0.5.6] - 2026-06-28

### Added
- **Retrieval eval gate** (`eval/` + `test/retrieval_eval.test.py` +
  `.github/workflows/retrieval-eval.yml`) — a golden-set regression gate that
  runs the *real* hybrid search path (RRF + FTS5 + Kiwi) over a 25-doc KO/EN
  corpus with 20 graded queries and asserts Recall@10 / nDCG@10 against a
  recorded baseline (regression guard + absolute floor) plus a p95 latency
  ceiling. This is pure additive test infrastructure — **no production code
  changed** — and is the source-of-truth that later retrieval changes are
  validated against.
- `eval/embedder.py` ships a `DeterministicEmbedder` (hashed char-trigram
  bag-of-words → 256-dim L2-normalized vectors) so the gate runs hermetically
  with **no embedding API key and no network**; results are byte-identical
  across runs. It lives only under `eval/` and is never imported by the worker
  (it is not a production fallback).
- `eval/vector_store.py` (`InMemoryCosineStore`) mirrors the production score
  polarity (`1 / (1 + cosine_distance)`); `eval/metrics.py` provides pure
  `recall_at_k` / `ndcg_at_k`; `eval/run_eval.py` drives the indexer + search
  via dependency injection and writes `eval/last_run.json`.
- The gate imports `kiwipiepy` directly (not `pytest.importorskip`) so a missing
  Korean tokenizer hard-fails the build instead of silently skipping the
  Korean-heavy corpus and reporting a falsely-green gate.

## [0.5.5] - 2026-06-28

### Added
- `documents.content_state` column (`'ok' | 'empty' | 'embed_failed'`) to
  distinguish the three successful-registration outcomes that were previously
  conflated under `status = 'indexed'`: a clean doc (text + vectors), a parsed
  doc with no extractable text (`empty`), and a doc whose text was indexed for
  BM25/FTS5 but whose embeddings failed (`embed_failed`, semantic search
  unavailable). `status` keeps its `pending | indexed | failed` vocabulary
  unchanged so the host's `status === 'indexed'` hard-filter still lists every
  registered doc — empty and degraded docs are no longer silently dropped, but
  they also do not pollute the `status` enum.
- `content_state` is surfaced through `list_documents` / `get_document`, the
  worker client, and the `index_documents` / `index_get_document` host
  responses so the LLM/UI can flag degraded or empty documents.

### Changed
- `LocalIndexer._init_schema` now runs an idempotent `ALTER TABLE documents ADD
  COLUMN content_state TEXT NOT NULL DEFAULT 'ok'` migration guarded by
  `PRAGMA table_info`, so pre-existing `~/.ave` index databases gain the column
  on next boot with every legacy row backfilled to `'ok'` and zero row loss.

## [0.5.4] - 2026-06-28

### Security
- Never forward the host's shared LLM key to an untrusted custom endpoint.
  When `apiKeySource="host"`, a user-supplied `embeddingEndpoint` /
  `imageCaptionEndpoint` pointing at an arbitrary `base_url` (LM Studio,
  an internal proxy, or an attacker-controlled URL smuggled in via a malicious
  config import) could previously exfiltrate the host's shared chat key across
  the boot, search query-embedding, legacy (no-SDK-handle), and image-caption
  paths. The pre-existing guard only covered one path (OpenAI provider + SDK
  handle + scan) and the caption endpoint had no guard at all.
- Added a single host-side trust chokepoint (`isTrustedEndpointUrl`): the host
  key is only ever sent to `api.openai.com` (exact), `*.openai.azure.com`, or
  `*.cognitiveservices.azure.com` (https, dot-boundary suffix — look-alikes
  such as `evil-openai.azure.com.attacker.com` are rejected), aligned with
  `plugin.json` `networkAccess.allowedDomains`. For any other (untrusted)
  custom endpoint the host key is withheld and only the plugin's own key slot
  is used; if no plugin-own key exists, `index_scan` refuses rather than
  silently mis-routing. An empty endpoint (provider default) and the trusted
  domains are unaffected — the host key is used exactly as before.
- The worker is intentionally unchanged: it has no key provenance (it cannot
  tell a host-issued bearer from a plugin-own one), so the trust decision must
  live host-side where the endpoint and key source are both known.

## [0.5.3] - 2026-06-28

### Removed
- Dead worker-side `cloud_index_adapter.py` (Mock/Disabled `CloudIndexAdapter`
  + `CloudIndexFactory`) and its `AppState.cloud` wiring + `AVE_CLOUD_INDEX_MODE`
  env switch. The adapter was always constructed in `disabled` mode and never
  read on any search/index path — pure dead code. The `"cloud"` RRF weight was
  also dropped from `DEFAULT_RRF_WEIGHTS` (no source ever emitted it).

### Changed
- Renamed the TypeScript search-source label `cloud` → `hybrid` across
  `types.ts` / `workerClient.ts` / `hostPlugin.ts`. This was the live
  fused-hybrid result mapping (every `/search/hybrid` hit is the RRF output),
  mislabelled `cloud`; the externally exposed `index_search` source vocabulary
  (`bm25` | `vector` | `hybrid`) is unchanged. This is unrelated to the
  `ImageCaptionMode = "cloud"` caption-provider concept, which is untouched.
- Moved 7 renderer-only tools off the LLM tool list (`tools[]` 19 → 12):
  `index_scan_cancel`, `index_clear_warnings`, `index_pick_folder`,
  `index_preview_folder`, `index_get_settings`, `index_set_image_embedding`,
  `index_folders_purge_orphans`. They remain in `uiActions[]` (renderer can
  still invoke them) and keep their `toolSchemas` descriptions. `index_scan_status`
  stays LLM-visible — the model legitimately polls scan progress.

### Fixed
- Vector search score polarity. LanceDB `_distance` (smaller = closer) was used
  directly as the score, inverting rank order on the distance branch. It is now
  normalised to `1 / (1 + distance)` (higher = better, matching BM25) via the new
  `_normalize_distance_to_score` helper, and the LanceDB query now declares
  `.metric("cosine")` explicitly. Query-time only — no reindex required. Hybrid
  ranking is unchanged in practice because RRF fuses on rank order, not raw score.


## [0.5.2] - 2026-06-27

### Removed
- Dead `pageindex` cloud-SDK integration in the worker. The pinned PyPI
  `pageindex==0.2.8` was the cloud SDK (`PageIndexClient(api_key)`,
  `api.pageindex.ai`), incompatible with the local `PageIndexClient(workspace).index()`
  API the worker code targeted, so the client was always `None` and the
  tree/structure/page-content-via-pageindex branches were inert in production.
  Removed the optional client, the `_build_pageindex_tree` pass, the dead `tree`
  RRF channel, and the latent `api.pageindex.ai` egress. Search/index output is
  unchanged (the structure/page-content endpoints already read from SQLite).

### Changed
- Renamed the worker modules off the pre-transition `pageindex_*` name to the
  domain: `local_indexer_worker.py` / `local_indexer.py` / `local_indexer_search.py`
  (class `PageIndexIndexer` → `LocalIndexer`). Internal only — no host↔worker
  contract strings (routes, tool names, event types) changed.
- `openai` is now a direct dependency (`python-requirements.in`); it was
  previously only pulled in transitively via `pageindex` but is imported directly
  by the embedding/captioning clients. Lock regenerated via `uv pip compile`
  (`openai==2.31.0` retained, `pageindex` and its dead transitive deps dropped).

## Unreleased (#893)

### Changed
- Migrated to SDK v5.13 `hostApi.resolveApiKey({purpose:"embedding", vendor:"openai", signal})`
- Worker bearer via `getBearer()` callback (no plaintext stored in worker memory)

### Security
- SSRF fix: refuse user-supplied `embeddingEndpoint` when host LLM key is used
- Sanitized open-source identifiers (publisher, UNC examples, test endpoints, README)

## [0.4.4] - 2026-05-17

### Chore — SDK pin v5.7.0 → v5.10.0

2026-05-12 plugin theme unification announcement (deadline 2026-05-26) 의
잔존 drift 정리. 본 plugin 은 이미 `primeTheme(bridge, { target: scope })`
를 mount 안에서 정상 사용 중이라 코드 변경 없이 dep pin + version bump 만.

- `package.json` `@ave/plugin-sdk` pin → `github:former_org/ave-plugin-sdk#v5.10.0`
- 검증: typecheck + test + build 통과 (209 tests pass)
- 검증: legacy theme symbol grep (`applyThemeFromHostEvent`/`bootstrapHostTheme`/
  `setupThemeSync`/`applyHostThemePayload`/`applyThemePayload`) → 0건 (단,
  `src/ui/ave-tokens.css.js:28` 의 주석 안 `applyThemeFromHostEvent` 는
  host 의 동작 설명 — 본 plugin 호출 아님)

Reference: ave-plugin-sdk CHANGELOG [5.10.0].

## [0.4.1] - 2026-05-13

### Fixed
- Reclaim stale Local Indexer workers only when `.worker-session.json`, the observed port owner PID, and the worker command identity all match the expected worker.
- Fail closed when the port owner PID cannot be verified, or when a matching command line has no matching session record.
- Clean up spawned workers on startup/session persistence failures and redact shutdown tokens from worker stdout/stderr callbacks.

## [0.3.0] - 2026-05-09

### Added
- `toolSchemas[*].category` declarations for Q12 permission policy (read=7, write=7, meta=2)
  - `read`: `chat_preview`, `index_search`, `index_get_document`, `index_folders`, `index_preview_folder`, `index_scan_status`, `index_documents`
  - `write`: `index_scan`, `index_add_folder`, `index_add_folders`, `index_remove_folder`, `index_refresh_folder`, `index_folders_purge_orphans`, `document_index_scan`
  - `meta`: `index_pick_folder`, `index_scan_cancel`
- `pathFields` on all path-bearing write tools (Q12 spec §3 Layer 0/1): `index_add_folder` (`folder`), `index_remove_folder` (`folder`), `index_refresh_folder` (`folder`), `index_add_folders` (`folders`), `document_index_scan` (`paths`)
