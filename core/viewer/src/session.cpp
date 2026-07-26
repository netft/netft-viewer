#include "netft_viewer/session.hpp"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <exception>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>
#include <variant>

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

struct ConnectionEvent {
  ConnectionSnapshot value;
};
struct HealthEvent {
  netft::HealthSnapshot value;
};
struct LiveEvent {
  TimedSample value;
};
struct PlotEvent {
  PlotBatch value;
};
struct RecordingEvent {
  RecorderSnapshot value;
};
struct ConfigurationEvent {
  netft::SensorConfiguration value;
};
struct ErrorEvent {
  SessionError value;
};
struct Fence {
  std::mutex mutex;
  std::condition_variable condition;
  bool complete{};
};
struct FenceEvent {
  std::shared_ptr<Fence> value;
};

using EventPayload =
    std::variant<ConnectionEvent, HealthEvent, LiveEvent, PlotEvent,
                 RecordingEvent, ConfigurationEvent, ErrorEvent, FenceEvent>;

struct QueuedEvent {
  std::uint64_t generation{};
  EventPayload payload;
};

template <typename Type>
constexpr bool coalesced_event = std::is_same<Type, HealthEvent>::value ||
                                 std::is_same<Type, LiveEvent>::value ||
                                 std::is_same<Type, PlotEvent>::value ||
                                 std::is_same<Type, RecordingEvent>::value;

class EventDispatcher {
public:
  EventDispatcher(SessionEventSink &sink,
                  const std::atomic<std::uint64_t> &active_generation)
      : sink_(sink), active_generation_(active_generation),
        worker_(&EventDispatcher::run, this) {}

  ~EventDispatcher() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
    }
    condition_.notify_all();
    if (worker_.joinable()) {
      worker_.join();
    }
  }

  template <typename Event> void push(std::uint64_t generation, Event event) {
    std::lock_guard<std::mutex> lock(mutex_);
    if constexpr (coalesced_event<Event>) {
      for (auto iterator = events_.begin(); iterator != events_.end();
           ++iterator) {
        if (iterator->generation == generation &&
            std::holds_alternative<Event>(iterator->payload)) {
          iterator->payload = std::move(event);
          condition_.notify_one();
          return;
        }
      }
    }
    events_.push_back({generation, std::move(event)});
    condition_.notify_one();
  }

  void purge_measurements(std::uint64_t generation) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto iterator = events_.begin();
    while (iterator != events_.end()) {
      const auto measurement =
          std::holds_alternative<LiveEvent>(iterator->payload) ||
          std::holds_alternative<PlotEvent>(iterator->payload);
      if (iterator->generation == generation && measurement) {
        iterator = events_.erase(iterator);
      } else {
        ++iterator;
      }
    }
  }

  void fence(std::uint64_t generation) {
    if (std::this_thread::get_id() == worker_.get_id()) {
      return;
    }
    auto fence = std::make_shared<Fence>();
    push(generation, FenceEvent{fence});
    std::unique_lock<std::mutex> lock(fence->mutex);
    fence->condition.wait(lock, [&] { return fence->complete; });
  }

private:
  void run() noexcept {
    for (;;) {
      QueuedEvent event;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        condition_.wait(lock, [&] { return stopping_ || !events_.empty(); });
        if (events_.empty()) {
          return;
        }
        event = std::move(events_.front());
        events_.pop_front();
      }
      if (auto *fence = std::get_if<FenceEvent>(&event.payload)) {
        {
          std::lock_guard<std::mutex> lock(fence->value->mutex);
          fence->value->complete = true;
        }
        fence->value->condition.notify_all();
        continue;
      }
      if (event.generation !=
          active_generation_.load(std::memory_order_acquire)) {
        continue;
      }
      try {
        std::visit(
            [&](const auto &typed) {
              using Type = std::decay_t<decltype(typed)>;
              if constexpr (std::is_same<Type, ConnectionEvent>::value) {
                sink_.connection_changed(typed.value);
              } else if constexpr (std::is_same<Type, HealthEvent>::value) {
                sink_.health_changed(typed.value);
              } else if constexpr (std::is_same<Type, LiveEvent>::value) {
                sink_.live_wrench(typed.value);
              } else if constexpr (std::is_same<Type, PlotEvent>::value) {
                sink_.plot_batch(typed.value);
              } else if constexpr (std::is_same<Type, RecordingEvent>::value) {
                sink_.recording_changed(typed.value);
              } else if constexpr (std::is_same<Type,
                                                ConfigurationEvent>::value) {
                sink_.configuration_changed(typed.value);
              } else if constexpr (std::is_same<Type, ErrorEvent>::value) {
                sink_.error(typed.value);
              }
            },
            event.payload);
      } catch (...) {
        // Event consumers are isolated from acquisition and recording.
      }
    }
  }

  SessionEventSink &sink_;
  const std::atomic<std::uint64_t> &active_generation_;
  std::mutex mutex_;
  std::condition_variable condition_;
  std::deque<QueuedEvent> events_;
  bool stopping_{};
  std::thread worker_;
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

