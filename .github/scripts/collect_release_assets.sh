#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: collect_release_assets.sh <source-dir> <destination-dir>" >&2
  exit 64
fi

source_dir="$1"
destination_dir="$2"
if [[ ! -d "$source_dir" || -L "$source_dir" ]]; then
  echo "source directory must be a directory, not a symlink" >&2
  exit 66
fi
if [[ -e "$destination_dir" || -L "$destination_dir" ]]; then
  echo "destination directory must not already exist" >&2
  exit 66
fi

source_dir="$(realpath "$source_dir")"
destination_parent="$(realpath -m "$(dirname "$destination_dir")")"
destination_name="$(basename "$destination_dir")"
mkdir -p "$destination_parent"
temporary="$(mktemp -d "$destination_parent/.${destination_name}.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT

mapfile -d '' sources < <(
  find "$source_dir" -type f -print0 | LC_ALL=C sort -z
)
if [[ "${#sources[@]}" -eq 0 ]]; then
  echo "source directory contains no release assets" >&2
  exit 66
fi

declare -A names=()
for source in "${sources[@]}"; do
  name="$(basename "$source")"
  canonical_name="${name// /-}"
  if [[ ! "$canonical_name" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; then
    echo "release asset name cannot be canonicalized safely: $name" >&2
    exit 66
  fi
  if [[ -n "${names[$canonical_name]:-}" ]]; then
    echo "duplicate canonical release asset name: $canonical_name" >&2
    exit 66
  fi
  names["$canonical_name"]=1
  cp -- "$source" "$temporary/$canonical_name"
done

mv -- "$temporary" "$destination_parent/$destination_name"
trap - EXIT
