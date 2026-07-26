# Net F/T Viewer Design

Date: 2026-07-26

Status: Approved design, pending written-spec review

## Summary

`netft-viewer` is a cross-platform desktop application for directly connecting to one ATI Net F/T Ethernet force/torque sensor, viewing live raw and calibrated measurements, monitoring stream health, applying software bias with an explicit safety confirmation, and recording complete delivered samples to CSV.

The application will run on Linux, Windows, and macOS. It will use an Electron, React, TypeScript, and Apache ECharts interface backed by an independent native C++ companion process. The companion will contain a private source snapshot of `netft-cpp`; it will not discover, download, or link to an external `netft-cpp` installation.

## Goals

- Provide a polished desktop viewer that users can install without ROS or a separate runtime.
- Connect directly to one Net F/T sensor by IP address.
- Display sensor state, stream health, raw counts, calibrated values, units, and configuration revision.
- Display six axes in either one combined plot or six independent plots.
- Preserve short force and torque transients while bounding renderer workload.
- Record every delivered sample while recording is active and not paused.
- Isolate sensor acquisition from UI stalls and short disk-write stalls.
- Ship native installation artifacts for Linux, Windows, and macOS.
- Keep the repository Apache-2.0 compatible and preserve complete third-party attribution.

## Non-goals

The first release will not:

- Subscribe to ROS 1 or ROS 2 topics.
- Open or replay existing CSV files.
- Connect to multiple sensors simultaneously.
- Provide remote access, a browser-hosted service, or a web server.
- Automatically reconnect or resume a recording after a companion process crash.
- Support Windows ARM64.
- Publish through the Microsoft Store, Mac App Store, Snapcraft, or Flathub.
- Provide automatic application updates.
- Use a git submodule, runtime download, conda package, or system installation of `netft-cpp`.

## User Interface

### Main window

The main window has no global top status bar. It uses a fixed left sidebar and a flexible right plotting workspace.

The sidebar contains:

1. A sensor connection section with an IP address field and Connect or Disconnect action.
2. A status section with connection state, product name, receive rate, delivery rate, packet loss, device status, latest error, recording state, recording duration, file size, and recording-buffer utilization.
3. A live wrench table with `Fx`, `Fy`, `Fz`, `Tx`, `Ty`, and `Tz`, raw signed counts, calibrated values, native units, and configuration revision.
4. Pause or Resume, Bias, and Record or Stop actions.

The sensor IP field initially uses the ATI documented default `192.168.1.1`. After a successful connection, the application stores that address as a local non-sensitive preference. The application never connects automatically.

The plotting workspace contains:

- A `Combined` view with all six series in one plot, using separate force and torque Y axes.
- A `6 panels` view with an independently scaled plot for each axis.
- A legend that can show or hide individual series.
- Time-window choices of 1, 5, 10, 30, and 60 seconds.
- Mouse zoom and pan controls.
- A `Reset view` action.
- A `Live` action that returns to automatic time-axis following after manual navigation.

The application stores the last selected plot view, time window, series visibility, and Light, Dark, or System theme. It does not store the last recording path.

### Pause semantics

Pause affects measurement viewing and recording, but it does not tear down the sensor connection.

When Pause is requested:

1. New samples stop entering the recording queue.
2. Samples already accepted for recording are drained.
3. The CSV stream is flushed.
4. The companion acknowledges the pause.
5. The UI freezes raw values, calibrated values, and plots and displays `Streaming · Paused` or `Recording paused`.

Connection and device health continue to update while paused.

If recording was active, Resume continues appending to the same partial file. Samples received during the pause are not backfilled. Timestamps and sequence fields make the intentional gap visible.

If recording was inactive, Pause only freezes measurement values and plots. A new recording cannot be started while paused. An existing paused recording may be stopped and finalized.

### Bias safety

Bias is available only while the sensor is streaming.

