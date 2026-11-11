# Local Indexer

The shared public types and manifest schema are vendored in `../../../contract/`. See [README.md](README.md) for the runtime and development checks. The Ave reference checkout is read-only.

`src/hostPlugin.ts` owns tools, configuration, leases and lifecycle. `src/localIndexerPlugin.ts` owns delegated worker startup and shutdown; `src/workerClient.ts` owns stdio method calls. `worker/stdio_control.py` implements worker control and `worker/stdio_egress.py` relays provider calls. The worker owns the index state directory.

`src/ui/indexer-control.js` is a standard MCP Apps view. Its HTML is served by `readUiResource`; snapshots and `index_wait_changes` supply live state. Keep transport and credentials server-side.
