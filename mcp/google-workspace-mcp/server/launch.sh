#!/bin/sh
set -eu
exec uvx --from 'git+https://github.com/taylorwilsdon/google_workspace_mcp@b5cf07e6078ae10a596710d77569e9430e01ebd4' python "$(dirname "$0")/launch.py"
