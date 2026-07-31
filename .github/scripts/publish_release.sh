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
if [[ "${#assets[@]}" -gt 64 ]]; then
  echo "asset directory exceeds the 64-file release limit" >&2
  exit 66
fi

declare -A local_assets=()
total_asset_bytes=0
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
  asset_bytes="$(stat --format='%s' -- "$asset")"
  if ((asset_bytes > 2147483648)); then
    echo "release asset exceeds the 2 GiB per-file limit" >&2
    exit 66
  fi
  total_asset_bytes=$((total_asset_bytes + asset_bytes))
  if ((total_asset_bytes > 8589934592)); then
    echo "release assets exceed the 8 GiB total limit" >&2
    exit 66
  fi
done

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

api_http_status=""
api_request() {
  local endpoint="$1"
  local body_file="$2"
  local allow_not_found="$3"
  local response_file="$work_dir/api-response"
  local error_file="$work_dir/api-error"
  local gh_status
  local status_line

  : >"$response_file"
  : >"$error_file"
  set +e
  gh api --include "$endpoint" >"$response_file" 2>"$error_file"
  gh_status=$?
  set -e

  status_line="$(head -n 1 "$response_file")"
  api_http_status=""
  if [[ "$status_line" =~ ^HTTP/[0-9.]+[[:space:]]+([0-9]{3})([[:space:]]|$) ]]; then
    api_http_status="${BASH_REMATCH[1]}"
  fi
  awk 'body { print } /^\r?$/ { body = 1 }' "$response_file" >"$body_file"

  if [[ "$gh_status" -eq 0 && "$api_http_status" =~ ^2[0-9][0-9]$ ]]; then
    return 0
  fi
  if [[ "$allow_not_found" == true && "$api_http_status" == 404 ]]; then
    if [[ "$gh_status" -ne 0 ]]; then
      return "$gh_status"
    fi
    return 1
  fi

  if [[ -s "$error_file" ]]; then
    cat "$error_file" >&2
  else
    cat "$response_file" >&2
  fi
  if [[ "$gh_status" -ne 0 ]]; then
    return "$gh_status"
  fi
  return 1
}

repository_json="$work_dir/repository.json"
if api_request "repos/$GITHUB_REPOSITORY" "$repository_json" false; then
  :
else
  request_status=$?
  exit "$request_status"
fi

release_endpoint="repos/$GITHUB_REPOSITORY/releases/tags/$tag"
release_file="$work_dir/release.json"
release_exists=false
if api_request "$release_endpoint" "$release_file" true; then
  release_exists=true
else
  request_status=$?
  if [[ "$api_http_status" != 404 ]]; then
    exit "$request_status"
  fi
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

  retry_delay="${RELEASE_LOOKUP_RETRY_DELAY_SECONDS:-1}"
  if [[ ! "$retry_delay" =~ ^[0-9]+$ ]] || ((retry_delay > 10)); then
    echo "invalid release lookup retry delay" >&2
    exit 64
  fi
  release_available=false
  for attempt in {1..5}; do
    if api_request "$release_endpoint" "$release_file" true; then
      release_available=true
      break
    fi
    request_status=$?
    if [[ "$api_http_status" != 404 ]]; then
      exit "$request_status"
    fi
    if ((attempt < 5)); then
      sleep "$retry_delay"
    fi
  done
  if [[ "$release_available" != true ]]; then
    echo "created release is not yet available through the API" >&2
    exit 69
  fi
fi

release_json="$(<"$release_file")"
expected_title="Net F/T Viewer $tag"
if ! printf '%s' "$release_json" |
  node -e '
    const fs = require("node:fs");
    const [expectedTag, expectedTitle, notesFile] = process.argv.slice(1);
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      const expectedBody = fs.readFileSync(notesFile, "utf8");
      if (
        value.tag_name !== expectedTag ||
        value.name !== expectedTitle ||
        value.body !== expectedBody
      ) {
        process.exit(2);
      }
    });
  ' "$tag" "$expected_title" "$notes_file"; then
  echo "release tag, title, or notes do not match" >&2
  exit 65
fi

is_draft="$(
  printf '%s' "$release_json" |
    node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk));
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        if (typeof value.draft !== "boolean") process.exit(2);
        process.stdout.write(value.draft ? "true" : "false");
      });
    '
)"

read_remote_assets() {
  # The expression below is a JavaScript template literal.
  # shellcheck disable=SC2016
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

verify_dir="$work_dir/verified-assets"
mkdir -p "$verify_dir"

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

if api_request "$release_endpoint" "$release_file" false; then
  :
else
  request_status=$?
  exit "$request_status"
fi
release_json="$(<"$release_file")"
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

if [[ "$mode" == "publish" ]]; then
  if api_request "$release_endpoint" "$release_file" false; then
    :
  else
    request_status=$?
    exit "$request_status"
  fi
  release_json="$(<"$release_file")"
  published="$(
    printf '%s' "$release_json" |
      node -e '
        let input = "";
        process.stdin.on("data", (chunk) => (input += chunk));
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          if (typeof value.draft !== "boolean") process.exit(2);
          process.stdout.write(value.draft ? "false" : "true");
        });
      '
  )"
  if [[ "$published" != true ]]; then
    echo "release remained a draft after publication" >&2
    exit 65
  fi
  mapfile -t published_names < <(read_remote_assets "$release_json")
  if [[ "${#published_names[@]}" -ne "${#local_assets[@]}" ]]; then
    echo "published release asset set is incomplete" >&2
    exit 65
  fi
  for name in "${published_names[@]}"; do
    if [[ -z "${local_assets[$name]:-}" ]]; then
      echo "published release asset set does not match" >&2
      exit 65
    fi
  done
fi
