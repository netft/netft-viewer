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

Verified releases are published as stable releases. Windows packages are unsigned;
macOS packages use ad hoc signatures for code integrity and are not notarized.
Operating-system policy may require explicit approval before opening the application.

| Platform | Architecture            | Artifacts                          |
| -------- | ----------------------- | ---------------------------------- |
| Linux    | x86-64, ARM64           | `.deb`, portable `.tar.gz`         |
| Windows  | x86-64                  | Setup `.exe`, portable `.zip`      |
| macOS    | Intel and Apple silicon | Universal `.dmg`, universal `.zip` |

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

## Recording metadata

Viewer 0.2.1 and later write `<output>.metadata.json` after successful data finalization, using schema version 1 and kind `netft-recording`. CLI 0.3.0 and later use the same schema and these shared meanings:

| Field                                 | Meaning                                                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `producer`, `result`                  | `netft-cli` or `netft-viewer`; `complete` or CLI `interrupted` after a successful nonempty drain.                                                                                                        |
| `accepted_samples`, `written_samples` | Samples accepted into the recording queue and rows successfully written. These are not power-loss durability guarantees.                                                                                 |
| `sample_span_seconds`                 | Nonnegative host receive-time span between first and last written sample; zero for fewer than two samples.                                                                                               |
| `configuration_revisions`             | Unique revision identifiers in written rows, scoped to the producer session. They do not contain full calibration snapshots.                                                                             |
| `force_units`, `torque_units`         | Unique native unit symbols observed in written rows.                                                                                                                                                     |
| `recorded_rdt_gaps`                   | Sum of forward sequence gaps between written rows, using unsigned wraparound and ignoring backward jumps. Pauses, rate filtering and reconnects can contribute; this is not the SDK packet-loss counter. |
| `pause_count`                         | Accepted Viewer pauses; CLI has no pause operation and reports zero.                                                                                                                                     |
| `reconnect_count`                     | CLI SDK reconnect counter for the run; `null` for Viewer because its recorder does not own connection health.                                                                                            |
| `error`                               | `null` on successful finalization. Failure details remain in the CLI error or Viewer recorder state.                                                                                                     |

Partial or failed captures do not receive a completed summary. Metadata creation and promotion follow the data file's overwrite policy. The two files are finalized separately: a metadata failure reports an error and preserves the completed data file, and may leave a metadata partial for recovery. Keep both files when archiving a successful capture.

CLI 0.3.0 and later append `configuration_revision` to CSV without moving existing columns and add it inside the NDJSON sample object. Viewer records revisions in each CSV row. Older releases retain their documented formats.

## Window and zoom support

The application accepts windows down to 800 native pixels wide. A narrower CSS viewport caused by 125%–200% zoom reflows the toolbar and six plots; at 700 CSS pixels or below, the sidebar stacks above a scrollable plot workspace. Keyboard-operable plot controls retain visible focus. Charts expose image labels and live values remain available in the measurement table; connection and recording states use text in addition to color. Layout interaction checks covered Linux scenes at 1440×900 with 100% zoom, 1100×800 with 125%, and 1100×900 with 200%. These layout checks are separate from the cross-platform native build and package startup checks required for release.
