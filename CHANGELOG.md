# Changelog

All notable changes to Net F/T Viewer are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/netft/netft-viewer/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/netft/netft-viewer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/netft/netft-viewer/releases/tag/v0.1.0
