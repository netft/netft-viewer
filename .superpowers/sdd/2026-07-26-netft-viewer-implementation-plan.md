# Net F/T Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and release an installable Linux, Windows, and macOS desktop viewer that directly connects to one ATI Net F/T sensor, visualizes raw and calibrated six-axis data, safely applies Bias, and records complete unpaused samples to CSV.

**Architecture:** A sandboxed Electron, React, TypeScript, and ECharts frontend communicates through a narrow preload API with the Electron main process. Main supervises a native C++ companion over versioned JSON Lines; the companion owns a private `netft-cpp` snapshot, sensor communication, bounded plot aggregation, and lossless buffered CSV recording.

**Tech Stack:** C++17, CMake 3.21+, libcurl 8.21.0, GoogleTest 1.17.0, nlohmann/json 3.12.0, Node.js 24, pnpm 11.17.0, Electron 43.2.0, Electron Forge 7.11.2, React 19.2.8, TypeScript 7.0.2, Vite 8.1.5, Apache ECharts 6.1.0, Zod 4.4.3, Vitest 4.1.10, and Playwright 1.62.0.

## Global Constraints

- Keep all repository content in English and all repository code and documentation under Apache-2.0-compatible terms.
- Snapshot `netft-cpp` commit `e424c401587052f03de9b94f76f1e86b78902105` into `core/netft`; do not use a submodule, package lookup, runtime download, or network discovery.
- Use the ATI documented default sensor address `192.168.1.1`; never commit the laboratory sensor address.
- Support Linux x86_64 and ARM64, Windows x86_64, and macOS universal x86_64 plus ARM64.
- Use C++17 and CMake 3.21 or newer for the viewer, while preserving the snapshot core's public behavior.
- Keep the renderer sandboxed with context isolation enabled and Node integration disabled.
- Record every delivered sample accepted while Recording; Pause must freeze live measurements and plots and suspend CSV acceptance after draining and flushing accepted samples.
- Never block the sensor callback for disk I/O and never silently drop accepted recording samples.
- Use a 65,536-sample preallocated SPSC recording queue and terminate a recording explicitly on overflow.
- Aggregate plot data at a nominal 30 Hz using chronologically ordered first, minimum, maximum, and last points per axis.
- Keep CSV and plot pipelines independent.
- Tests must assert typed state, identifiers, structure, and numeric behavior rather than user-facing prose, README copy, or complete UI sentences.
- Upload coverage to Codecov without a hard coverage threshold.
- Require `NETFT_SENSOR_HOST` for hardware tests and a separate `NETFT_ALLOW_BIAS=1` opt-in for hardware Bias.
- Start repository versioning at `0.1.0`.

## Planned File Map

```text
app/
  main/
    companion-supervisor.ts       Starts, validates, restarts, and stops the native process.
    dialog-service.ts             Owns save-file and Bias confirmation dialogs.
    ipc-handlers.ts               Exposes the fixed renderer command surface.
    log-store.ts                  Writes bounded rolling companion stderr logs.
    main.ts                       Configures Electron security and window lifecycle.
    settings-store.ts             Persists validated non-sensitive preferences.
  preload/
    index.ts                      Publishes the typed `window.netft` API.
    netft-api.d.ts                Declares the renderer-visible API.
  renderer/
    components/
      Actions.tsx                 Pause, Bias, Record, and Stop controls.
      ChartToolbar.tsx            Plot mode, time window, Live, and Reset controls.
      ChartWorkspace.tsx          Combined and six-panel ECharts ownership.
      ConnectionPanel.tsx         Sensor address and connection controls.
      LiveWrenchTable.tsx         Raw and calibrated six-axis values.
      StatusPanel.tsx             Connection, health, recording, and queue status.
    model/
      app-state.ts                Typed renderer state and reducer.
      chart-model.ts              IPC plot batches to bounded ECharts series.
    styles/
      theme.css                   Light, dark, and system variables.
      viewer.css                  Fixed sidebar and flexible plot layout.
    App.tsx                       Composes the approved screen.
    main.tsx                      Mounts React and subscribes to preload events.
core/
  netft/                          Private snapshot of the native library.
  viewer/
    include/netft_viewer/
      axis.hpp                    Stable six-axis enumeration and conversions.
      clock.hpp                   Injectable host and monotonic clock abstraction.
      plot_aggregator.hpp         Bounded first/min/max/last plot aggregation.
      recorded_sample.hpp         Fixed-size recording row model.
      recorder.hpp                Asynchronous recording state machine.
      recording_queue.hpp         Preallocated SPSC ring buffer.
      session.hpp                 Connection, pause, Bias, plot, and recording orchestration.
    src/                          Implementations for the preceding interfaces.
  companion/
    include/netft_viewer_companion/
      messages.hpp                Typed companion commands, responses, and events.
      protocol.hpp                JSON envelope parsing and serialization.
    src/
      main.cpp                    JSON Lines process loop.
      protocol.cpp                Strict protocol implementation.
protocol/
  schemas/
    envelope.schema.json          Shared protocol envelope contract.
    commands.schema.json          Allowed main-to-companion commands.
    events.schema.json            Allowed companion-to-main events.
  fixtures/                       Valid and invalid cross-language fixtures.
test/
  core/                           Native viewer-core tests.
  companion/                      Native protocol and process tests.
  electron/                       Vitest main/preload/renderer tests.
  e2e/                            Playwright packaged-application tests.
  support/                        Fake sensor, fake clocks, slow writer, and fake companion.
packaging/
  icons/                          Source and generated platform icons.
  entitlements.mac.plist          Minimal hardened-runtime entitlements.
cmake/
  Dependencies.cmake              Pinned curl, GoogleTest, and nlohmann/json.
tools/
  build-curl.cmake                Configures the private HTTP-only static curl build.
  check-versions.mjs              Enforces version consistency.
  copy-companion.mjs              Stages the native executable for Forge.
  hardware-test.sh                Safe opt-in hardware verification.
.github/
  workflows/                      CI, CodeQL, coverage, package, and release workflows.
```

---

### Task 1: Repository Foundation and Reproducible Toolchains

**Files:**
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `.npmrc`
- Create: `LICENSE`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `pixi.toml`
- Create: `CMakeLists.txt`
- Create: `tools/check-versions.mjs`
- Create: `test/project/version.test.mjs`

**Interfaces:**
- Consumes: Design version `0.1.0` and the exact dependency versions in Global Constraints.
- Produces: `pnpm check:versions`, `pnpm test:project`, `pixi run native-configure`, and top-level CMake targets used by all later tasks.

- [ ] **Step 1: Write the failing version-consistency test**

```javascript
// test/project/version.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("package and CMake versions match", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const cmake = readFileSync("CMakeLists.txt", "utf8");
  const match = cmake.match(/project\\(netft_viewer VERSION ([0-9]+\\.[0-9]+\\.[0-9]+)/);
  assert.equal(match?.[1], pkg.version);
});
```

- [ ] **Step 2: Run the test and verify the missing project files fail**

Run: `pixi exec --spec nodejs=24 node --test test/project/version.test.mjs`

Expected: FAIL because `package.json` does not exist.

- [ ] **Step 3: Create the minimal project manifests**

Use exact package versions and scripts:

