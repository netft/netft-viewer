#include "netft_viewer/session.hpp"

#include "netft_viewer/detail/session_event_queue.hpp"

#include <atomic>
#include <condition_variable>
#include <exception>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace netft_viewer {
namespace {

class SystemClock final : public Clock {
public:
  std::int64_t monotonic_now_ns() const noexcept override {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
  }

  std::int64_t host_now_ns() const noexcept override {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
  }
};

class EventPublisher {
public:
  EventPublisher(SessionEventSink &sink,
                 const std::atomic<std::uint64_t> &active_generation)
      : sink_(sink), active_generation_(active_generation) {}

  template <typename Payload>
  void push(std::uint64_t generation, Payload payload) noexcept {
    if (generation == active_generation_.load(std::memory_order_acquire)) {
      sink_.enqueue(SessionEvent{generation, std::move(payload)});
    }
  }

  void purge_measurements(std::uint64_t generation) {
    sink_.purge_measurements(generation);
  }

  void activate_generation(std::uint64_t generation) {
    sink_.retain_generation(generation);
  }

  [[nodiscard]] bool begin_measurements() noexcept {
    return sink_.begin_measurements();
  }

  void revoke_measurements() noexcept { sink_.revoke_measurements(); }

private:
  SessionEventSink &sink_;
  const std::atomic<std::uint64_t> &active_generation_;
};

ConnectionState connection_state_for(netft::ClientState state) {
  switch (state) {
  case netft::ClientState::Stopped:
    return ConnectionState::Disconnected;
  case netft::ClientState::Connecting:
    return ConnectionState::Connecting;
  case netft::ClientState::Streaming:
    return ConnectionState::Streaming;
  case netft::ClientState::Backoff:
    return ConnectionState::Reconnecting;
  case netft::ClientState::Faulted:
    return ConnectionState::Error;
  }
  return ConnectionState::Error;
}

} // namespace

struct MeasurementLease::State {
  State(bool active, std::uint64_t value) : valid(active), epoch(value) {}

  std::atomic<bool> valid;
  std::uint64_t epoch{};
};

MeasurementLease::MeasurementLease(std::shared_ptr<State> state)
    : state_(std::move(state)) {}

bool MeasurementLease::valid() const noexcept {
  return state_ && state_->valid.load(std::memory_order_acquire);
}

std::uint64_t MeasurementLease::epoch() const noexcept {
  return state_ ? state_->epoch : 0U;
}

bool SessionEvent::valid_for_delivery() const noexcept {
  const auto measurement = std::holds_alternative<TimedSample>(payload) ||
                           std::holds_alternative<PlotBatch>(payload);
  return !measurement || (measurement_lease && measurement_lease->valid());
}

std::uint64_t SessionEvent::measurement_epoch() const noexcept {
  return measurement_lease ? measurement_lease->epoch() : 0U;
}

class SessionEventSink::Impl {
public:
  Impl()
      : measurement_state(
            std::make_shared<MeasurementLease::State>(false, 0U)) {}

  std::mutex mutex;
  std::condition_variable condition;
  detail::SessionEventQueue events;
  std::shared_ptr<MeasurementLease::State> measurement_state;
  std::uint64_t next_measurement_epoch{};
  bool finishing{};
  bool closed{};
};

SessionEventSink::SessionEventSink() : impl_(std::make_unique<Impl>()) {}

SessionEventSink::~SessionEventSink() { close(); }

void SessionEventSink::enqueue(SessionEvent event) noexcept {
  try {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (impl_->closed || impl_->finishing) {
        return;
      }
      const auto measurement =
          std::holds_alternative<TimedSample>(event.payload) ||
          std::holds_alternative<PlotBatch>(event.payload);
      if (measurement) {
        if (!impl_->measurement_state->valid.load(std::memory_order_acquire)) {
          return;
        }
        event.measurement_lease = MeasurementLease{impl_->measurement_state};
      }
      impl_->events.push(std::move(event));
    }
    impl_->condition.notify_one();
  } catch (...) {
    // Allocation failure cannot be reported through the same exhausted queue.
  }
}