Every Bias request displays a confirmation dialog that states that the command changes the sensor output and asks the user to verify a safe, stable, expected load condition. The dialog has no persistent “do not show again” option.

Only an explicit confirmation sends the command to the companion. Success and failure are both reported visibly. A companion restart, application restart, reconnect, or recording resume never repeats Bias automatically.

### Recording interaction

Record opens the operating system save-file dialog and proposes a timestamped `.csv` filename. Recording begins only after the user confirms a destination and the companion confirms that the temporary file and writer are ready.

While recording, the UI displays elapsed time, bytes written, and buffer utilization. Stop disables new sample acceptance, drains the queue, flushes and closes the file, and atomically promotes the temporary file to the final `.csv`.

## Architecture

### Repository structure

```text
netft-viewer/
├── app/
│   ├── main/
│   ├── preload/
│   └── renderer/
├── core/
│   ├── netft/
│   ├── viewer/
│   └── companion/
├── protocol/
│   └── schemas/
├── packaging/
├── test/
├── CMakeLists.txt
├── package.json
├── pnpm-lock.yaml
├── CORE_SNAPSHOT.md
├── THIRD_PARTY_NOTICES.md
└── LICENSE
```

`app/main` owns the Electron lifecycle, native dialogs, companion supervision, validated IPC routing, and local settings.

`app/preload` exposes a narrow typed API to the renderer through Electron `contextBridge`.

`app/renderer` contains the React UI and ECharts plotting components. It cannot access Node.js, the filesystem, child processes, sockets, or arbitrary Electron IPC.

`core/netft` contains the auditable `netft-cpp` source snapshot.

`core/viewer` contains viewer-specific session state, plot aggregation, recording, CSV serialization, and companion-facing services.

`core/companion` contains the native executable entry point and stdin/stdout protocol adapter.

`protocol/schemas` is the source of truth for versioned command, response, and event payloads.

### Runtime boundaries

```text
ATI Net F/T sensor
        |
        | HTTP configuration and UDP RDT
        v
Native C++ companion
  - netft-cpp snapshot
  - health and latest sample
  - plot aggregation
  - lossless recording queue
  - CSV writer
        |
        | versioned JSON Lines over stdin/stdout
        v
Electron main process
  - schema validation
  - lifecycle supervision
  - native dialogs
        |
        | restricted Electron IPC
        v
Sandboxed renderer
  - React view model
  - ECharts
```

Sensor acquisition and recording remain native. The renderer never receives the complete recording stream and cannot affect CSV completeness through rendering delays.

### Cross-platform Net F/T transport

The snapshot keeps the existing protocol, discovery, status, recovery, and public data models.

The current POSIX-only UDP transport will be split behind one internal transport interface:

- Linux and macOS use the existing socket, poll, shutdown, and close behavior.
- Windows uses WinSock with RAII-managed `WSAStartup` and `WSACleanup`, `SOCKET`, `WSAPoll` or an equivalent bounded wait, `shutdown`, and `closesocket`.
- Both implementations expose the same connect, send, timed receive, shutdown, and close semantics.
- Shared fake-sensor contract tests run against both implementations.

HTTP configuration discovery continues through a pinned, privately linked libcurl build. Users do not need to install curl.

## State Model

### Connection

```text
Disconnected -> Connecting -> Streaming -> Disconnecting -> Disconnected
                    |             |
                    +-----------> Error

Streaming -> Reconnecting -> Streaming
                    |
                    +-----------> Error
```

The user may cancel Connecting or Reconnecting by disconnecting.

Pause and Recording are orthogonal session states rather than connection states.

### Measurement session

```text
Live <-> Paused
```

The session may enter Paused only while connected. Disconnecting clears Paused.

### Recording

```text
Idle -> Starting -> Recording -> Pausing -> Paused -> Recording
                         |                         |
                         +-------> Stopping <------+
                                      |
                                      v
                                    Idle

Starting, Recording, Pausing, Paused, or Stopping -> Error
```

