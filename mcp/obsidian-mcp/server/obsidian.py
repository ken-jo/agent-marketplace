"""Apply an explicit reviewed tool allowlist before opening Obsidian's stdio server."""
import asyncio
import os
import sys
import unicodedata

key = os.environ.get("OBSIDIAN_API_KEY", "")
if not key.strip() or any(unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") for c in key):
    sys.exit("Enter an Obsidian API key without control characters in Ave's secret prompt.")

from mcp_obsidian import server

write = {"obsidian_append_content", "obsidian_patch_content", "obsidian_put_content", "obsidian_delete_file"}
read = {"obsidian_list_files_in_dir", "obsidian_list_files_in_vault", "obsidian_get_file_contents",
        "obsidian_simple_search", "obsidian_complex_search", "obsidian_search_by_tag",
        "obsidian_get_frontmatter", "obsidian_batch_get_file_contents", "obsidian_get_periodic_note",
        "obsidian_get_recent_periodic_notes", "obsidian_get_recent_changes"}
allowed = read | write if os.environ.get("AVE_CONNECTOR_ALLOW_WRITES") == "true" else read
server.tool_handlers = {name: handler for name, handler in server.tool_handlers.items() if name in allowed}
asyncio.run(server.main())