SessionEventRead SessionEventSink::try_pop() {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->closed) {
    return {SessionEventReadStatus::Closed, std::nullopt};
  }
  auto event = impl_->events.pop();
  if (event) {
    return {SessionEventReadStatus::Event, std::move(event)};
  }
  return {impl_->finishing ? SessionEventReadStatus::Closed
                           : SessionEventReadStatus::Empty,
          std::nullopt};
}

SessionEventRead
SessionEventSink::wait_for_event(std::chrono::milliseconds timeout) {
  std::unique_lock<std::mutex> lock(impl_->mutex);
  impl_->condition.wait_for(lock, timeout, [&] {
    return impl_->closed || impl_->finishing || !impl_->events.empty();
  });
  if (impl_->closed) {
    return {SessionEventReadStatus::Closed, std::nullopt};
  }
  auto event = impl_->events.pop();
  if (event) {
    return {SessionEventReadStatus::Event, std::move(event)};
  }
  return {impl_->finishing ? SessionEventReadStatus::Closed
                           : SessionEventReadStatus::Empty,
          std::nullopt};
}

void SessionEventSink::finish() noexcept {
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->closed || impl_->finishing) {
      return;
    }
    impl_->finishing = true;
    impl_->measurement_state->valid.store(false, std::memory_order_release);
    impl_->events.purge_measurements(0U);
  }
  impl_->condition.notify_all();
}

void SessionEventSink::close() noexcept {
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->closed) {
      return;
    }
    impl_->closed = true;
    impl_->finishing = true;
    impl_->measurement_state->valid.store(false, std::memory_order_release);
    impl_->events.clear();
  }
  impl_->condition.notify_all();
}

void SessionEventSink::purge_measurements(std::uint64_t generation) noexcept {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->events.purge_measurements(generation);
}

void SessionEventSink::retain_generation(std::uint64_t generation) noexcept {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->closed || impl_->finishing) {
    return;
  }
  impl_->events.retain_generation(generation);
}

bool SessionEventSink::begin_measurements() noexcept {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->closed || impl_->finishing) {
    return false;
  }
  impl_->measurement_state->valid.store(false, std::memory_order_release);
  try {
    impl_->measurement_state = std::make_shared<MeasurementLease::State>(
        true, ++impl_->next_measurement_epoch);
    return true;
  } catch (...) {
    return false;
  }
}

void SessionEventSink::revoke_measurements() noexcept {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->measurement_state->valid.store(false, std::memory_order_release);
}

class ViewerSession::Impl {
public:
  Impl(SessionEventSink &sink, SessionOptions options)
      : options_(std::move(options)),
        clock_(options_.clock ? options_.clock
                              : std::make_shared<SystemClock>()),
        recorder_(options_.recorder ? options_.recorder
                                    : std::make_shared<Recorder>()),
        plot_(options_.plot_interval), events_(sink, active_generation_) {
    if (options_.health_interval <= std::chrono::milliseconds::zero()) {
      throw std::invalid_argument("health interval must be positive");
    }
  }

  ~Impl() { static_cast<void>(disconnect()); }

  SessionResult connect(netft::Config config) {
    std::lock_guard<std::mutex> operation_lock(operation_mutex_);
    std::uint64_t generation{};
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      if (connection_.state != ConnectionState::Disconnected) {
        return SessionResult::InvalidState;
      }
      generation = connection_.generation + 1U;
      active_generation_.store(generation, std::memory_order_release);
      connection_ = {ConnectionState::Connecting, false, generation, {}};
      latest_.reset();
      configuration_.reset();
      health_ = {};
      health_.sensor_host = config.sensor_host;
      health_.rdt_port = config.rdt_port;
      accepting_samples_ = true;
      has_streamed_ = false;
      published_configuration_revision_ = 0U;
      recording_failure_reported_ = false;
    }
    events_.activate_generation(generation);
    if (!events_.begin_measurements()) {
      fail_connection(generation, SessionOperation::Connect,
                      "measurement event channel is unavailable");
      return SessionResult::Failed;
    }
    events_.push(generation, connection_copy());

