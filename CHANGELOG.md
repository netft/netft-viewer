# Changelog

All notable changes to Net F/T Viewer are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-08

### Distribution

- Publish this version as a development prerelease without publisher signing. Windows installers are unsigned; macOS bundles use ad hoc signatures for local code integrity and are not notarized. Production signing and platform trust acceptance remain pending.

### Added

- Write a shared recording metadata summary with sample counts, units, revisions, pause and written-row sequence gaps.
- Document fully disconnected builds and diagnose missing pinned dependency sources at configuration.

### Fixed

- Replace invalid inherited macOS bundle signatures with development ad hoc signatures, and verify code integrity and real backend startup before uploading development packages.
- Preserve nanosecond precision in recording spans on macOS ARM64 and compile recording metadata on Windows.
- Integrate netft-cpp 0.3.4's calibration and checked-time protections; verify snapshot content before packaging.
- Reflow controls and six plots at high zoom, support narrower windows and keep title/menu labels distinct.
- Pin build actions and GoogleTest to reviewed commits.

## [0.1.1] - 2026-08-14

### Fixed

- Derive the Electron and native backend identities from the same core snapshot
  manifest, and verify installed Debian packages by starting their real backend.

### Changed

- Update the private core snapshot to netft-cpp v0.3.3 and remove the former
  viewer-owned callback-destruction overlay now provided upstream.

## [0.1.0] - 2026-07-31

### Added

- Cross-platform desktop visualization for all six force and torque axes.
- Combined and six-panel chart layouts with configurable time windows and axis visibility.
- Raw counts, calibrated measurements, sensor health, and recording status in one sidebar.
- Safe Pause, Resume, Bias, and buffered CSV recording workflows.
- Native installers and portable archives for Linux, Windows, and macOS.

### Changed

- Use the netft-cpp v0.3.1 core so fail-stop sessions do not surface stalled or
  backward FT-sequence samples.

[Unreleased]: https://github.com/netft/netft-viewer/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/netft/netft-viewer/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/netft/netft-viewer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/netft/netft-viewer/releases/tag/v0.1.0
