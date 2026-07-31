#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: generate_checksums.sh <asset-dir>" >&2
  exit 64
fi

asset_dir="$1"
if [[ ! -d "$asset_dir" || -L "$asset_dir" ]]; then
  echo "asset directory must be a directory, not a symlink" >&2
  exit 66
fi

asset_dir="$(realpath "$asset_dir")"
manifest="$asset_dir/SHA256SUMS"
temporary="$(mktemp "$asset_dir/.SHA256SUMS.XXXXXX")"
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT

(
  cd "$asset_dir"
  find . -maxdepth 1 -type f \
    ! -name SHA256SUMS \
    ! -name '.SHA256SUMS.*' \
    -printf '%P\0' |
    LC_ALL=C sort -z |
    xargs -0 -r sha256sum --
) >"$temporary"

mv -- "$temporary" "$manifest"
trap - EXIT
