#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "usage: publish_release.sh <stage|publish> <tag> <asset-dir> <notes-file>" >&2
  exit 64
fi

mode="$1"
tag="$2"
asset_dir="$3"
notes_file="$4"

if [[ "$mode" != "stage" && "$mode" != "publish" ]]; then
  echo "invalid release mode" >&2
  exit 64
fi
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "invalid release tag" >&2
  exit 64
fi
if [[ ! "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "invalid repository name" >&2
  exit 64
fi
if [[ ! -d "$asset_dir" || -L "$asset_dir" ]]; then
  echo "asset directory must be a directory, not a symlink" >&2
  exit 66
fi
if [[ ! -f "$notes_file" || -L "$notes_file" ]]; then
  echo "release notes must be a regular file, not a symlink" >&2
  exit 66
fi

asset_dir="$(realpath "$asset_dir")"
notes_file="$(realpath "$notes_file")"
mapfile -d '' assets < <(
  find "$asset_dir" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z
)
mapfile -d '' entries < <(
  find "$asset_dir" -mindepth 1 -maxdepth 1 -print0 | sort -z
)
if [[ "${#assets[@]}" -eq 0 || "${#assets[@]}" -ne "${#entries[@]}" ]]; then
  echo "asset directory must contain only regular files" >&2
  exit 66
fi

declare -A local_assets=()
for asset in "${assets[@]}"; do
  name="$(basename "$asset")"
  if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._+[:space:]-]*$ ]] ||
    [[ "$name" == *$'\n'* ]] || [[ "$name" == *$'\r'* ]]; then
    echo "invalid asset name" >&2
    exit 66
  fi
  if [[ -n "${local_assets[$name]:-}" ]]; then
    echo "duplicate asset name" >&2
    exit 66
  fi
  local_assets["$name"]="$asset"
done

release_json=""
release_exists=false
if release_json="$(
  gh release view "$tag" \
    --repo "$GITHUB_REPOSITORY" \
    --json isDraft,assets 2>/dev/null
)"; then
  release_exists=true
fi

if [[ "$mode" == "publish" && "$release_exists" != true ]]; then
  echo "draft release does not exist" >&2
  exit 65
fi

if [[ "$release_exists" != true ]]; then
  gh release create "$tag" \
    --repo "$GITHUB_REPOSITORY" \
    --draft \
    --verify-tag \
    --title "Net F/T Viewer $tag" \
    --notes-file "$notes_file"
  release_json="$(
    gh release view "$tag" \
      --repo "$GITHUB_REPOSITORY" \
      --json isDraft,assets
  )"
fi

is_draft="$(
  printf '%s' "$release_json" |
    node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        if (typeof value.isDraft !== "boolean") process.exit(2);
        process.stdout.write(value.isDraft ? "true" : "false");
      });
    '
)"

read_remote_assets() {
  printf '%s' "$1" |
    node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        if (!Array.isArray(value.assets)) process.exit(2);
        const names = value.assets.map(({ name }) => name);
        if (names.some((name) => typeof name !== "string" || /[\r\n]/.test(name))) {
          process.exit(2);
        }
        names.sort().forEach((name) => process.stdout.write(`${name}\n`));
      });
    '
}

declare -A remote_assets=()
while IFS= read -r name; do
  [[ -n "$name" ]] && remote_assets["$name"]=1
done < <(read_remote_assets "$release_json")

for name in "${!remote_assets[@]}"; do
  if [[ -z "${local_assets[$name]:-}" ]]; then
    echo "remote release has an unexpected asset" >&2
    exit 65
  fi
done
if [[ "$is_draft" != true && "${#remote_assets[@]}" -ne "${#local_assets[@]}" ]]; then
  echo "published release assets are immutable" >&2
  exit 65
fi

verify_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$verify_dir"
}
trap cleanup EXIT

for name in "${!local_assets[@]}"; do
  asset="${local_assets[$name]}"
  if [[ -n "${remote_assets[$name]:-}" ]]; then
    download_dir="$verify_dir/existing-${#remote_assets[@]}-${RANDOM}"
    mkdir -p "$download_dir"
    gh release download "$tag" \
      --repo "$GITHUB_REPOSITORY" \
      --pattern "$name" \
      --dir "$download_dir"
    if ! cmp --silent "$asset" "$download_dir/$name"; then
      echo "release asset differs from local bytes" >&2
      exit 65
    fi
  elif [[ "$is_draft" == true ]]; then
    gh release upload "$tag" "$asset" --repo "$GITHUB_REPOSITORY"
  else
    echo "published release assets are immutable" >&2
    exit 65
  fi
done

release_json="$(
  gh release view "$tag" \
    --repo "$GITHUB_REPOSITORY" \
    --json isDraft,assets
)"
mapfile -t verified_names < <(read_remote_assets "$release_json")
if [[ "${#verified_names[@]}" -ne "${#local_assets[@]}" ]]; then
  echo "release asset set is incomplete" >&2
  exit 65
fi
for name in "${verified_names[@]}"; do
  if [[ -z "${local_assets[$name]:-}" ]]; then
    echo "release asset set does not match" >&2
    exit 65
  fi
  download_dir="$verify_dir/final-${#verified_names[@]}-${RANDOM}"
  mkdir -p "$download_dir"
  gh release download "$tag" \
    --repo "$GITHUB_REPOSITORY" \
    --pattern "$name" \
    --dir "$download_dir"
  if ! cmp --silent "${local_assets[$name]}" "$download_dir/$name"; then
    echo "downloaded release asset failed byte verification" >&2
    exit 65
  fi
done

if [[ "$mode" == "publish" && "$is_draft" == true ]]; then
  gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --draft=false
fi