```json
{
  "name": "netft-viewer",
  "productName": "Net F/T Viewer",
  "version": "0.1.0",
  "private": true,
  "license": "Apache-2.0",
  "packageManager": "pnpm@11.17.0",
  "scripts": {
    "check:versions": "node tools/check-versions.mjs",
    "test:project": "node --test test/project/version.test.mjs"
  },
  "devDependencies": {
    "pnpm": "11.17.0"
  }
}
```

```cmake
cmake_minimum_required(VERSION 3.21)
project(netft_viewer VERSION 0.1.0 LANGUAGES CXX)
include(CTest)
add_subdirectory(core)
```

Configure `.npmrc` with `node-linker=hoisted`, and configure `pixi.toml` with Node.js 24, pnpm 11.17.0, CMake, Ninja, clang, clang-tools, and pkg-config on supported development platforms.

Define these Pixi tasks:

```toml
[tasks]
native-configure = "cmake -S . -B build/native -G Ninja -DBUILD_TESTING=ON -DCMAKE_BUILD_TYPE=Debug"
native-build = "cmake --build build/native"
native-test = "ctest --test-dir build/native --output-on-failure"
format-check = "pnpm exec prettier --check app protocol test tools && clang-format --dry-run --Werror $(find core test -type f \\( -name '*.cpp' -o -name '*.hpp' \\))"
tidy = "run-clang-tidy -p build/native"
```

- [ ] **Step 4: Implement the reusable version checker**

```javascript
// tools/check-versions.mjs
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const cmake = readFileSync("CMakeLists.txt", "utf8");
const version = cmake.match(/project\\(netft_viewer VERSION ([0-9]+\\.[0-9]+\\.[0-9]+)/)?.[1];
if (version !== pkg.version) {
  throw new Error(`version mismatch: package=${pkg.version} cmake=${version ?? "missing"}`);
}
```

- [ ] **Step 5: Install dependencies and verify the foundation**

Run: `pixi exec --spec nodejs=24 --spec pnpm=11.17.0 pnpm install`

Run: `pixi exec --spec nodejs=24 node --test test/project/version.test.mjs`

Run: `pixi exec --spec nodejs=24 node tools/check-versions.mjs`

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add .editorconfig .gitignore .npmrc LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml pixi.toml CMakeLists.txt tools/check-versions.mjs test/project/version.test.mjs
git commit -m "build: establish viewer toolchains"
```

---

### Task 2: Import the Auditable netft-cpp Snapshot

**Files:**
- Create: `core/CMakeLists.txt`
- Create: `core/netft/CMakeLists.txt`
- Create: `core/netft/include/netft/*.hpp`
- Create: `core/netft/src/**/*.cpp`
- Create: `core/netft/test/**/*`
- Create: `cmake/Dependencies.cmake`
- Create: `CORE_SNAPSHOT.md`
- Create: `LICENSES/curl.txt`
- Create: `test/project/snapshot.test.mjs`
- Test: `core/netft/test/test_discovery.cpp`
- Test: `core/netft/test/test_client_stream.cpp`

**Interfaces:**
- Consumes: Upstream commit `e424c401587052f03de9b94f76f1e86b78902105`.
- Produces: Private CMake target `netft_viewer_netft`, public snapshot headers under `core/netft/include/netft`, and the existing `netft-cpp` test suite.

- [ ] **Step 1: Add a provenance test that fails before the snapshot exists**

```javascript
// test/project/snapshot.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("snapshot records the exact upstream commit", () => {
  const text = readFileSync("CORE_SNAPSHOT.md", "utf8");
  assert.match(text, /e424c401587052f03de9b94f76f1e86b78902105/);
});
```

Run: `pixi exec --spec nodejs=24 node --test test/project/snapshot.test.mjs`

Expected: FAIL because `CORE_SNAPSHOT.md` does not exist.

- [ ] **Step 2: Copy only the library and native tests from upstream**

Copy `include/netft`, `src`, and `test` from `/home/sustechdl/Documents/netft-cpp` at the exact commit. Do not copy the CLI, release workflows, Pixi files, or upstream top-level packaging.

Document the repository URL, commit, snapshot date, copied paths, excluded paths, and a manual file-by-file synchronization procedure in `CORE_SNAPSHOT.md`.

- [ ] **Step 3: Pin native dependencies**

```cmake
# cmake/Dependencies.cmake
include(FetchContent)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_CURL_EXE OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(HTTP_ONLY ON CACHE BOOL "" FORCE)
set(CURL_USE_LIBPSL OFF CACHE BOOL "" FORCE)
set(CURL_ZLIB OFF CACHE BOOL "" FORCE)
FetchContent_Declare(curl
  URL https://curl.se/download/curl-8.21.0.tar.xz
  URL_HASH SHA256=aa1b66a70eace83dc624508745646c08ae561de512ab403adffb93ac87fc72e6
)
FetchContent_MakeAvailable(curl)

FetchContent_Declare(googletest
  GIT_REPOSITORY https://github.com/google/googletest.git
  GIT_TAG v1.17.0
  GIT_SHALLOW TRUE
)

FetchContent_Declare(nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.12.0
  GIT_SHALLOW TRUE
)
```

Scope third-party CMake cache settings so the root project restores its own `BUILD_TESTING` and `BUILD_SHARED_LIBS` behavior after dependency configuration.

- [ ] **Step 4: Create the private snapshot target**

```cmake
add_library(netft_viewer_netft STATIC
  src/types.cpp
  src/status.cpp
  src/discovery.cpp
  src/client.cpp
  src/detail/client_impl.cpp
  src/detail/fault_latch.cpp
  src/detail/posix_transport.cpp
  src/detail/protocol.cpp
  src/detail/sequence.cpp
  src/detail/xml_config.cpp
)
target_compile_features(netft_viewer_netft PUBLIC cxx_std_17)
target_include_directories(netft_viewer_netft PUBLIC include PRIVATE src)
target_link_libraries(netft_viewer_netft PUBLIC Threads::Threads CURL::libcurl)
```

Keep the target private to this repository; do not install or export it.

- [ ] **Step 5: Build and run the imported tests**

Run: `pixi run native-configure`

Run: `pixi run native-build`

Run: `pixi run native-test`

Expected: all imported non-hardware tests pass.

Run: `pixi exec --spec nodejs=24 node --test test/project/snapshot.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core cmake/Dependencies.cmake CORE_SNAPSHOT.md LICENSES/curl.txt test/project/snapshot.test.mjs
git commit -m "feat: snapshot the native Net F/T core"
```

---

### Task 3: Add a Cross-platform UDP Transport

**Files:**
- Create: `core/netft/src/detail/udp_transport.hpp`
- Create: `core/netft/src/detail/udp_transport_posix.cpp`
- Create: `core/netft/src/detail/udp_transport_windows.cpp`
- Modify: `core/netft/src/detail/client_impl.hpp`
- Modify: `core/netft/src/detail/client_impl.cpp`
- Modify: `core/netft/CMakeLists.txt`
- Create: `core/netft/test/test_udp_transport.cpp`
- Modify: `CORE_SNAPSHOT.md`

**Interfaces:**
- Consumes: `netft::detail::ClientImpl` and the existing POSIX transport behavior.
- Produces: `netft::detail::UdpTransport::{connect,send,receive,shutdown,close}` with identical POSIX and WinSock semantics.

- [ ] **Step 1: Write the platform-neutral failing transport contract test**

```cpp
TEST(UdpTransportTest, ReceivesARecordAndShutdownInterruptsAWait) {
  FakeUdpPeer peer;
  netft::detail::UdpTransport transport;
  transport.connect(peer.host(), peer.port());
  transport.send(netft::detail::encode_request(netft::detail::Command::StartRealtime));
  peer.reply_with(valid_record());
  std::array<std::uint8_t, 64> bytes{};
  EXPECT_GT(transport.receive(bytes.data(), bytes.size(), 100ms), 0U);
  transport.shutdown();
  EXPECT_EQ(transport.receive(bytes.data(), bytes.size(), 10ms), 0U);
}
```

- [ ] **Step 2: Rename the POSIX implementation without changing behavior**

Move the existing implementation into `udp_transport_posix.cpp`, rename `PosixTransport` to `UdpTransport`, and update `client_impl` to own `UdpTransport`.

Run: `pixi run native-test`

Expected: imported lifecycle, recovery, and transport tests pass on Linux.

- [ ] **Step 3: Implement WinSock with the same interface**

```cpp
class WinSockRuntime {
public:
  WinSockRuntime();
  ~WinSockRuntime();
  WinSockRuntime(const WinSockRuntime &) = delete;
  WinSockRuntime &operator=(const WinSockRuntime &) = delete;
};

