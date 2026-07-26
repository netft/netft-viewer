# netft-cpp core snapshot

This repository carries an auditable source snapshot of the native `netft-cpp`
library.

- Upstream repository: `https://github.com/netft/netft-cpp.git`
- Upstream commit: `e424c401587052f03de9b94f76f1e86b78902105`
- Snapshot date: `2026-07-26`
- Copied library paths: `include/netft/**` and `src/**`
- Copied native-test paths: the ten non-CLI `test/test_*.cpp` unit tests and
  `test/support/**`
- Local destinations: `core/netft/include/netft/**`, `core/netft/src/**`, and
  `core/netft/test/**`

The snapshot excludes the upstream CLI (`app/**`, `test/test_cli.cpp`, and CLI
test helpers), release and CI workflows (`.github/**`), repository-automation
shell tests, hardware tests, consumer/install tests, upstream CMake packaging,
Pixi files, and upstream top-level packaging metadata. The local
`core/netft/CMakeLists.txt` and `core/netft/test/CMakeLists.txt` are integration
glue for this repository; the latter adapts target names, omits the excluded
CLI and automation tests, and adds the local cross-platform transport contract.

## Viewer-local transport overlay

The viewer keeps the upstream transport behavior but applies a private
cross-platform overlay:

- `src/detail/posix_transport.{hpp,cpp}` is represented by the platform-neutral
  `src/detail/udp_transport.hpp` interface and
  `src/detail/udp_transport_posix.cpp` implementation.
- `src/detail/udp_transport_windows.cpp` provides the same contract with
  WinSock. It owns WinSock startup and cleanup, resolves and connects the UDP
  peer, bounds waits with `WSAPoll`, and treats shutdown or interrupted waits as
  non-record results.
- `Client::Impl` owns `UdpTransport`; no public `netft` API changes.
- CMake compiles exactly one platform implementation and links `ws2_32` only on
  Windows. The snapshot target remains private and is not installed or
  exported.
- The imported POSIX transport tests follow the renamed private type, while
  `test/test_udp_transport.cpp` exercises the common loopback UDP and shutdown
  contract on every platform.

These files are intentional viewer-local modifications and therefore are not
expected to compare byte-for-byte with the upstream commit.

## Manual synchronization procedure

1. Fetch `https://github.com/netft/netft-cpp.git` and check out the exact commit
   recorded above in a clean temporary worktree.
2. Generate manifests with `git ls-tree -r --name-only <commit> -- include/netft
   src test`. Review every entry and retain all files under `include/netft` and
   `src`.
3. Copy each retained header and source file individually to a temporary
   staging tree, preserving relative paths and file contents. Reapply the
   viewer-local transport overlay described above when updating `core/netft`.
4. From `test`, copy `test_types.cpp`, `test_protocol.cpp`, `test_status.cpp`,
   `test_sequence.cpp`, `test_fault_latch.cpp`, `test_posix_transport.cpp`,
   `test_discovery.cpp`, `test_client_stream.cpp`, `test_client_recovery.cpp`,
   `test_client_lifecycle.cpp`, and every file under `test/support`.
5. Compare every non-overlay file against the commit one at a time with
   `git diff --no-index` or `cmp`. Audit each overlay difference against the
   list above. Any other difference in a public header, library source, native
   test, or test support file must be resolved before updating this document.
6. Reconcile upstream `test/CMakeLists.txt` manually: replace only the upstream
   library target with `netft_viewer_netft`, retain the ten native unit-test
   definitions, and do not import CLI, hardware, install, release, or
   repository-automation tests.
7. Confirm the excluded paths are absent, then run `pixi run native-configure`,
   `pixi run native-build`, `pixi run native-test`, and the project provenance
   test before committing.
