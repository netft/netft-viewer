# Net F/T Viewer

[![CI](https://github.com/netft/netft-viewer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/netft/netft-viewer/actions/workflows/ci.yml)
[![Package](https://github.com/netft/netft-viewer/actions/workflows/package.yml/badge.svg?branch=main)](https://github.com/netft/netft-viewer/actions/workflows/package.yml)
[![CodeQL](https://github.com/netft/netft-viewer/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/netft/netft-viewer/actions/workflows/codeql.yml)
[![Coverage](https://codecov.io/gh/netft/netft-viewer/graph/badge.svg?branch=main)](https://codecov.io/gh/netft/netft-viewer)
[![License](https://img.shields.io/github/license/netft/netft-viewer?label=license)](LICENSE)

Net F/T Viewer is a cross-platform desktop application for connecting directly to one ATI Net F/T sensor, inspecting its six-axis wrench in real time, and recording calibrated data without a ROS installation.

![Net F/T Viewer showing six live force and torque panels](docs/images/screenshot.png)

## Features

- See raw counts and calibrated force and torque together with the units and calibration reported by the sensor.
- Switch between a combined plot and six individual panels, choose a 1–60 second window, and show or hide any axis.
- Pause the displayed measurements and CSV capture without stopping the sensor connection or health monitoring.
- Record accepted samples through a bounded memory buffer, with explicit overflow handling and recoverable partial files.

## Installation

Download the latest installer or portable archive for your platform from [GitHub Releases](https://github.com/netft/netft-viewer/releases).

| Platform | Architecture | Install artifacts |
| --- | --- | --- |
| Linux | x86_64, ARM64 | `.deb`, portable `.tar.gz` |
| Windows | x86_64 | Setup `.exe`, portable `.zip` |
| macOS | Intel and Apple silicon | Universal `.dmg`, universal `.zip` |

## Usage

### Connect to a sensor

Connect the computer and sensor to the same trusted network, configure a compatible IPv4 address on the computer, enter the sensor address, and select **Connect**. ATI sensors use `192.168.1.1` as their documented default address; use the address configured for your device if it has been changed.

The sidebar reports connection state, product name, receive and delivery rates, packet loss, device status, the latest error, recording progress, and buffer use. A stopped recorder is shown as **Stopped**; this does not affect the sensor connection or live display. The Live data table shows Fx, Fy, Fz, Tx, Ty, and Tz as both integer counts and calibrated values. Force and torque units come from the sensor configuration rather than from viewer defaults.

The chart toolbar provides:

- **Combined** and **6 panels** layouts.
- 1, 5, 10, 30, and 60 second time windows.
- Per-axis visibility controls.

The desktop menu provides the same connection, recording, layout, time-window, and axis actions through keyboard-accessible menus.

### Pause, Bias, and record

**Pause** freezes live numeric values and plots, drains and flushes accepted CSV samples, and then suspends CSV acceptance. The connection and health counters continue running. **Resume** restarts display updates and CSV acceptance; paused samples are not replayed into either view.

**Bias** asks for confirmation before sending the zero command and is unavailable while paused. Remove all load from the transducer and make sure zeroing is safe for the mechanism before confirming.

**Record** opens a save dialog and writes CSV data asynchronously. A bounded queue isolates the sensor callback from disk latency. The viewer never silently discards an accepted row: queue overflow or a write failure ends the recording with an explicit error. During recording, data is first written to `<name>.csv.partial`; a clean stop flushes every accepted row and atomically promotes it to the selected `.csv` path. If the application or storage fails, keep the partial file for recovery and inspect the final complete rows with a text or CSV tool.

## Security

ATI Net F/T configuration and RDT streaming use unauthenticated HTTP and UDP. Use the viewer only on a trusted, access-controlled sensor network; do not expose the sensor directly to the public internet or an untrusted wireless network. The viewer stores display preferences locally but does not store sensor credentials.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.

## Troubleshooting

### The viewer cannot connect

Confirm that the sensor is powered, the host network interface is in the same IPv4 subnet, and the sensor address is correct. Check local firewall rules for outbound HTTP and UDP traffic and inbound RDT replies on the negotiated socket. A browser request to the sensor configuration page can help distinguish HTTP reachability from streaming problems.

### Values appear but the units or scale are wrong

Disconnect, verify the active calibration on the sensor, and reconnect so the viewer discovers the authoritative counts and units again.

### Packet loss or reconnects increase

Use a wired connection, remove congested switches or wireless bridges from the sensor path, and check the receive and delivery rates. Pause does not reduce sensor traffic; disconnect when streaming is no longer required.

### A `.partial` file remains

The recording did not finish its verified promotion. Preserve the file, inspect its complete CSV rows, verify available disk space and permissions, and start a new recording with a new destination. The viewer does not overwrite a partial file silently.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and pull request guidance.

## License

Net F/T Viewer is licensed under the [Apache License 2.0](LICENSE). Required third-party license and notice texts are distributed in [LICENSES](LICENSES).