    try {
      client_ = std::make_unique<netft::Client>(std::move(config));
      client_->start([this, generation](const netft::Sample &sample) {
        sample_received(generation, sample);
      });
      {
        std::lock_guard<std::mutex> lock(health_wait_mutex_);
        stop_health_ = false;
      }
      health_thread_ =
          std::thread(&Impl::health_loop, this, generation, client_.get());
    } catch (const std::exception &exception) {
      if (client_) {
        client_->stop();
        client_.reset();
      }
      fail_connection(generation, SessionOperation::Connect, exception.what());
      return SessionResult::Failed;
    } catch (...) {
      if (client_) {
        client_->stop();
        client_.reset();
      }
      fail_connection(generation, SessionOperation::Connect,
                      "unexpected connection failure");
      return SessionResult::Failed;
    }
    return SessionResult::Ok;
  }

  SessionResult disconnect() {
    std::lock_guard<std::mutex> operation_lock(operation_mutex_);
    std::uint64_t generation{};
    {
      std::unique_lock<std::mutex> lock(state_mutex_);
      if (connection_.state == ConnectionState::Disconnected) {
        return SessionResult::Ok;
      }
      generation = connection_.generation;
      accepting_samples_ = false;
      connection_.state = ConnectionState::Disconnecting;
      connection_.paused = false;
      callback_condition_.wait(lock, [&] { return active_callbacks_ == 0U; });
    }
    events_.revoke_measurements();
    events_.purge_measurements(generation);
    events_.push(generation, connection_copy());

    {
      std::lock_guard<std::mutex> lock(health_wait_mutex_);
      stop_health_ = true;
    }
    health_condition_.notify_all();
    if (client_) {
      client_->stop();
    }
    if (health_thread_.joinable()) {
      health_thread_.join();
    }

    bool recording_failed = false;
    const auto recording = recorder_->snapshot().state;
    if (recording != RecordingState::Idle) {
      const auto result = recorder_->stop();
      publish_recording(generation);
      if (result != RecorderResult::Ok) {
        recording_failed = true;
        publish_error(generation, SessionOperation::StopRecording,
                      recorder_->snapshot().last_error);
      }
    }

    plot_.reset();
    client_.reset();
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      connection_.state = ConnectionState::Disconnected;
      connection_.paused = false;
      connection_.last_error.clear();
      health_.state = netft::ClientState::Stopped;
      latest_.reset();
      configuration_.reset();
    }
    events_.push(generation, connection_copy());
    return recording_failed ? SessionResult::Failed : SessionResult::Ok;
  }

  SessionResult set_paused(bool paused) {
    std::lock_guard<std::mutex> operation_lock(operation_mutex_);
    std::uint64_t generation{};
    {
      std::unique_lock<std::mutex> lock(state_mutex_);
      if (connection_.state != ConnectionState::Streaming) {
        return SessionResult::InvalidState;
      }
      if (connection_.paused == paused) {
        return SessionResult::Ok;
      }
      generation = connection_.generation;
      if (paused) {
        accepting_samples_ = false;
        callback_condition_.wait(lock, [&] { return active_callbacks_ == 0U; });
      }
    }

    bool recording_failed = false;
    if (paused) {
      events_.revoke_measurements();
      events_.purge_measurements(generation);
      if (recorder_->snapshot().state == RecordingState::Recording &&
          recorder_->pause() != RecorderResult::Ok) {
        recording_failed = true;
      }
      plot_.reset();
      {
        std::lock_guard<std::mutex> lock(state_mutex_);
        connection_.paused = true;
      }
    } else {
      if (!events_.begin_measurements()) {
        publish_error(generation, SessionOperation::Resume,
                      "measurement event channel is unavailable");
        return SessionResult::Failed;
      }
      if (recorder_->snapshot().state == RecordingState::Paused &&
          recorder_->resume() != RecorderResult::Ok) {
        recording_failed = true;
      }
      plot_.reset();
      {
        std::lock_guard<std::mutex> lock(state_mutex_);
        connection_.paused = false;
        accepting_samples_ = true;
      }
    }
    publish_recording(generation);
    events_.push(generation, connection_copy());
    if (recording_failed) {
      publish_error(generation, SessionOperation::Recording,
                    recorder_->snapshot().last_error);
      return SessionResult::Failed;
    }
    return SessionResult::Ok;
  }

  SessionResult bias() {
    std::lock_guard<std::mutex> operation_lock(operation_mutex_);
    std::uint64_t generation{};
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      if (connection_.state != ConnectionState::Streaming ||
          connection_.paused || client_ == nullptr) {
        return SessionResult::InvalidState;
      }
      generation = connection_.generation;
    }
    try {
      client_->bias();
      return SessionResult::Ok;
    } catch (const std::exception &exception) {
      publish_error(generation, SessionOperation::Bias, exception.what());
      return SessionResult::Failed;
    } catch (...) {
      publish_error(generation, SessionOperation::Bias,
                    "unexpected bias failure");
      return SessionResult::Failed;
    }
  }

  SessionResult start_recording(const std::filesystem::path &target,
                                bool overwrite) {
    std::lock_guard<std::mutex> operation_lock(operation_mutex_);
    std::uint64_t generation{};
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      if (connection_.state != ConnectionState::Streaming ||
          connection_.paused) {
        return SessionResult::InvalidState;
      }
      generation = connection_.generation;
    }
    const auto result = recorder_->start(
        target, overwrite ? OverwritePolicy::Replace : OverwritePolicy::Refuse);
    publish_recording(generation);
    if (result != RecorderResult::Ok) {
      publish_error(generation, SessionOperation::StartRecording,
                    recorder_->snapshot().last_error);
      return SessionResult::Failed;
    }
    recording_failure_reported_.store(false, std::memory_order_release);
    return SessionResult::Ok;
  }

  SessionResult stop_recording() {
    std::lock_guard<std::mutex> operation_lock(operation_mutex_);
    const auto generation = active_generation_.load(std::memory_order_acquire);
    const auto result = recorder_->stop();
    publish_recording(generation);
    if (result != RecorderResult::Ok) {
      publish_error(generation, SessionOperation::StopRecording,
                    recorder_->snapshot().last_error);
      return result == RecorderResult::InvalidState
                 ? SessionResult::InvalidState
                 : SessionResult::Failed;
    }
    return SessionResult::Ok;
  }

  SessionSnapshot snapshot() const {
    std::lock_guard<std::mutex> operation_lock(operation_mutex_);
    SessionSnapshot snapshot;
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      snapshot.connection = connection_;
      snapshot.health = health_;
      snapshot.latest_sample = latest_;
      snapshot.configuration = configuration_;
    }
    snapshot.recording = recorder_->snapshot();
    return snapshot;
  }