class UdpTransport {
public:
  void connect(const std::string &host, int port);
  void send(std::array<std::uint8_t, 8> request);
  std::size_t receive(std::uint8_t *data, std::size_t capacity,
                      std::chrono::duration<double> timeout);
  void shutdown() noexcept;
  void close() noexcept;
};
```

Use `getaddrinfo`, `socket`, `connect`, bounded `WSAPoll`, `recv`, `shutdown`, and `closesocket`. Convert `WSAGetLastError()` into operation-specific exceptions. Treat interrupted waits and shutdown as non-record results rather than malformed packets.

- [ ] **Step 4: Select exactly one platform source in CMake**

```cmake
if(WIN32)
  target_sources(netft_viewer_netft PRIVATE src/detail/udp_transport_windows.cpp)
  target_link_libraries(netft_viewer_netft PRIVATE ws2_32)
else()
  target_sources(netft_viewer_netft PRIVATE src/detail/udp_transport_posix.cpp)
endif()
```

- [ ] **Step 5: Verify Linux behavior and Windows compilation**

Run: `pixi run native-test`

Run on Windows CI: `cmake -S . -B build/windows -G Ninja -DBUILD_TESTING=ON && cmake --build build/windows && ctest --test-dir build/windows --output-on-failure`

Expected: the same transport contract and imported client tests pass on both platforms.

- [ ] **Step 6: Record the viewer-local platform modification and commit**

```bash
git add core/netft CORE_SNAPSHOT.md
git commit -m "feat: support Net F/T transport on Windows"
```

---

### Task 4: Implement the Bounded Recording Queue and CSV Writer

**Files:**
- Create: `core/viewer/CMakeLists.txt`
- Create: `core/viewer/include/netft_viewer/axis.hpp`
- Create: `core/viewer/include/netft_viewer/recorded_sample.hpp`
- Create: `core/viewer/include/netft_viewer/recording_queue.hpp`
- Create: `core/viewer/include/netft_viewer/recorder.hpp`
- Create: `core/viewer/src/recorder.cpp`
- Create: `test/core/test_recording_queue.cpp`
- Create: `test/core/test_recorder.cpp`
- Create: `test/support/controlled_writer.hpp`

**Interfaces:**
- Consumes: `netft::Sample`.
- Produces: `Recorder::start`, `Recorder::submit`, `Recorder::pause`, `Recorder::resume`, `Recorder::stop`, and `Recorder::snapshot`.

- [ ] **Step 1: Write failing SPSC capacity and ordering tests**

```cpp
TEST(RecordingQueueTest, PreservesOrderAndRejectsOverflow) {
  RecordingQueue<int, 4> queue;
  EXPECT_TRUE(queue.try_push(1));
  EXPECT_TRUE(queue.try_push(2));
  EXPECT_TRUE(queue.try_push(3));
  EXPECT_TRUE(queue.try_push(4));
  EXPECT_FALSE(queue.try_push(5));
  int value{};
  EXPECT_TRUE(queue.try_pop(value));
  EXPECT_EQ(value, 1);
}
```

Run: `ctest --test-dir build/native -R RecordingQueue --output-on-failure`

Expected: FAIL because `RecordingQueue` does not exist.

- [ ] **Step 2: Implement the fixed-size queue**

```cpp
template <typename T, std::size_t Capacity> class RecordingQueue {
public:
  bool try_push(const T &value) noexcept;
  bool try_pop(T &value) noexcept;
  std::size_t size() const noexcept;
  static constexpr std::size_t capacity() noexcept { return Capacity; }
private:
  alignas(64) std::atomic<std::size_t> write_{0};
  alignas(64) std::atomic<std::size_t> read_{0};
  std::array<T, Capacity> storage_{};
};
```

Use release publication from the producer and acquire observation from the consumer. Require `T` to be trivially copyable.

- [ ] **Step 3: Write failing recorder lifecycle tests**

```cpp
TEST(RecorderTest, PauseDrainsAndResumeCreatesAnIntentionalGap) {
  ManualClock clock;
  Recorder recorder({.flush_interval = 1s}, clock);
  recorder.start(target_csv(), metadata());
  ASSERT_EQ(recorder.submit(sample_at(1)), SubmitResult::Accepted);
  ASSERT_EQ(recorder.pause(), RecorderResult::Ok);
  EXPECT_EQ(recorder.submit(sample_at(2)), SubmitResult::Paused);
  ASSERT_EQ(recorder.resume(), RecorderResult::Ok);
  ASSERT_EQ(recorder.submit(sample_at(3)), SubmitResult::Accepted);
  ASSERT_EQ(recorder.stop(), RecorderResult::Ok);
  EXPECT_EQ(read_sequences(target_csv()), (std::vector{1U, 3U}));
}
```

Add separate tests for exclusive partial-file creation, overwrite confirmation input, one-second flush, queue overflow, disk write error, atomic promotion, and partial-file retention.

- [ ] **Step 4: Implement the recorder state machine**

```cpp
enum class RecordingState { Idle, Starting, Recording, Pausing, Paused, Stopping, Error };
enum class SubmitResult { Accepted, Idle, Paused, Overflow, Failed };

struct RecorderSnapshot {
  RecordingState state;
  std::filesystem::path partial_path;
  std::uint64_t accepted_samples;
  std::uint64_t written_samples;
  std::size_t queue_size;
  std::size_t queue_capacity;
  std::string last_error;
};
```

The recorder owns `RecordingQueue<RecordedSample, 65'536>` directly so the capacity is fixed at compile time and cannot disagree with the design. Use a dedicated writer thread, an atomic acceptance gate, an in-flight submit counter, condition variables outside the producer hot path, batch formatting, a one-second flush deadline, and a platform replacement helper. A full queue atomically transitions to Error and prevents further acceptance.

