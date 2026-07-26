#pragma once

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>

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
};

struct SessionSnapshot {
  ConnectionSnapshot connection;
  netft::HealthSnapshot health;
  std::optional<TimedSample> latest_sample;
  RecorderSnapshot recording;
  std::optional<netft::SensorConfiguration> configuration;
};

class SessionEventSink {
public:
  virtual ~SessionEventSink() = default;
  virtual void connection_changed(const ConnectionSnapshot &snapshot) = 0;
  virtual void health_changed(const netft::HealthSnapshot &snapshot) = 0;
  virtual void live_wrench(const TimedSample &sample) = 0;
  virtual void plot_batch(const PlotBatch &batch) = 0;
  virtual void recording_changed(const RecorderSnapshot &snapshot) = 0;
  virtual void
  configuration_changed(const netft::SensorConfiguration &configuration) = 0;
  virtual void error(const SessionError &error) = 0;
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
