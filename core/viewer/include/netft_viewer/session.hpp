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

struct SessionEvent {
  std::uint64_t generation{};
  SessionEventPayload payload;
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
  void enqueue(SessionEvent event) noexcept;
  [[nodiscard]] std::optional<SessionEvent> try_pop();
  [[nodiscard]] std::optional<SessionEvent>
  wait_for_event(std::chrono::milliseconds timeout);

  // ViewerSession lifecycle controls. Consumers do not need these methods.
  void purge_measurements(std::uint64_t generation) noexcept;
  void retain_generation(std::uint64_t generation) noexcept;

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