- [ ] **Step 5: Verify behavior under concurrency and injected disk stalls**

Run: `ctest --test-dir build/native -R 'RecordingQueue|Recorder' --output-on-failure`

Expected: all tests pass, accepted rows equal finalized CSV rows, and the producer test thread never waits on the controlled writer.

Run with sanitizers: `cmake -S . -B build/asan -DNETFT_VIEWER_SANITIZERS=ON -DBUILD_TESTING=ON && cmake --build build/asan && ctest --test-dir build/asan -R 'RecordingQueue|Recorder' --output-on-failure`

- [ ] **Step 6: Commit**

```bash
git add core/viewer test/core test/support/controlled_writer.hpp
git commit -m "feat: add lossless buffered CSV recording"
```

---

### Task 5: Implement Bounded Plot Aggregation

**Files:**
- Create: `core/viewer/include/netft_viewer/clock.hpp`
- Create: `core/viewer/include/netft_viewer/plot_aggregator.hpp`
- Create: `core/viewer/src/plot_aggregator.cpp`
- Create: `test/core/test_plot_aggregator.cpp`
- Create: `test/support/manual_clock.hpp`

**Interfaces:**
- Consumes: timestamped `netft::Sample`.
- Produces: `std::optional<PlotBatch> PlotAggregator::push(const TimedSample&)` and `void PlotAggregator::reset()`.

- [ ] **Step 1: Write failing first/minimum/maximum/last tests**

```cpp
TEST(PlotAggregatorTest, EmitsChronologicalUniqueExtrema) {
  PlotAggregator aggregator(33ms);
  aggregator.push(timed_sample(0ms, axis_values(4.0)));
  aggregator.push(timed_sample(5ms, axis_values(-2.0)));
  aggregator.push(timed_sample(10ms, axis_values(8.0)));
  const auto batch = aggregator.push(timed_sample(34ms, axis_values(6.0)));
  ASSERT_TRUE(batch.has_value());
  EXPECT_EQ(values_for(*batch, Axis::Fx), (std::vector{4.0, -2.0, 8.0}));
}
```

Add tests for duplicate extrema, a one-sample interval, all six independent axes, reset on Pause or Resume, and monotonic batch timestamps.

- [ ] **Step 2: Define stable plot types**

```cpp
enum class Axis : std::uint8_t { Fx, Fy, Fz, Tx, Ty, Tz };

struct PlotPoint {
  std::int64_t host_time_ns;
  double value;
};

struct AxisPlotBatch {
  Axis axis;
  std::array<PlotPoint, 4> points;
  std::uint8_t count;
};

struct PlotBatch {
  std::array<AxisPlotBatch, 6> axes;
};
```

- [ ] **Step 3: Implement interval aggregation**

Track first, minimum, maximum, and last candidates with their real timestamps for each axis. At the interval boundary, sort selected indices by timestamp, remove duplicate sample indices, emit at most four points per axis, and seed the next interval with the boundary sample.

- [ ] **Step 4: Verify bounded output**

Run: `ctest --test-dir build/native -R PlotAggregator --output-on-failure`

Expected: PASS and no axis emits more than four points per interval.

- [ ] **Step 5: Commit**

```bash
git add core/viewer test/core/test_plot_aggregator.cpp test/support/manual_clock.hpp
git commit -m "feat: aggregate bounded real-time plot data"
```

---

### Task 6: Orchestrate Sensor, Pause, Plot, Bias, and Recording

**Files:**
- Create: `core/viewer/include/netft_viewer/session.hpp`
- Create: `core/viewer/src/session.cpp`
- Create: `test/core/test_session.cpp`
- Reuse: `core/netft/test/support/fake_sensor.*`

**Interfaces:**
- Consumes: `netft::Client`, `Recorder`, `PlotAggregator`, and an injected `SessionEventSink`.
- Produces: `ViewerSession::{connect,disconnect,set_paused,bias,start_recording,stop_recording,snapshot}`.

- [ ] **Step 1: Write failing session-state tests**

```cpp
TEST(ViewerSessionTest, PauseFreezesMeasurementsAndPausesRecordingAfterDrain) {
  FakeSensor sensor;
  CapturingEventSink events;
  ViewerSession session(events, test_dependencies());
  session.connect(config_for(sensor));
  session.start_recording(target_csv(), false);
  sensor.send(sample(1));
  ASSERT_TRUE(events.wait_for_live_sample(1));
  session.set_paused(true);
  sensor.send(sample(2));
  EXPECT_FALSE(events.has_live_sample(2));
  EXPECT_EQ(session.snapshot().recording.state, RecordingState::Paused);
}
```

Add tests that Bias is rejected unless Streaming, disconnect clears Pause, recording failure preserves Streaming, configuration revision changes emit events, and reconnect state remains cancelable.

- [ ] **Step 2: Define the event boundary**

```cpp
class SessionEventSink {
public:
  virtual ~SessionEventSink() = default;
  virtual void connection_changed(const ConnectionSnapshot &) = 0;
  virtual void health_changed(const netft::HealthSnapshot &) = 0;
  virtual void live_wrench(const TimedSample &) = 0;
  virtual void plot_batch(const PlotBatch &) = 0;
  virtual void recording_changed(const RecorderSnapshot &) = 0;
  virtual void configuration_changed(const netft::SensorConfiguration &) = 0;
  virtual void error(const SessionError &) = 0;
};
```

- [ ] **Step 3: Implement session orchestration**

The sensor callback computes the host timestamp, updates the latest sample, attempts recorder submission only when accepted, and pushes into the plot aggregator only when Live. Health polling runs at 5 Hz. `set_paused(true)` closes both acceptance gates, waits for recorder drain and flush, resets plot aggregation, then emits Paused. Resume reopens gates without replaying samples.

- [ ] **Step 4: Verify with the fake sensor**

Run: `ctest --test-dir build/native -R ViewerSession --output-on-failure`

Expected: all state transitions and side effects pass without hardware.

- [ ] **Step 5: Commit**

```bash
git add core/viewer/include/netft_viewer/session.hpp core/viewer/src/session.cpp test/core/test_session.cpp
git commit -m "feat: orchestrate viewer measurement sessions"
```

---

### Task 7: Define and Validate the Versioned Companion Protocol

**Files:**
- Create: `protocol/schemas/envelope.schema.json`
- Create: `protocol/schemas/commands.schema.json`
- Create: `protocol/schemas/events.schema.json`
- Create: `protocol/fixtures/*.jsonl`
- Create: `core/companion/CMakeLists.txt`
- Create: `core/companion/include/netft_viewer_companion/messages.hpp`
- Create: `core/companion/include/netft_viewer_companion/protocol.hpp`
- Create: `core/companion/src/protocol.cpp`
- Create: `test/companion/test_protocol.cpp`
- Create: `app/main/protocol.ts`
- Create: `test/electron/protocol.test.ts`

**Interfaces:**
- Consumes: `ViewerSession` commands and events.
- Produces: protocol major `1`, protocol minor `0`, strict C++ parse/serialize functions, and Zod `CompanionEventSchema`.

- [ ] **Step 1: Create shared valid and invalid fixture cases**