Recording errors do not disconnect the sensor.

## Companion Protocol

The companion protocol uses UTF-8 JSON Lines over stdin and stdout. Human-readable logs use stderr exclusively.

Every envelope contains:

- Protocol major and minor version.
- Message type.
- Request ID for commands and responses.
- Monotonic timestamp.
- Typed payload.

Commands include:

- `hello`
- `connect`
- `disconnect`
- `set_paused`
- `bias`
- `start_recording`
- `stop_recording`
- `shutdown`

Events include:

- `connection_state`
- `health`
- `live_wrench`
- `plot_batch`
- `recording_state`
- `recording_progress`
- `configuration_changed`
- `error`

Unknown optional fields are ignored. Missing required fields, incorrect types, excessive array lengths, oversized messages, or incompatible protocol major versions are protocol errors.

The Electron main process validates all companion output before forwarding a smaller typed model to the renderer. The renderer cannot send arbitrary protocol envelopes; preload exposes one method for each allowed operation.

## Plot Data Pipeline

Sensor acquisition rate and chart refresh rate are independent.

The companion groups acquired samples into approximately 33 millisecond plot intervals, producing a nominal 30 Hz IPC update rate. For each axis, it selects the first, minimum, maximum, and last value in chronological order and removes duplicate selections.

This bounded first/minimum/maximum/last aggregation:

- Preserves short extrema that a latest-value-only strategy would miss.
- Avoids sending every sensor sample to Electron.
- Keeps plot memory bounded.
- Supports Combined and 6 panels from the same data.

The latest complete sample is sent separately for the sidebar.

At 30 aggregation intervals per second, each axis produces at most 120 plot points per second. A 10-second plot holds at most approximately 1,200 points per axis. The renderer evicts points older than the active time window.

While paused, plot aggregation output is discarded rather than queued. Resume begins with current data and does not replay the paused period.

## Recording Pipeline

### Queue

The acquisition callback pushes a fixed-size binary `RecordedSample` into a preallocated single-producer, single-consumer ring buffer.

The callback does not:

- Format numbers.
- Allocate memory during steady-state recording.
- Build CSV text.
- Flush a stream.
- Call the filesystem.
- Wait for the writer thread.

The initial queue capacity is 65,536 samples. The queue is not user-configurable in the first release.

A dedicated writer thread drains samples in batches, formats CSV into a large userspace buffer, and writes to the temporary file.

Queue utilization is reported to the UI:

- Below 75 percent is normal.
- 75 through 90 percent is a warning.
- Above 90 percent is a critical warning.
- A full queue terminates the current recording.

The acquisition callback is never blocked for disk backpressure. Queue overflow is never silently converted into dropped CSV rows.

### File lifecycle

An active recording writes to a sibling path ending in `.csv.partial`.

The companion creates the partial file exclusively and refuses to overwrite a partial file left by an earlier failed or interrupted recording. The user must preserve, move, or explicitly remove that recovery file before reusing the same destination.

The writer flushes its userspace stream buffer at least once per second and on Pause, Stop, Disconnect, recording failure, and orderly application shutdown. Periodic flush does not request a physical-disk synchronization for every interval; successful finalization closes the stream and relies on the operating system to complete the durable write.

Successful finalization performs:

1. Stop accepting recording samples.
2. Drain the queue.
3. Flush userspace buffers.
4. Close the file.
5. Atomically rename or replace the selected `.csv`.

If the selected final path already exists, the native save dialog must obtain an explicit overwrite confirmation before recording starts. The existing final file remains untouched until the new recording has been closed successfully, at which point platform-specific atomic replacement promotes the partial file.

A crash, disk-full condition, writer error, queue overflow, flush error, or rename error preserves the `.partial` file and reports its path.

### CSV schema

Every data row contains:

- Host receive timestamp in nanoseconds.
- Elapsed recording time.
- RDT sequence.
- FT sequence.
- Device status.
- Configuration revision.
- Six signed raw counts.
- Three calibrated force values.
- Three calibrated torque values.
- Force unit.
- Torque unit.

