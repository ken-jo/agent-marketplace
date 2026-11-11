# @ave/plugin-local-indexer

Local document indexing and BM25/vector hybrid search for Ave 0.14.2 or newer, using host protocol 5.

The extension runs as an MCP stdio server with a secondary MCP Apps sidebar at `ui://local-indexer/control`. Add folders, preview supported files, start or cancel scans, inspect warnings and documents, and toggle image captioning from that sidebar. Questions stage a composer draft for the user to send.

## Runtime

The host provisions Python and dependencies from `python-requirements.lock`. The server delegates the Python worker through `spawnWorker`, using `control: "stdio-control-v1"` and `stateDirectory: true`. Worker requests and provider egress share the host-owned stdio control pipe. The worker receives no provider credentials; the server resolves credentials or secret leases and forwards permitted requests through `hostFetch`.

The default index lives in the worker's host-created state directory. `indexStorageRoot` selects a user-approved alternative. Versions before 0.8.0 stored the default index at `<pluginDataDir>/index`; startup rebuilds that index and removes the old directory only after verifying coverage. Rebuild warnings and status appear in `index_scan_status`.

Logs go to stderr. The host's stdio lifecycle invokes runtime `stop` on stdin EOF before signal escalation; `stop` closes waits and tears down the watcher and delegated worker. Worker control methods use the `$/ai.agent-connector.ave/` namespace.

## Tools and live state

`index_search` supports BM25, vector and hybrid search. `index_scan` scans all configured folders, one `folder`, or explicit `paths`. `index_folders` lists, adds or removes folders; `index_documents` pages through indexed metadata; `index_get_document` returns document metadata and requested content.

The app-visible controls also expose scan status/cancellation, warning clearing, folder picking/preview, orphan cleanup and settings. Their signed visibility and input schemas are in [plugin.json](plugin.json).

`index_wait_changes` is app-only. Pass `{ cursor: "", waitMs: 0 }` before loading snapshots to obtain the current cursor. Then keep one wait outstanding, with `waitMs` from 0 to 10000. Responses contain `{ cursor, reset, changes, closed }`; each change contains an invalidation `kind`, and domain data is read through snapshot tools. Reload status after changes, and folder/document snapshots for the corresponding invalidations or a reset. A timeout returns no changes. A foreign, expired, malformed or future cursor resets to the current position. The stream retains 256 invalidations and allows 16 outstanding waits per runtime; excess waits return a tool error. Runtime shutdown releases waits with `closed: true`.

Invalidation routing:

| Kind | Snapshot tools to reload |
| --- | --- |
| `index.scan.progress`, `index.warning`, `warnings.cleared` | `index_scan_status` (includes warnings) |
| `index.document.updated`, `index.folders.changed`, `index.scan.completed` | `index_scan_status`, `index_folders`, `index_documents` |
| `reset: true` | All three snapshots above |

Snapshots are separate reads rather than one atomic view; invalidations after the cursor are replayed on the next wait. The client advances to the returned cursor, applies invalidations, then waits again.

The view uses standard MCP Apps host-context styles and aborts its client wait on unmount. The host currently does not forward client cancellation to executing tools, so the server's 10-second wait limit bounds remaining work.

## Providers and storage

BM25 works without embedding credentials. Embedding and captioning require configured credentials and a host-permitted endpoint. `apiKeySource: "host"` uses host-resolved credentials; plugin-owned credentials support explicitly configured providers. Host credentials are withheld from untrusted custom endpoints. Caption images are capped at 11 MiB to fit the worker control frame after encoding.

Folder permissions, worker path confinement and leased egress remain enforced server-side. Scan completion and folder-change alerts are opt-in and off by default. The nightly rescan suggestion remains a separate, one-time declared suggestion.

## Development

From the repository root:

```sh
node tools/plugin-check.mjs plugins/local-indexer
node tools/index.mjs --check
```

From this source directory:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv -r python-requirements.lock -r python-test-requirements.txt
.venv/bin/python -m pytest test/
```

`bun run build` bundles the server and a self-contained HTML view, then copies worker assets. Release assets contain `plugin.json`, `dist/` and the Python lockfile. Source versions advance independently of the published descriptor and catalog; those pins change only after a release exists.
