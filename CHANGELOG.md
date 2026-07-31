# Changelog

All notable changes to Net F/T Viewer are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Update the private netft-cpp core to v0.3.1 so fail-stop sessions do not surface
  stalled or backward FT-sequence samples.

## [0.1.0] - 2026-07-27

### Added

- Cross-platform desktop visualization for all six force and torque axes.
- Combined and six-panel chart layouts with configurable time windows and axis visibility.
- Raw counts, calibrated measurements, sensor health, and recording status in one sidebar.
- Safe Pause, Resume, Bias, and buffered CSV recording workflows.
- Native installers and portable archives for Linux, Windows, and macOS.

[Unreleased]: https://github.com/netft/netft-viewer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/netft/netft-viewer/releases/tag/v0.1.0