The rectangular schema remains valid if the sensor configuration revision or native units change during a recording. Pause intervals are represented by timestamp and sequence gaps rather than synthetic data rows.

## Error Handling

### Companion lifecycle

Electron validates the companion executable, protocol version, and core snapshot version at startup.

If the companion cannot start, the application displays a dedicated backend error view.

If the companion exits during use:

- The current connection is invalidated.
- An active recording remains as `.partial`.
- Electron restarts the companion but leaves the session disconnected.
- The sensor is not automatically reconnected.
- Recording and Bias are not automatically resumed.

After three consecutive start failures, automatic attempts stop and the UI provides an explicit Retry backend action and log location.

### Sensor and configuration failures

Configuration discovery, HTTP, UDP, timeout, sequence, and device-status failures use structured core error categories.

The UI displays a concise summary with expandable technical details. It displays Reconnecting and the reconnect count during recoverable network failures. Disconnect always cancels recovery.

The viewer never substitutes guessed calibration counts or units when sensor configuration discovery fails.

A configuration revision change updates the sidebar, affects subsequent CSV rows, and adds a visible event marker to the plot.

### Recording failures

File creation, permission, disk-full, writer, queue-overflow, flush, and rename failures stop recording while allowing live sensor viewing to continue.

The UI displays the failure category and the partial-file path. Recording never restarts automatically.

### Shutdown

Normal application shutdown disconnects the sensor, stops accepting recording samples, drains and finalizes active recording, and then stops the companion.

If finalization fails, the application identifies the partial file before permitting normal exit. Operating-system forced termination may prevent graceful completion, so the partial-file design remains the recovery mechanism.

## Electron Security

The application loads only packaged local renderer assets and does not display remote web content.

Security requirements:

- Renderer sandbox enabled.
- `contextIsolation` enabled.
- `nodeIntegration` disabled.
- Restrictive Content Security Policy.
- Navigation and unexpected new-window creation denied.
- Electron fuses configured to disable unused capabilities.
- Narrow `contextBridge` API.
- Sender validation on every Electron IPC handler.
- Runtime schema validation on every companion message.
- No arbitrary shell, filesystem, URL, or child-process API exposed to the renderer.
- Current supported Electron release line, with security updates handled promptly.

## Testing

### Native tests

Native unit and integration tests cover:

- Existing `netft-cpp` snapshot behavior.
- POSIX and WinSock transport contracts.
- Fake HTTP configuration and fake UDP sensor behavior.
- Connect, disconnect, reconnect, and Bias state transitions.
- Protocol encoding, decoding, limits, and version negotiation.
- First/minimum/maximum/last plot aggregation.
- Pause sample boundaries.
- SPSC queue concurrency.
- Slow disk, disk errors, queue overflow, and partial-file behavior.
- Companion startup, shutdown, and forced termination.

### Frontend tests

Vitest covers:

- Connection, pause, and recording reducers.
- Protocol payload to view-model conversion.
- Combined and 6 panels series mapping.
- Time-window eviction.
- Preference persistence.
- Control enablement from structured state.

Tests use stable semantic identifiers, typed states, and numeric output. They do not assert README text, marketing copy, or complete user-facing sentences.

### End-to-end tests

Playwright launches the packaged Electron application with a fake companion or fake sensor and covers:

- Connect and disconnect.
- Raw and calibrated updates.
- Plot-view switching.
- Pause freezing measurements and suspending CSV.
- Resume without paused-period backfill.
- Mandatory Bias confirmation.
- Recording finalization.
- Companion failure and safe restart.

### Performance and endurance

Performance tests verify:

- CSV rows equal delivered samples accepted while recording.
- Plot memory stays bounded by the active time window.
- Renderer stalls do not block acquisition or recording.
- Short disk stalls are absorbed by the queue.
- Long disk stalls produce an explicit recording failure.
- Long-running streaming and recording do not exhibit unbounded memory growth.

