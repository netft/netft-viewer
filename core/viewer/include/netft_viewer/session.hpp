#pragma once

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <variant>

#include "netft/client.hpp"
#include "netft_viewer/clock.hpp"
#include "netft_viewer/plot_aggregator.hpp"
#include "netft_viewer/recorder.hpp"

namespace netft_viewer {

enum class ConnectionState {
  Disconnected,
  Connecting,
  Streaming,
  Reconnecting,
  Disconnecting,
  Error
};

enum class SessionResult { Ok, InvalidState, Failed };

enum class SessionOperation {
  Connect,
  Disconnect,
  Pause,
  Resume,
  Bias,
  StartRecording,
  StopRecording,
  Sensor,
  Recording
};

struct ConnectionSnapshot {
  ConnectionState state{ConnectionState::Disconnected};
  bool paused{};
  std::uint64_t generation{};
  std::string last_error;
};

struct SessionError {
  SessionOperation operation{SessionOperation::Sensor};
  std::string message;
  std::uint64_t sequence{};
  std::uint64_t dropped_before{};
};

using SessionEventPayload =
    std::variant<ConnectionSnapshot, netft::HealthSnapshot, TimedSample,
                 PlotBatch, RecorderSnapshot, netft::SensorConfiguration,
                 SessionError>;

class MeasurementLease {
public:
  MeasurementLease() = default;

  [[nodiscard]] bool valid() const noexcept;
  [[nodiscard]] std::uint64_t epoch() const noexcept;

private:
  friend class SessionEventSink;
  struct State;
  explicit MeasurementLease(std::shared_ptr<State> state);

  std::shared_ptr<State> state_;
};

struct SessionEvent {
  std::uint64_t generation{};
  SessionEventPayload payload;
  std::optional<MeasurementLease> measurement_lease;

  // Consumers must call this immediately at their serialization/output commit
  // point, with no intervening queue or wait. A false result permanently
  // revokes a popped pre-Pause event. A revocation racing just after a true
  // result linearizes that already-committed output before Pause.
  [[nodiscard]] bool valid_for_delivery() const noexcept;
  [[nodiscard]] std::uint64_t measurement_epoch() const noexcept;
};

enum class SessionEventReadStatus { Event, Empty, Closed };

struct SessionEventRead {
  SessionEventReadStatus status{SessionEventReadStatus::Empty};
  std::optional<SessionEvent> event;
};

struct SessionSnapshot {
  ConnectionSnapshot connection;
  netft::HealthSnapshot health;
  std::optional<TimedSample> latest_sample;
  RecorderSnapshot recording;
  std::optional<netft::SensorConfiguration> configuration;
};

class SessionEventSink final {
public:
  SessionEventSink();
  ~SessionEventSink();

  SessionEventSink(const SessionEventSink &) = delete;
  SessionEventSink &operator=(const SessionEventSink &) = delete;

  // These methods only access a bounded in-memory queue. They never invoke
  // consumers or perform I/O, so session control and destruction cannot be
  // delayed by renderer or IPC work. The sink must outlive ViewerSession.
  // Shutdown order is: stop/destroy ViewerSession, close(), join every consumer
  // awakened with Closed, then destroy the sink. close() drops pending events.
  void enqueue(SessionEvent event) noexcept;
  [[nodiscard]] SessionEventRead try_pop();
  [[nodiscard]] SessionEventRead
  wait_for_event(std::chrono::milliseconds timeout);
  // Stops accepting events while allowing a consumer to drain the events
  // already queued. Reads return Closed after the queue becomes empty.
  void finish() noexcept;
  void close() noexcept;

  // ViewerSession lifecycle controls. Consumers do not need these methods.
  void purge_measurements(std::uint64_t generation) noexcept;
  void retain_generation(std::uint64_t generation) noexcept;
  [[nodiscard]] bool begin_measurements() noexcept;
  void revoke_measurements() noexcept;

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

struct SessionOptions {
  std::shared_ptr<Clock> clock;
  std::shared_ptr<Recorder> recorder;
  std::chrono::milliseconds health_interval{std::chrono::milliseconds{200}};
  std::chrono::nanoseconds plot_interval{std::chrono::milliseconds{33}};
};

class ViewerSession {
public:
  explicit ViewerSession(SessionEventSink &sink, SessionOptions options = {});
  ~ViewerSession();

  ViewerSession(const ViewerSession &) = delete;
  ViewerSession &operator=(const ViewerSession &) = delete;

  SessionResult connect(netft::Config config);
  SessionResult disconnect();
  SessionResult set_paused(bool paused);
  SessionResult bias();
  SessionResult start_recording(const std::filesystem::path &target,
                                bool overwrite);
  SessionResult stop_recording();
  [[nodiscard]] SessionSnapshot snapshot() const;

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace netft_viewer