private:
  void sample_received(std::uint64_t generation, const netft::Sample &sample) {
    bool configuration_required = false;
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      if (generation != connection_.generation || !accepting_samples_) {
        return;
      }
      ++active_callbacks_;
      sample_revision_.fetch_add(1U, std::memory_order_release);
      configuration_required =
          published_configuration_revision_ != sample.configuration_revision;
    }

    try {
      std::optional<netft::SensorConfiguration> sample_configuration;
      if (configuration_required) {
        const auto client_health = client_->health();
        if (client_health.sensor_configuration &&
            client_health.sensor_configuration->revision ==
                sample.configuration_revision) {
          sample_configuration = client_health.sensor_configuration;
        }
      }
      TimedSample timed{sample, clock_->host_now_ns(),
                        clock_->monotonic_now_ns()};
      const auto submit_result = recorder_->submit(sample);
      const auto plot_batch = plot_.push(timed);
      bool connection_changed = false;
      {
        std::lock_guard<std::mutex> lock(state_mutex_);
        if (generation == connection_.generation && accepting_samples_) {
          if (sample_configuration) {
            configuration_ = std::move(sample_configuration);
          }
          if (configuration_ &&
              configuration_->revision == sample.configuration_revision &&
              published_configuration_revision_ !=
                  sample.configuration_revision) {
            publish_configuration_locked(generation, *configuration_);
          }
          latest_ = timed;
          has_streamed_ = true;
          if (connection_.state != ConnectionState::Streaming) {
            connection_.state = ConnectionState::Streaming;
            connection_.last_error.clear();
            connection_changed = true;
          }
        }
      }

      if (generation == active_generation_.load(std::memory_order_acquire)) {
        if (connection_changed) {
          events_.push(generation, connection_copy());
        }
        events_.push(generation, std::move(timed));
        if (plot_batch) {
          events_.push(generation, *plot_batch);
        }
        if ((submit_result == SubmitResult::Overflow ||
             submit_result == SubmitResult::Failed) &&
            !recording_failure_reported_.exchange(true,
                                                  std::memory_order_acq_rel)) {
          publish_recording(generation);
          publish_error(generation, SessionOperation::Recording,
                        recorder_->snapshot().last_error);
        }
      }
    } catch (...) {
      complete_callback();
      throw;
    }
    complete_callback();
  }

  void complete_callback() noexcept {
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      --active_callbacks_;
    }
    callback_condition_.notify_all();
  }

  void health_loop(std::uint64_t generation, netft::Client *client) noexcept {
    for (;;) {
      publish_health(generation, client);
      std::unique_lock<std::mutex> lock(health_wait_mutex_);
      if (health_condition_.wait_for(lock, options_.health_interval,
                                     [&] { return stop_health_; })) {
        return;
      }
    }
  }

  void publish_health(std::uint64_t generation,
                      netft::Client *client) noexcept {
    const auto revision_before =
        sample_revision_.load(std::memory_order_acquire);
    netft::HealthSnapshot health;
    try {
      health = client->health();
    } catch (...) {
      return;
    }

    std::optional<ConnectionSnapshot> changed_connection;
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      if (generation != connection_.generation) {
        return;
      }
      health_ = health;
      if (health.sensor_configuration &&
          (!configuration_ ||
           configuration_->revision != health.sensor_configuration->revision)) {
        configuration_ = health.sensor_configuration;
      }
      if (configuration_ &&
          configuration_->revision != published_configuration_revision_) {
        publish_configuration_locked(generation, *configuration_);
      }
      auto mapped = connection_state_for(health.state);
      const auto revision_now =
          sample_revision_.load(std::memory_order_acquire);
      if (connection_.state == ConnectionState::Disconnecting) {
        mapped = ConnectionState::Disconnecting;
      } else if (connection_.state == ConnectionState::Streaming &&
                 mapped != ConnectionState::Streaming &&
                 revision_now != revision_before) {
        // The poll copied an older client state before a newer sample callback
        // established Streaming.
        mapped = ConnectionState::Streaming;
      } else if (has_streamed_ && (mapped == ConnectionState::Connecting ||
                                   mapped == ConnectionState::Reconnecting)) {
        mapped = ConnectionState::Reconnecting;
      }
      if (mapped == ConnectionState::Disconnected &&
          connection_.state != ConnectionState::Disconnecting) {
        mapped = ConnectionState::Error;
      }
      if (mapped != connection_.state ||
          connection_.last_error != health.last_error) {
        connection_.state = mapped;
        connection_.last_error = health.last_error;
        changed_connection = connection_;
      }
    }
    if (changed_connection) {
      events_.push(generation, *changed_connection);
    }
    events_.push(generation, std::move(health));
    publish_periodic_recording(generation);

    if (recorder_->snapshot().state == RecordingState::Error &&
        !recording_failure_reported_.exchange(true,
                                              std::memory_order_acq_rel)) {
      publish_error(generation, SessionOperation::Recording,
                    recorder_->snapshot().last_error);
    }
  }

  void fail_connection(std::uint64_t generation, SessionOperation operation,
                       std::string message) {
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      accepting_samples_ = false;
      connection_.state = ConnectionState::Error;
      connection_.last_error = message;
    }
    events_.push(generation, connection_copy());
    publish_error(generation, operation, std::move(message));
  }

  ConnectionSnapshot connection_copy() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return connection_;
  }

  void publish_recording(std::uint64_t generation) {
    events_.push(generation, recorder_->snapshot());
  }

  void publish_configuration_locked(
      std::uint64_t generation,
      const netft::SensorConfiguration &configuration) {
    if (published_configuration_revision_ != 0U) {
      events_.revoke_measurements();
      events_.purge_measurements(generation);
      if (!events_.begin_measurements()) {
        return;
      }
    }
    published_configuration_revision_ = configuration.revision;
    events_.push(generation, configuration);
  }

  void publish_periodic_recording(std::uint64_t generation) {
    auto snapshot = recorder_->snapshot();
    if (snapshot.state != RecordingState::Idle) {
      events_.push(generation, std::move(snapshot));
    }
  }

  void publish_error(std::uint64_t generation, SessionOperation operation,
                     std::string message) {
    SessionError error;
    error.operation = operation;
    error.message = std::move(message);
    error.sequence =
        error_sequence_.fetch_add(1U, std::memory_order_relaxed) + 1U;
    events_.push(generation, std::move(error));
  }

  SessionOptions options_;
  std::shared_ptr<Clock> clock_;
  std::shared_ptr<Recorder> recorder_;
  PlotAggregator plot_;
  std::atomic<std::uint64_t> active_generation_{0};
  EventPublisher events_;

  mutable std::mutex operation_mutex_;
  mutable std::mutex state_mutex_;
  std::condition_variable callback_condition_;
  ConnectionSnapshot connection_;
  netft::HealthSnapshot health_;
  std::optional<TimedSample> latest_;
  std::optional<netft::SensorConfiguration> configuration_;
  std::uint64_t published_configuration_revision_{};
  bool accepting_samples_{};
  bool has_streamed_{};
  std::size_t active_callbacks_{};
  std::atomic<std::uint64_t> sample_revision_{0};
  std::atomic<bool> recording_failure_reported_{false};
  std::atomic<std::uint64_t> error_sequence_{0};

  std::unique_ptr<netft::Client> client_;
  std::mutex health_wait_mutex_;
  std::condition_variable health_condition_;
  bool stop_health_{true};
  std::thread health_thread_;
};

ViewerSession::ViewerSession(SessionEventSink &sink, SessionOptions options)
    : impl_(std::make_unique<Impl>(sink, std::move(options))) {}

ViewerSession::~ViewerSession() = default;

SessionResult ViewerSession::connect(netft::Config config) {
  return impl_->connect(std::move(config));
}

SessionResult ViewerSession::disconnect() { return impl_->disconnect(); }

SessionResult ViewerSession::set_paused(bool paused) {
  return impl_->set_paused(paused);
}

SessionResult ViewerSession::bias() { return impl_->bias(); }

SessionResult
ViewerSession::start_recording(const std::filesystem::path &target,
                               bool overwrite) {
  return impl_->start_recording(target, overwrite);
}

SessionResult ViewerSession::stop_recording() {
  return impl_->stop_recording();
}

SessionSnapshot ViewerSession::snapshot() const { return impl_->snapshot(); }

} // namespace netft_viewer