```json
{"protocol":{"major":1,"minor":0},"type":"connect","requestId":"req-1","monotonicNs":"42","payload":{"sensorHost":"192.168.1.1"}}
```

Invalid fixtures must cover missing payload, invalid host type, unknown command, incompatible major version, excessive plot points, and a line above the one-megabyte limit.

- [ ] **Step 2: Write failing C++ and TypeScript conformance tests**

```cpp
TEST(ProtocolTest, ParsesEveryValidCommandFixture) {
  for (const auto &line : valid_command_fixture_lines()) {
    EXPECT_NO_THROW(parse_command(line));
  }
}
```

```typescript
it("accepts every valid event fixture", () => {
  for (const value of validEventFixtures()) {
    expect(CompanionEventSchema.safeParse(value).success).toBe(true);
  }
});
```

- [ ] **Step 3: Define exact command and event payloads**

Commands: `hello`, `connect`, `disconnect`, `set_paused`, `bias`, `start_recording`, `stop_recording`, and `shutdown`.

Responses: `hello` for version negotiation and `command_result` for every other correlated command.

Events: `connection_state`, `health`, `live_wrench`, `plot_batch`, `recording_state`, `recording_progress`, `configuration_changed`, and `error`.

Represent 64-bit nanoseconds and counters as decimal strings in JSON to avoid JavaScript precision loss.

- [ ] **Step 4: Implement C++ parsing and serialization**

```cpp
using Command = std::variant<HelloCommand, ConnectCommand, DisconnectCommand,
                             SetPausedCommand, BiasCommand, StartRecordingCommand,
                             StopRecordingCommand, ShutdownCommand>;

Command parse_command(std::string_view line);
std::string serialize_event(const CompanionEvent &event);
```

Reject duplicate object keys, lines over 1 MiB, wrong scalar types, missing required fields, and unsupported major versions. Ignore unknown optional fields.

- [ ] **Step 5: Implement Zod validation in Electron main**

```typescript
export const EnvelopeSchema = z.object({
  protocol: z.object({ major: z.literal(1), minor: z.number().int().nonnegative() }),
  type: z.string(),
  requestId: z.string().optional(),
  monotonicNs: z.string().regex(/^[0-9]+$/),
  payload: z.unknown(),
});
```

Discriminate event payloads by `type`, cap plot arrays at four points per axis per batch, and expose parsed typed events only.

- [ ] **Step 6: Run both conformance suites and commit**

Run: `ctest --test-dir build/native -R Protocol --output-on-failure`

Run: `pnpm vitest run test/electron/protocol.test.ts`

Expected: both suites accept all valid fixtures and reject all invalid fixtures.

```bash
git add protocol core/companion app/main/protocol.ts test/companion test/electron/protocol.test.ts
git commit -m "feat: define the companion protocol"
```

---

### Task 8: Build the Native Companion Process

**Files:**
- Create: `core/companion/src/main.cpp`
- Create: `core/companion/src/companion.cpp`
- Create: `core/companion/include/netft_viewer_companion/companion.hpp`
- Create: `test/companion/test_companion.cpp`
- Create: `test/companion/companion_process_test.py`

**Interfaces:**
- Consumes: JSON Lines commands and `ViewerSession`.
- Produces: executable `netft-viewer-companion`, one JSON event per stdout line, and structured stderr diagnostics.

- [ ] **Step 1: Write a failing subprocess handshake test**

```python
def test_companion_hello_reports_matching_versions(companion):
    process = companion.start()
    process.send(command("hello", request_id="req-1"))
    event = process.read_event()
    assert event["type"] == "hello"
    assert event["payload"]["protocolMajor"] == 1
    assert event["payload"]["appVersion"] == "0.1.0"
```

- [ ] **Step 2: Implement the process loop**

```cpp
int Companion::run(std::istream &commands, std::ostream &events, std::ostream &logs) {
  std::string line;
  while (std::getline(commands, line)) {
    dispatch(parse_command(line));
    flush_events(events);
    if (shutdown_requested_) {
      return 0;
    }
  }
  session_.disconnect();
  return 0;
}
```

Use one serialized event-output queue so session worker callbacks never write stdout concurrently. Flush each complete event line. Never place logs on stdout.

- [ ] **Step 3: Map every protocol command to the session API**

Return a response correlated by request ID for command success or failure. Emit state events independently. Treat malformed input as a request error when a request ID can be recovered and as a protocol error otherwise.

- [ ] **Step 4: Verify fake-sensor streaming and recording end to end**

Run: `python3 -m pytest test/companion/companion_process_test.py -q`

Run: `ctest --test-dir build/native -R Companion --output-on-failure`

Expected: handshake, connect, streaming events, Pause, Resume, Bias against fake hardware, recording finalization, and shutdown pass.

- [ ] **Step 5: Commit**

```bash
git add core/companion test/companion
git commit -m "feat: add the native viewer companion"
```

---

### Task 9: Establish the Secure Electron Shell and Companion Supervisor

**Files:**
- Modify: `package.json`
- Create: `forge.config.ts`
- Create: `vite.main.config.ts`
- Create: `vite.preload.config.ts`
- Create: `vite.renderer.config.ts`
- Create: `app/main/main.ts`
- Create: `app/main/companion-supervisor.ts`
- Create: `app/main/ipc-handlers.ts`
- Create: `app/main/log-store.ts`
- Create: `app/preload/index.ts`
- Create: `app/preload/netft-api.d.ts`
- Create: `test/electron/companion-supervisor.test.ts`
- Create: `test/electron/security.test.ts`

**Interfaces:**
- Consumes: Packaged companion and `CompanionEventSchema`.
- Produces: `CompanionSupervisor`, fixed IPC channels, and typed `window.netft`.

- [ ] **Step 1: Install exact Electron dependencies**

```bash
pnpm add --save-exact electron@43.2.0 react@19.2.8 react-dom@19.2.8 echarts@6.1.0 zod@4.4.3
pnpm add -D --save-exact @electron-forge/cli@7.11.2 @electron-forge/plugin-vite@7.11.2 typescript@7.0.2 vite@8.1.5 @vitejs/plugin-react@6.0.4 vitest@4.1.10 @playwright/test@1.62.0 @testing-library/react@16.3.2 jsdom@29.1.1 eslint@10.8.0 typescript-eslint@8.65.0 prettier@3.9.6 @types/node@24.13.3 @types/react@19.2.17 @types/react-dom@19.2.3
```

Add exact scripts for `start`, `package`, `make`, `lint`, `typecheck`, `test`, and `test:e2e`. `test` must run project-contract, native, Vitest, and companion-process suites without invoking hardware.

- [ ] **Step 2: Write failing supervisor and security tests**

```typescript
it("stops after three consecutive start failures", async () => {
  const supervisor = new CompanionSupervisor(failingSpawner());
  await supervisor.start();
  expect(supervisor.snapshot().state).toBe("failed");
  expect(supervisor.snapshot().startAttempts).toBe(3);
});
```

```typescript
it("uses an isolated sandboxed renderer", () => {
  const preferences = viewerWebPreferences("/preload.js");
  expect(preferences.sandbox).toBe(true);
  expect(preferences.contextIsolation).toBe(true);
  expect(preferences.nodeIntegration).toBe(false);
});
```

