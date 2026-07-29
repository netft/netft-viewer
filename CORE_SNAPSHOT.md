# netft-cpp core snapshot

This repository carries an auditable source snapshot of the native `netft-cpp`
library.

- Upstream repository: `https://github.com/netft/netft-cpp.git`
- Upstream commit: `f2c24fe22372dc8b2383bc08320ab1c5fe06ac21`
- Snapshot date: `2026-07-29`
- Copied library paths: `include/netft/**` and `src/**`
- Copied native-test paths: the twelve non-CLI `test/test_*.cpp` unit tests and
  `test/support/**`
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
- `core/netft/test/CMakeLists.txt` adapts target names and omits the excluded
  CLI, installation, hardware, release, and repository-automation tests.
- `include/netft/client.hpp`, `src/client.cpp`,
  `src/detail/client_impl.{hpp,cpp}`, and `test/test_client_lifecycle.cpp`
  retain the viewer's deferred destruction behavior when a `Client` is
  destroyed from its own sample callback. This lifecycle contract is not part
  of upstream `netft-cpp`.
- Snapshot sources retain the viewer repository's established formatting.
  Whitespace-only differences are not behavioral overlays.

No public transport API differs from the recorded upstream commit.

## Manual synchronization procedure

1. Fetch `https://github.com/netft/netft-cpp.git` and check out the exact commit
   recorded above in a clean temporary worktree.
2. Generate manifests with `git ls-tree -r --name-only <commit> -- include/netft
   src test`. Retain all files under `include/netft` and `src`.
3. Copy each retained header and source file individually to a temporary
   staging tree, preserving relative paths and contents.
4. From `test`, copy `test_types.cpp`, `test_protocol.cpp`, `test_status.cpp`,
   `test_sequence.cpp`, `test_fault_latch.cpp`, `test_posix_transport.cpp`,
   `test_udp_transport.cpp`, `test_socket_runtime.cpp`, `test_discovery.cpp`,
   `test_client_stream.cpp`, `test_client_recovery.cpp`,
   `test_client_lifecycle.cpp`, and every file under `test/support`.
5. Reapply only the viewer-local lifecycle adaptation listed above. Keep the
   viewer's dependency and CMake integration files rather than copying
   upstream packaging configuration.
6. Compare every other snapshot file against the commit with
   `git diff --no-index --ignore-all-space`. Any non-whitespace difference
   outside the listed lifecycle files must be resolved before updating this
   document.
7. Reconcile upstream `test/CMakeLists.txt` manually: replace the upstream
   library target with `netft_viewer_netft`, retain the twelve native test
   definitions, and do not import CLI, hardware, install, release, or
   repository-automation tests.
8. Confirm the excluded paths are absent, then run `pixi run native-configure`,
   `pixi run native-build`, `pixi run native-test`, and the project provenance
   test before committing.
