# Net F/T Viewer

[![CI](https://github.com/netft/netft-viewer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/netft/netft-viewer/actions/workflows/ci.yml)
[![Package](https://github.com/netft/netft-viewer/actions/workflows/package.yml/badge.svg?branch=main)](https://github.com/netft/netft-viewer/actions/workflows/package.yml)
[![Release](https://img.shields.io/github/v/release/netft/netft-viewer?display_name=tag&sort=semver)](https://github.com/netft/netft-viewer/releases)
[![CodeQL](https://github.com/netft/netft-viewer/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/netft/netft-viewer/actions/workflows/codeql.yml)
[![Coverage](https://codecov.io/gh/netft/netft-viewer/graph/badge.svg?branch=main)](https://codecov.io/gh/netft/netft-viewer)
[![License](https://img.shields.io/github/license/netft/netft-viewer?label=license)](LICENSE)

Net F/T Viewer is a cross-platform desktop application for inspecting and
recording live six-axis data from an ATI Net F/T Ethernet sensor without a ROS
installation.

![Net F/T Viewer showing six live force and torque panels](docs/images/screenshot.png)

## Features

- Shows raw counts and calibrated force and torque in sensor-reported units.
- Switches between one combined plot and six individual panels.
- Tracks connection state, receive rate, packet loss, status, and recording.
- Pauses display and CSV capture without losing connection-health monitoring.
- Records through a bounded buffer with explicit overflow and recovery behavior.

## Installation

Download the latest installer or portable archive from
[GitHub Releases](https://github.com/netft/netft-viewer/releases).

| Platform | Architecture | Artifacts |
| --- | --- | --- |
| Linux | x86-64, ARM64 | `.deb`, portable `.tar.gz` |
| Windows | x86-64 | Setup `.exe`, portable `.zip` |
| macOS | Intel and Apple silicon | Universal `.dmg`, universal `.zip` |

## Quick start

1. Connect the computer and sensor to the same trusted network.
2. Configure the computer with a compatible IPv4 address.
3. Start Net F/T Viewer, enter the sensor address, and select **Connect**.
4. Inspect the live values and health indicators before recording or biasing.

ATI sensors use `192.168.1.1` as their documented factory-default address. Use
the address configured for your device if it has been changed.

## Documentation

- [Connect and inspect](https://netft.dev/docs/tutorials/viewer/connect-and-inspect)
- [Record and review](https://netft.dev/docs/tutorials/viewer/record-and-review)
- [Troubleshooting](https://netft.dev/docs/tutorials/troubleshooting/)
- [Security and safety](https://netft.dev/docs/references/security-and-safety)

Pause freezes the displayed data and suspends CSV acceptance while connection
health continues to update. Bias changes the measurement zero; unload or
fixture the sensor and make the connected mechanism safe before confirming it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and pull-request
guidance. Report security issues through [SECURITY.md](SECURITY.md).

## License

Net F/T Viewer is licensed under the [Apache License 2.0](LICENSE). Required
third-party license and notice texts are distributed in [LICENSES](LICENSES).