- [ ] **Step 3: Implement bounded line parsing and restart behavior**

`CompanionSupervisor` must spawn only the configured packaged executable, parse stdout with a 1 MiB line limit, validate every event with Zod, emit a disconnected state after process loss, and restart at most three consecutive times with 100 ms, 500 ms, and 2,000 ms delays. `LogStore` rotates at 2 MiB and retains five files. The supervisor must never reconnect, restart recording, or issue Bias.

- [ ] **Step 4: Implement the narrow preload API**

```typescript
export interface NetftApi {
  connect(sensorHost: string): Promise<CommandResult>;
  disconnect(): Promise<CommandResult>;
  setPaused(paused: boolean): Promise<CommandResult>;
  requestBias(): Promise<CommandResult>;
  startRecording(): Promise<CommandResult>;
  stopRecording(): Promise<CommandResult>;
  retryBackend(): Promise<CommandResult>;
  subscribe(listener: (event: RendererEvent) => void): () => void;
}
```

Validate IPC senders, do not expose `ipcRenderer`, and register only the preceding operations.

- [ ] **Step 5: Configure Electron fuses and local-only navigation**

Enable ASAR integrity, disable RunAsNode, deny navigation away from the packaged app, deny unexpected window creation, and install a restrictive Content Security Policy.

- [ ] **Step 6: Run Electron unit tests and commit**

Run: `pnpm vitest run test/electron/companion-supervisor.test.ts test/electron/security.test.ts`

Expected: PASS.

```bash
git add package.json pnpm-lock.yaml forge.config.ts vite.*.config.ts app/main app/preload test/electron
git commit -m "feat: establish the secure Electron shell"
```

---

### Task 10: Implement Renderer State and the Fixed Sidebar

**Files:**
- Create: `index.html`
- Create: `app/renderer/main.tsx`
- Create: `app/renderer/App.tsx`
- Create: `app/renderer/model/app-state.ts`
- Create: `app/renderer/components/ConnectionPanel.tsx`
- Create: `app/renderer/components/StatusPanel.tsx`
- Create: `app/renderer/components/LiveWrenchTable.tsx`
- Create: `app/renderer/styles/theme.css`
- Create: `app/renderer/styles/viewer.css`
- Create: `test/electron/app-state.test.ts`
- Create: `test/electron/sidebar.test.tsx`

**Interfaces:**
- Consumes: `window.netft.subscribe` renderer events.
- Produces: `AppState`, `appReducer`, and the approved fixed sidebar layout.

- [ ] **Step 1: Write failing reducer tests**

```typescript
it("freezes wrench updates while paused but accepts health updates", () => {
  const paused = reduce(streamingState(), { type: "pause_confirmed", paused: true });
  const afterWrench = reduce(paused, liveWrenchEvent(2));
  const afterHealth = reduce(afterWrench, healthEvent({ receiveRateHz: 1000 }));
  expect(afterWrench.wrench.sequence).toBe(paused.wrench.sequence);
  expect(afterHealth.health.receiveRateHz).toBe(1000);
});
```

- [ ] **Step 2: Define typed renderer state**

```typescript
export interface AppState {
  backend: BackendState;
  connection: ConnectionState;
  paused: boolean;
  sensorHost: string;
  health: HealthView;
  wrench: WrenchView;
  recording: RecordingView;
  plot: PlotView;
  preferences: Preferences;
}
```

Use enum-like union values for state and `data-testid` identifiers for behavior tests. Do not assert complete user-visible sentences.

- [ ] **Step 3: Implement the connection, status, and wrench components**

The sidebar must display IP, connection controls, status metrics, six raw signed counts, six calibrated values with sensor-native units, configuration revision, recording duration, bytes, and queue utilization.

- [ ] **Step 4: Apply the approved responsive layout**

Use a 300-pixel desktop sidebar with a minimum plot width. On small windows preserve data readability through a scrollable sidebar and minimum application size rather than collapsing controls into a top bar.

- [ ] **Step 5: Run reducer and component tests**

Run: `pnpm vitest run test/electron/app-state.test.ts test/electron/sidebar.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add index.html app/renderer test/electron/app-state.test.ts test/electron/sidebar.test.tsx
git commit -m "feat: add the live sensor sidebar"
```

---

### Task 11: Implement Combined and Six-panel ECharts Views

**Files:**
- Create: `app/renderer/model/chart-model.ts`
- Create: `app/renderer/components/ChartToolbar.tsx`
- Create: `app/renderer/components/ChartWorkspace.tsx`
- Create: `app/renderer/components/use-echart.ts`
- Create: `test/electron/chart-model.test.ts`
- Create: `test/electron/chart-workspace.test.tsx`

**Interfaces:**
- Consumes: validated `plot_batch` events with at most four points per axis.
- Produces: bounded `ChartModel`, Combined dual-axis options, and six independent panel options.

- [ ] **Step 1: Write failing bounded-window tests**

```typescript
it("evicts points older than the active window", () => {
  const model = new ChartModel(10_000);
  model.append(batchAt(0));
  model.append(batchAt(11_000));
  expect(model.series("Fx").every((point) => point.timeMs >= 1_000)).toBe(true);
});
```

Add tests for all six axes, per-series chronological ordering, Pause reset, view switching without data duplication, series visibility, and Live mode restoration.

- [ ] **Step 2: Implement the bounded chart model**

Store one sorted deque per axis. Convert decimal-string nanoseconds only after subtracting a session time origin to preserve JavaScript precision. Evict by active time window after every append.

- [ ] **Step 3: Implement Combined mode**

Force axes use the left Y axis and torque axes use the right Y axis. Use six line series with symbols disabled, animation disabled, progressive updates disabled for the bounded data size, legend visibility, tooltip values with units, and a shared time X axis.

- [ ] **Step 4: Implement 6 panels mode**

Create six ECharts instances in a 3-by-2 responsive grid. Each panel has one series, its own automatic Y scale, shared time range, and synchronized cursor.

- [ ] **Step 5: Implement toolbar behavior**

Time windows are exactly 1, 5, 10, 30, and 60 seconds. Manual zoom or pan disables automatic following. `Live` restores the rolling window, and `Reset view` resets axis ranges without changing series visibility.

- [ ] **Step 6: Run chart tests and commit**

Run: `pnpm vitest run test/electron/chart-model.test.ts test/electron/chart-workspace.test.tsx`

Expected: PASS.

```bash
git add app/renderer/model/chart-model.ts app/renderer/components/ChartToolbar.tsx app/renderer/components/ChartWorkspace.tsx app/renderer/components/use-echart.ts test/electron/chart-model.test.ts test/electron/chart-workspace.test.tsx
git commit -m "feat: add live six-axis plots"
```

---

### Task 12: Implement Safe Actions, Dialogs, Preferences, and Errors

**Files:**
- Create: `app/main/dialog-service.ts`
- Create: `app/main/settings-store.ts`
- Create: `app/renderer/components/Actions.tsx`
- Create: `app/renderer/components/BackendErrorView.tsx`
- Create: `test/electron/dialog-service.test.ts`
- Create: `test/electron/settings-store.test.ts`
- Create: `test/electron/actions.test.tsx`

