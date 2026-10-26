#!/bin/sh
set -eu
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "This locked connector requires Node.js 24+ on Ave's PATH. Install Node.js or add its bin directory to Ave's PATH before enabling the connector." >&2
  exit 1
fi
exec node "${0%/*}/launch.mjs"
