# netft-cpp core snapshot

This repository carries an auditable source snapshot of the native `netft-cpp`
library.

- Upstream repository: `https://github.com/netft/netft-cpp.git`
- Upstream release: `v0.3.1`
- Upstream commit: `859eeda8b077093f9bc49d9c1e5506c334647e7b`
- Snapshot date: `2026-07-31`
- Copied library paths: `include/netft/**` and `src/**`
- Copied native-test support: `test/support/fake_http_server.*` and
  `test/support/fake_sensor.*`, plus their portable socket helper
  `test/support/socket_runtime.hpp`
- Local destinations: `core/netft/include/netft/**`, `core/netft/src/**`, and
  `core/netft/test/**`

The snapshot excludes the upstream CLI (`app/**`, `test/test_cli.cpp`, and CLI
test helpers), release and CI workflows (`.github/**`), repository-automation
shell tests, hardware tests, consumer/install tests, upstream CMake packaging,
Pixi files, and upstream top-level packaging metadata.

The cross-platform `UdpTransport`, its POSIX and WinSock implementations, the
portable socket test support, and their contract tests are now upstream
`netft-cpp` code. They are no longer a viewer-owned transport overlay.

## Viewer-local integration

The viewer intentionally retains only these local adaptations:

- `core/netft/CMakeLists.txt` builds the snapshot as the private static target
  `netft_viewer_netft`; it is not installed or exported.
- The top-level viewer dependency configuration supplies a pinned, minimal,
  static libcurl for application packaging. Upstream `netft-cpp` continues to
  use `find_package(CURL)` and does not inherit this application policy.
- `include/netft/client.hpp`, `src/client.cpp`,
  and `src/detail/client_impl.{hpp,cpp}` retain the viewer's deferred
  destruction behavior when a `Client` is destroyed from its own sample
  callback. Viewer integration tests cover this local lifecycle contract,
  which is not part of upstream `netft-cpp`.
- Snapshot sources retain the viewer repository's established formatting.
  Whitespace-only differences are not behavioral overlays.

No public transport API differs from the recorded upstream commit.

## Manual synchronization procedure

1. Fetch `https://github.com/netft/netft-cpp.git` and check out the exact commit
   recorded above in a clean temporary worktree.
2. Generate manifests with `git ls-tree -r --name-only <commit> -- include/netft
   src test/support`. Retain all files under `include/netft` and `src`.
3. Copy each retained header and source file individually to a temporary
   staging tree, preserving relative paths and contents.
4. From `test/support`, copy only `fake_http_server.*`, `fake_sensor.*`, and
   `socket_runtime.hpp`, which support the viewer's session integration tests.
   Upstream core unit tests remain owned and executed by `netft-cpp`.
5. Reapply only the viewer-local lifecycle adaptation listed above. Keep the
   viewer's dependency and CMake integration files rather than copying
   upstream packaging configuration.
6. Compare every other snapshot file against the commit with
   `git diff --no-index --ignore-all-space`. Any non-whitespace difference
   outside the listed lifecycle files must be resolved before updating this
   document.
7. Confirm the excluded paths are absent, then run `pixi run native-configure`,
   `pixi run native-build`, and `pixi run native-test` before committing.