**Interfaces:**
- Consumes: Renderer action requests and companion command results.
- Produces: native Bias confirmation, native CSV save selection, validated settings, and backend failure recovery UI.

- [ ] **Step 1: Write failing action-availability tests**

```typescript
it("does not issue Bias when confirmation is declined", async () => {
  const commands = fakeCommands();
  const dialogs = fakeDialogs({ biasConfirmed: false });
  await requestBias(commands, dialogs);
  expect(commands.biasCalls).toBe(0);
});
```

Add tests that Record is disabled while paused, Pause waits for companion confirmation, Stop is available during paused recording, and backend retry does not reconnect.

- [ ] **Step 2: Implement native dialogs**

Bias uses `dialog.showMessageBox` with no persistent suppression. Record uses `dialog.showSaveDialog` with a timestamped `.csv` default, CSV filter, and overwrite confirmation. Main passes only a confirmed absolute path to the companion.

- [ ] **Step 3: Implement action-state transitions**

Buttons display pending state while commands are in flight and update final state only from correlated command results plus companion state events. Do not optimistically mark Pause complete before recorder drain acknowledgment.

- [ ] **Step 4: Implement validated settings**

Persist only `sensorHost`, `plotMode`, `timeWindowSeconds`, `visibleAxes`, and `theme` under `app.getPath("userData")`. Validate with Zod, reject invalid values, write through a temporary sibling file, and atomically replace the settings file.

- [ ] **Step 5: Implement backend and recording error views**

Expose structured categories, technical details, rotating log location, partial-file path, and Retry backend. Never resume sensor connection, recording, or Bias automatically.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm vitest run test/electron/dialog-service.test.ts test/electron/settings-store.test.ts test/electron/actions.test.tsx`

Expected: PASS.

```bash
git add app/main app/renderer/components test/electron
git commit -m "feat: add safe viewer controls and recovery"
```

---

### Task 13: Add Full Electron End-to-End Coverage

**Files:**
- Create: `test/support/fake-companion.mjs`
- Create: `test/e2e/fixtures.ts`
- Create: `test/e2e/viewer.spec.ts`
- Create: `playwright.config.ts`
- Modify: `app/main/companion-supervisor.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: A dedicated E2E Electron build and its injected fake companion path.
- Produces: deterministic Playwright coverage of the complete main, preload, and renderer flow.

- [ ] **Step 1: Write the first failing packaged-app scenario**

```typescript
test("pause suspends displayed samples and CSV acceptance", async ({ viewer }) => {
  await viewer.connect();
  await viewer.startRecording();
  await viewer.fakeCompanion.emitSample(1);
  await viewer.pause();
  await viewer.fakeCompanion.emitSample(2);
  await viewer.resume();
  await viewer.fakeCompanion.emitSample(3);
  await viewer.stopRecording();
  expect(await viewer.recordedSequences()).toEqual([1, 3]);
});
```

- [ ] **Step 2: Implement the fake companion**

The fake process must use the real protocol schemas, support correlated responses, emit deterministic health and plot batches, simulate process exit, simulate recording errors, and write fixture CSV files.

The companion-path override must exist only in a Forge build with compile-time `NETFT_VIEWER_E2E_BUILD=true`. Production packages resolve the companion exclusively from the packaged resource directory and must not contain an environment-variable code path that can execute an arbitrary binary.

- [ ] **Step 3: Add complete E2E scenarios**

Cover connection, disconnection, raw and calibrated values, Combined and 6 panels, time windows, Pause and Resume, Bias decline and confirm, Record and Stop, partial-file errors, companion restart, and the guarantee that retry remains disconnected.

- [ ] **Step 4: Run against a packaged application**

Run: `pnpm package`

Run: `pnpm playwright test`

Expected: all scenarios pass using the packaged resource layout rather than the Vite development server.

- [ ] **Step 5: Commit**

```bash
git add test/support/fake-companion.mjs test/e2e playwright.config.ts app/main/companion-supervisor.ts package.json pnpm-lock.yaml
git commit -m "test: cover the packaged viewer end to end"
```

---

### Task 14: Create Cross-platform Installation Artifacts

**Files:**
- Create: `tools/copy-companion.mjs`
- Create: `tools/make-portable.mjs`
- Create: `packaging/entitlements.mac.plist`
- Create: `packaging/icons/netft-viewer.svg`
- Create: generated Windows, Linux, and macOS icon assets
- Modify: `forge.config.ts`
- Modify: `CMakeLists.txt`
- Modify: `package.json`
- Create: `test/project/package-layout.test.mjs`

**Interfaces:**
- Consumes: Native companion and Electron package.
- Produces: Linux `.deb` and `.tar.gz`, Windows Squirrel `Setup.exe` and `.zip`, and macOS universal `.dmg` and `.zip`.

- [ ] **Step 1: Write a failing package-layout test**

```javascript
test("packaged application contains an executable companion outside asar", () => {
  const layout = inspectPackage(process.env.NETFT_VIEWER_PACKAGE_DIR);
  assert.equal(layout.companion.insideAsar, false);
  assert.equal(layout.companion.executable, true);
  assert.equal(layout.renderer.insideAsar, true);
});
```

- [ ] **Step 2: Stage the correct native executable**

`tools/copy-companion.mjs` accepts the CMake build directory and Forge platform and architecture, verifies the companion `hello` version, copies it to a deterministic staging directory, and sets executable mode on POSIX.

- [ ] **Step 3: Configure Forge makers**

Install and use `@electron-forge/maker-deb`, `maker-squirrel`, `maker-dmg`, and `maker-zip`, all at version 7.11.2. Configure `asar`, `extraResource`, application identifiers, icons, macOS hardened runtime entitlements, and universal packaging.

`tools/make-portable.mjs` must create the Linux `.tar.gz` from the already packaged Linux application directory with deterministic file ordering, numeric ownership, and a fixed archive prefix. It must not rebuild the application or download dependencies.

- [ ] **Step 4: Add native artifact checks**

Linux uses `ldd` to confirm no unexpected build-directory dependency. Windows uses `dumpbin /dependents`. macOS uses `otool -L`, `lipo -info`, and `codesign --verify` when signing is enabled. Each portable package must run `companion hello` after extraction.

- [ ] **Step 5: Build and smoke-test on each native runner**

Run on each target: `pnpm make`

Run: `node --test test/project/package-layout.test.mjs`

Expected: the platform-specific artifacts exist and the packaged companion handshake succeeds.

- [ ] **Step 6: Commit**

```bash
git add tools/copy-companion.mjs tools/make-portable.mjs packaging forge.config.ts CMakeLists.txt package.json pnpm-lock.yaml test/project/package-layout.test.mjs
git commit -m "build: package the viewer for desktop platforms"
```

---

### Task 15: Add CI, Security Scanning, Coverage, and Dependency Management

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/codeql.yml`
- Create: `.github/workflows/coverage.yml`
- Create: `.github/workflows/package.yml`
- Create: `.github/dependabot.yml`
- Create: `codecov.yml`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/ISSUE_TEMPLATE/hardware_compatibility.yml`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

**Interfaces:**
- Consumes: All native, frontend, E2E, and package commands.
- Produces: required GitHub checks for quality, native platform tests, E2E, CodeQL, coverage upload, and artifact smoke tests.