### Hardware tests

Hardware tests obtain the sensor address only through `NETFT_SENSOR_HOST`.

The repository, examples, workflow configuration, fixtures, and committed logs never contain a private laboratory IP address.

Bias requires the additional explicit `NETFT_ALLOW_BIAS=1` opt-in. Default hardware verification covers discovery, streaming, measurements, health, Pause, and recording without issuing Bias.

## Continuous Integration

Every pull request runs:

- C++ format, static analysis, unit tests, and integration tests.
- TypeScript formatting, linting, type checking, and unit tests.
- Electron end-to-end smoke tests.
- Linux, Windows, and macOS native builds.
- C++ address and undefined-behavior sanitizers where supported.
- CodeQL for C++ and JavaScript or TypeScript.
- Coverage upload to Codecov without a hard coverage threshold.
- Final-package smoke tests on the target operating system.

Dependabot groups npm and GitHub Actions updates to avoid excessive single-dependency pull requests.

## Build and Packaging

The frontend uses pnpm with a committed lockfile, Electron Forge, Vite, React, TypeScript, and Apache ECharts.

The companion uses CMake 3.21 or newer, C++17, and CTest.

The first version is `0.1.0`.

Release artifacts:

| Platform | Architecture | Artifacts |
| --- | --- | --- |
| Linux | x86_64 and ARM64 | `.deb` and portable `.tar.gz` |
| Windows | x86_64 | Squirrel `Setup.exe` and portable `.zip` |
| macOS | Universal Intel and Apple Silicon | `.dmg` and `.zip` |

Electron renderer resources are packaged in `asar`. The native companion remains outside `asar` as an executable resource.

Each target is built on its native GitHub-hosted runner. macOS x64 and ARM64 companion outputs are combined into the universal application.

The release workflow:

1. Validates the tag, package version, CMake version, and changelog version.
2. Runs the full platform test matrix.
3. Builds all artifacts.
4. Generates SHA-256 checksums.
5. Generates an SBOM and third-party notices.
6. Creates a draft GitHub release.
7. Downloads and verifies the draft assets.
8. Requires explicit publication of the verified draft.

The build is signing-ready for macOS codesign and notarization and for Windows Authenticode or Azure Artifact Signing. Unsigned artifacts may be used for development and pre-release verification, but stable public artifacts should be signed when credentials are available.

## License and Snapshot Provenance

`netft-viewer` uses Apache License 2.0.

The `core/netft` snapshot preserves all upstream copyright and license information.

`CORE_SNAPSHOT.md` records:

- Upstream repository URL.
- Exact upstream commit.
- Snapshot date.
- Files copied.
- Viewer-specific modifications.
- Manual synchronization procedure.

Synchronization is explicit and reviewable. The build does not fetch or discover `netft-cpp`, and short-term development does not require `ros-netft` or `pyNetFT` to consume this repository.

`THIRD_PARTY_NOTICES.md` and release SBOM output cover Electron, Chromium, Node.js, React, ECharts, libcurl, and all other distributed dependencies.

## Success Criteria

The first stable release is complete when:

- A user can install and launch the viewer on each supported platform without installing ROS, Node.js, curl, or `netft-cpp`.
- The viewer discovers authoritative calibration and native units from a sensor.
- Raw and calibrated values update correctly.
- Combined and six-panel plots preserve interval extrema and remain responsive.
- Pause freezes measurements and pauses active CSV recording.
- CSV contains every accepted delivered sample outside paused intervals.
- Disk stalls cannot block the sensor callback.
- Recording failures are explicit and preserve recoverable partial files.
- The application passes fake-sensor tests on Linux, Windows, and macOS.
- The application passes an opt-in supervised hardware test without committing the laboratory sensor address.
- GitHub Releases contains verified artifacts and checksums for the declared platform matrix.