class ViewerSession::Impl {
public:
  Impl(SessionEventSink &sink, SessionOptions options)
      : options_(std::move(options)),
        clock_(options_.clock ? options_.clock
                              : std::make_shared<SystemClock>()),
        recorder_(options_.recorder ? options_.recorder
                                    : std::make_shared<Recorder>()),
        plot_(options_.plot_interval), dispatcher_(sink, active_generation_) {
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
      recording_failure_reported_ = false;
    }
    dispatcher_.push(generation, ConnectionEvent{connection_copy()});

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
    dispatcher_.push(generation, ConnectionEvent{connection_copy()});

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

    const auto recording = recorder_->snapshot().state;
    if (recording != RecordingState::Idle) {
      const auto result = recorder_->stop();
      publish_recording(generation);
      if (result != RecorderResult::Ok) {
        publish_error(generation, SessionOperation::StopRecording,
                      recorder_->snapshot().last_error);
      }
    }

    plot_.reset();
    dispatcher_.purge_measurements(generation);
    dispatcher_.fence(generation);
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
    dispatcher_.push(generation, ConnectionEvent{connection_copy()});
    return SessionResult::Ok;
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
      if (recorder_->snapshot().state == RecordingState::Recording &&
          recorder_->pause() != RecorderResult::Ok) {
        recording_failed = true;
      }
      plot_.reset();
      dispatcher_.purge_measurements(generation);
      dispatcher_.fence(generation);
      {
        std::lock_guard<std::mutex> lock(state_mutex_);
        connection_.paused = true;
      }
    } else {
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
    dispatcher_.push(generation, ConnectionEvent{connection_copy()});
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
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      if (generation != connection_.generation || !accepting_samples_) {
        return;
      }
      ++active_callbacks_;
    }

    try {
      TimedSample timed{sample, clock_->host_now_ns(),
                        clock_->monotonic_now_ns()};
      const auto submit_result = recorder_->submit(sample);
      const auto plot_batch = plot_.push(timed);
      bool connection_changed = false;
      {
        std::lock_guard<std::mutex> lock(state_mutex_);
        if (generation == connection_.generation && accepting_samples_) {
          latest_ = timed;
          if (connection_.state != ConnectionState::Streaming) {
            connection_.state = ConnectionState::Streaming;
            connection_.last_error.clear();
            connection_changed = true;
          }
        }
      }

      if (generation == active_generation_.load(std::memory_order_acquire)) {
        if (connection_changed) {
          dispatcher_.push(generation, ConnectionEvent{connection_copy()});
        }
        dispatcher_.push(generation, LiveEvent{std::move(timed)});
        if (plot_batch) {
          dispatcher_.push(generation, PlotEvent{*plot_batch});
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
    netft::HealthSnapshot health;
    try {
      health = client->health();
    } catch (...) {
      return;
    }

    std::optional<netft::SensorConfiguration> changed_configuration;
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
        changed_configuration = configuration_;
      }
      auto mapped = connection_state_for(health.state);
      if (connection_.state == ConnectionState::Disconnecting) {
        mapped = ConnectionState::Disconnecting;
      } else if (connection_.state == ConnectionState::Streaming &&
                 mapped == ConnectionState::Connecting) {
        // A health poll may have copied Connecting immediately before the
        // first sample callback established Streaming.
        mapped = ConnectionState::Streaming;
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
      dispatcher_.push(generation, ConnectionEvent{*changed_connection});
    }
    if (changed_configuration) {
      dispatcher_.push(generation, ConfigurationEvent{*changed_configuration});
    }
    dispatcher_.push(generation, HealthEvent{std::move(health)});
    publish_recording(generation);

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
    dispatcher_.push(generation, ConnectionEvent{connection_copy()});
    publish_error(generation, operation, std::move(message));
  }

  ConnectionSnapshot connection_copy() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return connection_;
  }

  void publish_recording(std::uint64_t generation) {
    dispatcher_.push(generation, RecordingEvent{recorder_->snapshot()});
  }

  void publish_error(std::uint64_t generation, SessionOperation operation,
                     std::string message) {
    dispatcher_.push(generation,
                     ErrorEvent{SessionError{operation, std::move(message)}});
  }

  SessionOptions options_;
  std::shared_ptr<Clock> clock_;
  std::shared_ptr<Recorder> recorder_;
  PlotAggregator plot_;
  std::atomic<std::uint64_t> active_generation_{0};
  EventDispatcher dispatcher_;

  mutable std::mutex operation_mutex_;
  mutable std::mutex state_mutex_;
  std::condition_variable callback_condition_;
  ConnectionSnapshot connection_;
  netft::HealthSnapshot health_;
  std::optional<TimedSample> latest_;
  std::optional<netft::SensorConfiguration> configuration_;
  bool accepting_samples_{};
  std::size_t active_callbacks_{};
  std::atomic<bool> recording_failure_reported_{false};

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