- [ ] **Step 1: Add workflow-contract tests before workflows**

Create `test/project/workflows.test.mjs` that parses workflow YAML and asserts named jobs for Linux x86_64, Linux ARM64, Windows x86_64, macOS x64, macOS ARM64, E2E, CodeQL C++, CodeQL JavaScript/TypeScript, coverage upload, and package smoke tests.

Run: `node --test test/project/workflows.test.mjs`

Expected: FAIL because workflows do not exist.

- [ ] **Step 2: Implement CI matrices**

Use native GitHub-hosted runners, `actions/checkout@v7`, `actions/setup-node@v6` with Node 24 and pnpm cache, CMake plus Ninja, and explicit timeout limits. Run format, lint, type checking, native tests, renderer tests, companion process tests, and packaged E2E tests.

- [ ] **Step 3: Add CodeQL and coverage**

Configure `github/codeql-action@v4` for `c-cpp` and `javascript-typescript`. Generate native and TypeScript coverage, upload separate `native` and `frontend` flags with `codecov/codecov-action@v7`, and keep Codecov non-blocking for coverage percentage while failing on upload errors.

- [ ] **Step 4: Group dependency updates**

Dependabot groups Electron ecosystem packages, React ecosystem packages, test packages, and GitHub Actions. Limit concurrent open pull requests to avoid single-package PR floods.

- [ ] **Step 5: Add issue and pull-request templates**

Templates request reproducible versions, platform and architecture, sensor model and firmware when relevant, sanitized network details, safety confirmation for hardware actions, and exact verification commands. Do not encode README or release copy in tests.

- [ ] **Step 6: Validate locally and commit**

Run: `node --test test/project/workflows.test.mjs`

Run: `pnpm lint && pnpm typecheck && pnpm test`

Run: `pixi run native-test`

Expected: all local checks pass.

```bash
git add .github codecov.yml test/project/workflows.test.mjs
git commit -m "ci: validate the viewer across platforms"
```

---

### Task 16: Add User Documentation, Hardware Verification, and Automated Releases

**Files:**
- Create: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `CHANGELOG.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `tools/hardware-test.sh`
- Create: `test/hardware/hardware_test.cpp`
- Create: `.github/workflows/release.yml`
- Create: `.github/scripts/publish_release.sh`
- Modify: `tools/check-versions.mjs`

**Interfaces:**
- Consumes: Completed application, package artifacts, exact snapshot provenance, and signing secrets when available.
- Produces: safe user instructions, opt-in hardware verification, checksums, SBOM, verified draft releases, and GitHub repository publication.

- [ ] **Step 1: Write failing release-contract tests**

Create `test/project/release.test.mjs` that verifies version agreement, a dated `0.1.0` changelog section, required artifact names, checksum generation, SBOM generation, draft-first release creation, and idempotent asset verification.

Run: `node --test test/project/release.test.mjs`

Expected: FAIL because release files do not exist.

- [ ] **Step 2: Write the English user documentation**

README sections must cover badges, purpose, supported platforms, installation artifacts, connecting with `192.168.1.1` as the example, sidebar values, plot modes, Pause semantics, buffered recording, partial-file recovery, Bias safety, network security, troubleshooting, contributing, license, and the community-maintained non-affiliation statement.

Do not mention internal development status, private addresses, unavailable package channels, or unimplemented features.

- [ ] **Step 3: Implement safe hardware verification**

```bash
: "${NETFT_SENSOR_HOST:?NETFT_SENSOR_HOST is required}"
cmake --build build/hardware --target netft-viewer-hardware-test
build/hardware/test/hardware/netft-viewer-hardware-test
```

The default harness verifies discovery, authoritative units, streaming, health, Pause, Resume, and a short CSV whose accepted and written counts match. Bias executes only when `NETFT_ALLOW_BIAS=1`; the harness must otherwise prove that no Bias command was sent.

- [ ] **Step 4: Implement the release workflow**

On `v*` tags, verify all versions and changelog, run native platform builds and tests, build signed artifacts when credentials exist, generate SHA-256 and SBOM files, create a draft release, upload assets, and download and byte-compare them. A separate `publish` job uses a protected GitHub `release` environment so publication requires explicit approval after verification.

The publish script must treat an already-published release as immutable and succeed only when all existing assets are byte-identical.

- [ ] **Step 5: Validate all documentation and release contracts**

Run: `node --test test/project/version.test.mjs test/project/snapshot.test.mjs test/project/release.test.mjs`

Run: `bash -n tools/hardware-test.sh .github/scripts/publish_release.sh`

Run without hardware variables: `tools/hardware-test.sh`

Expected: hardware harness exits nonzero before any network action and identifies the missing variable.

- [ ] **Step 6: Commit**

```bash
git add README.md CONTRIBUTING.md SECURITY.md CHANGELOG.md THIRD_PARTY_NOTICES.md tools/hardware-test.sh test/hardware .github/workflows/release.yml .github/scripts/publish_release.sh tools/check-versions.mjs test/project/release.test.mjs
git commit -m "docs: prepare netft-viewer for release"
```

- [ ] **Step 7: Create and publish the GitHub repository after the full local verification gate**

Run the complete local suite:

```bash
pixi run native-test
pnpm lint
pnpm typecheck
pnpm test
pnpm package
git status --short
```

Expected: all commands exit 0 and `git status --short` is empty.

Then create and push the requested public repository:

```bash
gh repo create netft/netft-viewer --public --source=. --remote=origin
git push -u origin main
```

Configure branch protection only after the pushed workflow names are visible, requiring the CI, CodeQL, and package smoke checks that exist in `.github/workflows`.

- [ ] **Step 8: Verify the first remote CI run before release work continues**

Run: `gh run list --branch main --limit 20`

Inspect every required workflow with `gh run view --log-failed`. Fix platform-specific failures through reviewed commits, push them, and repeat until CI, CodeQL, coverage upload, and package smoke jobs all complete successfully. Do not create a release tag while any required check is incomplete or failing.

---

## Final Verification Gate

- [ ] Run `git status --short` and require an empty worktree.
- [ ] Run `pixi run format-check`, `pixi run tidy`, `pixi run native-test`, and the sanitizer suite.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and packaged Playwright E2E.
- [ ] Build and inspect Linux x86_64 and ARM64, Windows x86_64, and macOS universal artifacts on their native CI runners.
- [ ] Confirm each extracted package can execute the companion `hello` handshake.
- [ ] Run the supervised hardware harness with `NETFT_SENSOR_HOST` and without `NETFT_ALLOW_BIAS`.
- [ ] If Bias hardware verification is authorized and the sensor is safely unloaded, rerun with `NETFT_ALLOW_BIAS=1`.
- [ ] Confirm no committed file contains the laboratory sensor address.
- [ ] Confirm Codecov uploads both flags and has no percentage gate.
- [ ] Confirm CodeQL reports no unresolved high or critical findings.
- [ ] Confirm `CORE_SNAPSHOT.md`, `THIRD_PARTY_NOTICES.md`, SBOM, checksums, and release assets agree with the built source.
- [ ] Confirm the GitHub draft release remains unpublished until its downloaded assets are byte-verified.
