# Meeting extension

The extension is an MCP stdio server with two served MCP Apps resources.
Use contract/public-contract.ts and the vendored protocol/schema as authority.
Keep STT host fetch, leases, audio capture, staged files and workers server-side.
Views use snapshots and meeting_wait_changes; users or agents initiate prep, recording and summaries.
Log only fixed diagnostic codes to stderr. Do not log meeting content or identities.
