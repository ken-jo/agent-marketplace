#!/usr/bin/env bash
# Install the pinned cosign release into <dir> after checking its sha256, so
# `node tools/vendor.mjs verify` can check the Sigstore signature of Ave's
# contract bundle. Linux x86-64 only: the workflows run on ubuntu-latest.
#
#   tools/install-cosign.sh <dir>
#
# The checksum comes from cosign_checksums.txt of the same release.
set -euo pipefail

COSIGN_VERSION="v3.1.3"
COSIGN_LINUX_AMD64_SHA256="4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71"

dir="${1:?usage: install-cosign.sh <dir>}"
mkdir -p "$dir"
curl -fsSL --retry 3 -o "$dir/cosign" \
  "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64"
echo "${COSIGN_LINUX_AMD64_SHA256}  $dir/cosign" | sha256sum -c -
chmod +x "$dir/cosign"
