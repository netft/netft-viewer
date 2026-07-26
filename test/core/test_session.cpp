#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <type_traits>
#include <variant>
#include <vector>

#include "detail/protocol.hpp"
#include "netft_viewer/detail/session_event_queue.hpp"
#include "netft_viewer/session.hpp"
#include "support/controlled_writer.hpp"
#include "support/fake_sensor.hpp"

namespace netft_viewer {
namespace {

using namespace std::chrono_literals;

constexpr auto changed_configuration = R"xml(
<netft><prodname>Fake Net F/T</prodname><cfgcpf>1000000</cfgcpf>
<cfgcpt>1000</cfgcpt><scfgfu>N</scfgfu><scfgtu>N-mm</scfgtu></netft>)xml";

class AtomicClock final : public Clock {
public:
  std::int64_t monotonic_now_ns() const noexcept override {
    return monotonic_ns_.load(std::memory_order_relaxed);
  }

  std::int64_t host_now_ns() const noexcept override {
    return host_ns_.load(std::memory_order_relaxed);
  }

  void set(std::int64_t monotonic_ns, std::int64_t host_ns) noexcept {
    monotonic_ns_.store(monotonic_ns, std::memory_order_relaxed);
    host_ns_.store(host_ns, std::memory_order_relaxed);
  }

private:
  std::atomic<std::int64_t> monotonic_ns_{};
  std::atomic<std::int64_t> host_ns_{};
};

class CapturingSink {
public:
  CapturingSink() : worker_(&CapturingSink::consume, this) {}

  ~CapturingSink() {
    stopping_.store(true, std::memory_order_release);
    channel_.close();
    if (worker_.joinable()) {
      worker_.join();
    }
  }

  SessionEventSink &channel() noexcept { return channel_; }

  CapturingSink(const CapturingSink &) = delete;
  CapturingSink &operator=(const CapturingSink &) = delete;

  template <typename Predicate>
  bool wait(Predicate predicate, std::chrono::milliseconds timeout = 2s) {
    std::unique_lock<std::mutex> lock(mutex);
    return condition.wait_for(lock, timeout, predicate);
  }

  std::mutex mutex;
  std::condition_variable condition;
  std::vector<ConnectionSnapshot> connections;
  std::vector<netft::HealthSnapshot> health;
  std::vector<TimedSample> live;
  std::vector<PlotBatch> plots;
  std::vector<RecorderSnapshot> recordings;
  std::vector<netft::SensorConfiguration> configurations;
  std::vector<SessionError> errors;

private:
  void consume() {
    while (!stopping_.load(std::memory_order_acquire)) {
      auto read = channel_.wait_for_event(10ms);
      if (read.status == SessionEventReadStatus::Closed) {
        return;
      }
      if (read.status != SessionEventReadStatus::Event) {
        continue;
      }
      auto event = std::move(*read.event);
      publish([&] {
        std::visit(
            [&](auto &&payload) {
              using Type = std::decay_t<decltype(payload)>;
              if constexpr (std::is_same<Type, ConnectionSnapshot>::value) {
                connections.push_back(std::move(payload));
              } else if constexpr (std::is_same<Type,
                                                netft::HealthSnapshot>::value) {
                health.push_back(std::move(payload));
              } else if constexpr (std::is_same<Type, TimedSample>::value) {
                live.push_back(std::move(payload));
              } else if constexpr (std::is_same<Type, PlotBatch>::value) {
                plots.push_back(std::move(payload));
              } else if constexpr (std::is_same<Type,
                                                RecorderSnapshot>::value) {
                recordings.push_back(std::move(payload));
              } else if constexpr (std::is_same<
                                       Type,
                                       netft::SensorConfiguration>::value) {
                configurations.push_back(std::move(payload));
              } else if constexpr (std::is_same<Type, SessionError>::value) {
                errors.push_back(std::move(payload));
              }
            },
            std::move(event.payload));
      });
    }
  }

  template <typename Function> void publish(Function function) {
    std::lock_guard<std::mutex> lock(mutex);
    function();
    condition.notify_all();
  }

  SessionEventSink channel_;
  std::atomic<bool> stopping_{false};
  std::thread worker_;
};

netft::Config config_for(const netft::test::FakeSensor &sensor) {
  netft::Config config;
  config.sensor_host = sensor.host();
  config.rdt_port = sensor.rdt_port();
  config.http_port = sensor.http_port();
  config.receive_timeout = 1s;
  config.configuration_connect_timeout = 200ms;
  config.configuration_timeout = 1s;
  config.reconnect_initial_delay = 10ms;
  config.reconnect_max_delay = 20ms;
  return config;
}

SessionOptions options(std::shared_ptr<Clock> clock = {},
                       std::shared_ptr<Recorder> recorder = {}) {
  SessionOptions result;
  result.clock = std::move(clock);
  result.recorder = std::move(recorder);
  result.health_interval = 10ms;
  result.plot_interval = 1ns;
  return result;
}

void connect_and_stream(ViewerSession &session, CapturingSink &sink,
                        netft::test::FakeSensor &sensor,
                        std::uint32_t sequence = 1U) {
  sensor.pause();
  ASSERT_EQ(session.connect(config_for(sensor)), SessionResult::Ok);
  ASSERT_TRUE(sensor.wait_for_command(netft::detail::Command::StartRealtime));
  sensor.send_record_now(sequence, 0U, sequence * 4U + 100U);
  ASSERT_TRUE(sink.wait([&] {
    return std::any_of(sink.live.begin(), sink.live.end(),
                       [&](const TimedSample &sample) {
                         return sample.sample.rdt_sequence == sequence;
                       });
  }));
  ASSERT_EQ(session.snapshot().connection.state, ConnectionState::Streaming);
}

TEST(ViewerSessionTest, PublishesTimestampedRawScaledAndBoundedPlotData) {
  netft::test::FakeSensor sensor;
  CapturingSink sink;
  auto clock = std::make_shared<AtomicClock>();
  ViewerSession session(sink.channel(), options(clock));
  sensor.pause();

  ASSERT_EQ(session.connect(config_for(sensor)), SessionResult::Ok);
  ASSERT_TRUE(sensor.wait_for_command(netft::detail::Command::StartRealtime));
  clock->set(10, 1'000);
  sensor.send_record_now(
      1U, 0U, 100U,
      {1'000'000, -2'000'000, 3'000'000, 4'000'000, -5'000'000, 6'000'000});
  ASSERT_TRUE(sink.wait([&] { return !sink.live.empty(); }));
  clock->set(12, 1'002);
  sensor.send_record_now(2U, 0U, 104U);
  ASSERT_TRUE(sink.wait([&] { return !sink.plots.empty(); }));

  const auto snapshot = session.snapshot();
  ASSERT_TRUE(snapshot.latest_sample);
  EXPECT_EQ(snapshot.latest_sample->sample.rdt_sequence, 2U);
  EXPECT_EQ(sink.live.front().host_time_ns, 1'000);
  EXPECT_EQ(sink.live.front().sample.raw_wrench[0], 1'000'000);
  EXPECT_DOUBLE_EQ(sink.live.front().sample.force[0], 1.0);
  EXPECT_LE(sink.plots.back().axes[0].count, 4U);
}

TEST(ViewerSessionTest, PauseDrainsRecordingAndDoesNotReplayMeasurements) {
  netft::test::FakeSensor sensor;
  CapturingSink sink;
  auto writer = std::make_shared<test::ControlledWriterState>();
  auto recorder = std::make_shared<Recorder>(
      RecorderOptions{}, nullptr,
      std::make_shared<test::ControlledRecorderStorage>(writer));
  ViewerSession session(sink.channel(), options({}, recorder));
  connect_and_stream(session, sink, sensor);

  ASSERT_EQ(session.start_recording("session-pause.csv", false),
            SessionResult::Ok);
  sensor.send_record_now(2U, 0U, 108U);
  ASSERT_TRUE(sink.wait(
      [&] { return session.snapshot().recording.accepted_samples == 1U; }));
  ASSERT_EQ(session.set_paused(true), SessionResult::Ok);
  const auto paused = session.snapshot();
  EXPECT_TRUE(paused.connection.paused);
  EXPECT_EQ(paused.recording.state, RecordingState::Paused);
  EXPECT_EQ(paused.recording.written_samples, 1U);

  sensor.send_record_now(3U, 0U, 112U);
  ASSERT_TRUE(sink.wait([&] {
    return !sink.health.empty() && sink.health.back().delivered_count >= 3U;
  }));
  EXPECT_EQ(session.snapshot().latest_sample->sample.rdt_sequence, 2U);
  EXPECT_EQ(session.snapshot().recording.accepted_samples, 1U);

  ASSERT_EQ(session.set_paused(false), SessionResult::Ok);
  sensor.send_record_now(4U, 0U, 116U);
  ASSERT_TRUE(sink.wait([&] {
    const auto snapshot = session.snapshot();
    return snapshot.latest_sample &&
           snapshot.latest_sample->sample.rdt_sequence == 4U;
  }));
  EXPECT_EQ(session.snapshot().recording.accepted_samples, 2U);
}

TEST(ViewerSessionTest, PublishesPeriodicProgressWhileRecording) {
  netft::test::FakeSensor sensor;
  CapturingSink sink;
  auto writer = std::make_shared<test::ControlledWriterState>();
  auto recorder = std::make_shared<Recorder>(
      RecorderOptions{}, nullptr,
      std::make_shared<test::ControlledRecorderStorage>(writer));
  ViewerSession session(sink.channel(), options({}, recorder));
  connect_and_stream(session, sink, sensor);

  ASSERT_EQ(session.start_recording("session-progress.csv", false),
            SessionResult::Ok);
  sensor.send_record_now(2U, 0U, 108U);
  ASSERT_TRUE(sink.wait([&] {
    return std::any_of(sink.recordings.begin(), sink.recordings.end(),
                       [](const RecorderSnapshot &snapshot) {
                         return snapshot.state == RecordingState::Recording &&
                                snapshot.accepted_samples > 0U;
                       });
  }));

  const auto snapshot = session.snapshot().recording;
  EXPECT_EQ(snapshot.state, RecordingState::Recording);
  EXPECT_GT(snapshot.accepted_samples, 0U);
}

TEST(ViewerSessionTest, BiasIsAcceptedOnlyWhileLiveStreaming) {
  netft::test::FakeSensor sensor;
  CapturingSink sink;
  ViewerSession session(sink.channel(), options());

  EXPECT_EQ(session.bias(), SessionResult::InvalidState);
  sensor.pause();
  ASSERT_EQ(session.connect(config_for(sensor)), SessionResult::Ok);
  EXPECT_EQ(session.bias(), SessionResult::InvalidState);
  ASSERT_TRUE(sensor.wait_for_command(netft::detail::Command::StartRealtime));
  sensor.send_record_now(1U, 0U, 100U);
  ASSERT_TRUE(sink.wait([&] { return !sink.live.empty(); }));
  EXPECT_EQ(session.bias(), SessionResult::Ok);
  EXPECT_TRUE(sensor.wait_for_command(netft::detail::Command::SetSoftwareBias));
  ASSERT_EQ(session.set_paused(true), SessionResult::Ok);
  EXPECT_EQ(session.bias(), SessionResult::InvalidState);
}

TEST(ViewerSessionTest, RecordingFailurePreservesTheStreamingConnection) {
  netft::test::FakeSensor sensor;
  CapturingSink sink;
  auto writer = std::make_shared<test::ControlledWriterState>();
  writer->fail_create = true;
  auto recorder = std::make_shared<Recorder>(
      RecorderOptions{}, nullptr,
      std::make_shared<test::ControlledRecorderStorage>(writer));
  ViewerSession session(sink.channel(), options({}, recorder));
  connect_and_stream(session, sink, sensor);

  EXPECT_EQ(session.start_recording("session-failure.csv", false),
            SessionResult::Failed);
  EXPECT_EQ(session.snapshot().connection.state, ConnectionState::Streaming);
  ASSERT_TRUE(sink.wait([&] {
    return std::any_of(
        sink.errors.begin(), sink.errors.end(), [](const SessionError &error) {
          return error.operation == SessionOperation::StartRecording;
        });
  }));
}

TEST(ViewerSessionTest, ConfigurationRevisionChangesArePublished) {
  netft::test::FakeSensor sensor{200.0};
  CapturingSink sink;
  ViewerSession session(sink.channel(), options());
  auto config = config_for(sensor);
  config.receive_timeout = 40ms;
  sensor.pause();
  ASSERT_EQ(session.connect(config), SessionResult::Ok);
  ASSERT_TRUE(sensor.wait_for_command(netft::detail::Command::StartRealtime));
  sensor.send_record_now(1U, 0U, 104U);
  ASSERT_TRUE(sink.wait([&] { return !sink.live.empty(); }));
  ASSERT_TRUE(sink.wait([&] {
    return std::any_of(sink.configurations.begin(), sink.configurations.end(),
                       [](const netft::SensorConfiguration &value) {
                         return value.revision == 1U;
                       });
  }));

  sensor.set_xml_configuration(changed_configuration);
  ASSERT_TRUE(sensor.wait_for_http_request(2U, 1s));
  sensor.resume();
  ASSERT_TRUE(sink.wait([&] {
    return std::any_of(sink.configurations.begin(), sink.configurations.end(),
                       [](const netft::SensorConfiguration &value) {
                         return value.revision == 2U;
                       });
  }));
}

TEST(ViewerSessionTest, DisconnectClearsPauseAndCancelsConnectingGeneration) {
  netft::test::FakeSensor first;
  netft::test::FakeSensor second;
  CapturingSink sink;
  ViewerSession session(sink.channel(), options());
  connect_and_stream(session, sink, first);
  ASSERT_EQ(session.set_paused(true), SessionResult::Ok);
  ASSERT_TRUE(session.snapshot().connection.paused);
  ASSERT_EQ(session.disconnect(), SessionResult::Ok);
  EXPECT_FALSE(session.snapshot().connection.paused);

  const auto paused_generation = session.snapshot().connection.generation;
  second.pause();
  second.set_http_response_delay(200ms);
  ASSERT_EQ(session.connect(config_for(second)), SessionResult::Ok);
  ASSERT_TRUE(second.wait_for_http_request());
  EXPECT_EQ(session.disconnect(), SessionResult::Ok);
  auto disconnected = session.snapshot();
  EXPECT_EQ(disconnected.connection.state, ConnectionState::Disconnected);
  EXPECT_FALSE(disconnected.connection.paused);
  EXPECT_GT(disconnected.connection.generation, paused_generation);
}

TEST(ViewerSessionTest, ReconnectUsesANewGeneration) {
  netft::test::FakeSensor first;
  netft::test::FakeSensor second;
  CapturingSink sink;
  ViewerSession session(sink.channel(), options());
  first.pause();
  first.set_http_response_delay(200ms);

  ASSERT_EQ(session.connect(config_for(first)), SessionResult::Ok);
  ASSERT_TRUE(first.wait_for_http_request());
  EXPECT_EQ(session.disconnect(), SessionResult::Ok);
  auto disconnected = session.snapshot();
  EXPECT_EQ(disconnected.connection.state, ConnectionState::Disconnected);
  EXPECT_FALSE(disconnected.connection.paused);
  const auto first_generation = disconnected.connection.generation;

  connect_and_stream(session, sink, second, 900U);
  const auto reconnected = session.snapshot();
  EXPECT_GT(reconnected.connection.generation, first_generation);
  EXPECT_EQ(reconnected.latest_sample->sample.rdt_sequence, 900U);
}

TEST(ViewerSessionTest, ConnectingAfterStreamingReportsARealReconnect) {
  netft::test::FakeSensor sensor;
  CapturingSink sink;
  ViewerSession session(sink.channel(), options());
  auto config = config_for(sensor);
  config.receive_timeout = 40ms;
  sensor.pause();
  ASSERT_EQ(session.connect(config), SessionResult::Ok);
  ASSERT_TRUE(sensor.wait_for_command(netft::detail::Command::StartRealtime));
  sensor.send_record_now(1U, 0U, 104U);
  ASSERT_TRUE(sink.wait([&] { return !sink.live.empty(); }));

  sensor.set_http_response_delay(200ms);
  ASSERT_TRUE(sensor.wait_for_http_request(2U, 1s));
  ASSERT_TRUE(sink.wait([&] {
    return std::any_of(sink.connections.begin(), sink.connections.end(),
                       [](const ConnectionSnapshot &snapshot) {
                         return snapshot.state == ConnectionState::Reconnecting;
                       });
  }));
}

TEST(SessionEventQueueTest, CoalescesEveryStateSnapshotToItsLatestValue) {
  detail::SessionEventQueue queue;
  constexpr std::uint64_t generation = 7U;
  for (std::uint64_t revision = 1U; revision <= 100U; ++revision) {
    ConnectionSnapshot connection;
    connection.state = revision == 100U ? ConnectionState::Streaming
                                        : ConnectionState::Connecting;
    connection.generation = generation;
    queue.push(SessionEvent{generation, connection});

    netft::SensorConfiguration configuration;
    configuration.revision = revision;
    queue.push(SessionEvent{generation, configuration});
  }

  EXPECT_EQ(queue.size(), 2U);
  const auto first = queue.pop();
  const auto second = queue.pop();
  ASSERT_TRUE(first);
  ASSERT_TRUE(second);
  const auto &connection = std::get<ConnectionSnapshot>(first->payload);
  const auto &configuration =
      std::get<netft::SensorConfiguration>(second->payload);
  EXPECT_EQ(connection.state, ConnectionState::Streaming);
  EXPECT_EQ(configuration.revision, 100U);
}

TEST(SessionEventQueueTest, BoundsErrorsAndReportsDroppedOccurrences) {
  detail::SessionEventQueue queue;
  constexpr std::uint64_t generation = 11U;
  for (std::uint64_t sequence = 1U; sequence <= 100U; ++sequence) {
    SessionError error;
    error.operation = SessionOperation::Recording;
    error.sequence = sequence;
    queue.push(SessionEvent{generation, std::move(error)});
  }

  EXPECT_LE(queue.size(), detail::SessionEventQueue::capacity);
  EXPECT_EQ(queue.error_count(), detail::SessionEventQueue::error_capacity);
  EXPECT_EQ(queue.dropped_error_count(),
            100U - detail::SessionEventQueue::error_capacity);
  std::optional<SessionEvent> latest;
  while (auto event = queue.pop()) {
    latest = std::move(event);
  }
  ASSERT_TRUE(latest);
  const auto &error = std::get<SessionError>(latest->payload);
  EXPECT_EQ(error.sequence, 100U);
  EXPECT_EQ(error.dropped_before, queue.dropped_error_count());
}

TEST(SessionEventSinkTest, ConcreteHandoffRetainsABoundedErrorTail) {
  static_assert(std::is_final<SessionEventSink>::value,
                "The handoff must not execute overridable consumer code");
  SessionEventSink sink;
  constexpr std::uint64_t generation = 13U;
  for (std::uint64_t sequence = 1U; sequence <= 100U; ++sequence) {
    SessionError error;
    error.operation = SessionOperation::Sensor;
    error.sequence = sequence;
    sink.enqueue(SessionEvent{generation, std::move(error)});
  }

  std::vector<SessionError> retained;
  for (;;) {
    auto read = sink.try_pop();
    if (read.status == SessionEventReadStatus::Empty) {
      break;
    }
    ASSERT_EQ(read.status, SessionEventReadStatus::Event);
    retained.push_back(std::get<SessionError>(std::move(read.event->payload)));
  }
  ASSERT_EQ(retained.size(), detail::SessionEventQueue::error_capacity);
  EXPECT_EQ(retained.front().sequence,
            100U - detail::SessionEventQueue::error_capacity + 1U);
  EXPECT_EQ(retained.back().sequence, 100U);
  EXPECT_EQ(retained.back().dropped_before,
            100U - detail::SessionEventQueue::error_capacity);
}

TEST(SessionEventSinkTest, CloseDropsPendingEventsAndRejectsFutureEnqueue) {
  SessionEventSink sink;
  SessionError before_close;
  before_close.sequence = 1U;
  sink.enqueue(SessionEvent{1U, std::move(before_close)});

  sink.close();
  sink.close();
  EXPECT_EQ(sink.try_pop().status, SessionEventReadStatus::Closed);

  SessionError after_close;
  after_close.sequence = 2U;
  sink.enqueue(SessionEvent{1U, std::move(after_close)});
  EXPECT_EQ(sink.try_pop().status, SessionEventReadStatus::Closed);
}

TEST(SessionEventSinkTest, CloseImmediatelyWakesALongWaiter) {
  SessionEventSink sink;
  std::promise<void> started;
  auto entered = started.get_future();
  auto waiter = std::async(std::launch::async, [&] {
    started.set_value();
    return sink.wait_for_event(std::chrono::hours{24});
  });
  entered.wait();
  EXPECT_EQ(waiter.wait_for(50ms), std::future_status::timeout);

  sink.close();

  ASSERT_EQ(waiter.wait_for(1s), std::future_status::ready);
  EXPECT_EQ(waiter.get().status, SessionEventReadStatus::Closed);
}

TEST(ViewerSessionTest, RevokedPoppedMeasurementNeverBecomesValidAgain) {
  netft::test::FakeSensor sensor;
  SessionEventSink events;
  ViewerSession session(events, options());
  sensor.pause();
  ASSERT_EQ(session.connect(config_for(sensor)), SessionResult::Ok);
  ASSERT_TRUE(sensor.wait_for_command(netft::detail::Command::StartRealtime));
  sensor.send_record_now(1U, 0U, 100U);

  std::optional<SessionEvent> old_measurement;
  const auto old_deadline = std::chrono::steady_clock::now() + 1s;
  while (!old_measurement && std::chrono::steady_clock::now() < old_deadline) {
    auto read = events.wait_for_event(20ms);
    ASSERT_NE(read.status, SessionEventReadStatus::Closed);
    if (read.status == SessionEventReadStatus::Event &&
        std::holds_alternative<TimedSample>(read.event->payload)) {
      old_measurement = std::move(read.event);
    }
  }
  ASSERT_TRUE(old_measurement);
  ASSERT_TRUE(old_measurement->valid_for_delivery());
  const auto old_epoch = old_measurement->measurement_epoch();

  ASSERT_EQ(session.set_paused(true), SessionResult::Ok);
  EXPECT_FALSE(old_measurement->valid_for_delivery());
  ASSERT_EQ(session.set_paused(false), SessionResult::Ok);
  EXPECT_FALSE(old_measurement->valid_for_delivery());

  sensor.send_record_now(2U, 0U, 104U);
  std::optional<SessionEvent> new_measurement;
  const auto new_deadline = std::chrono::steady_clock::now() + 1s;
  while (!new_measurement && std::chrono::steady_clock::now() < new_deadline) {
    auto read = events.wait_for_event(20ms);
    ASSERT_NE(read.status, SessionEventReadStatus::Closed);
    if (read.status == SessionEventReadStatus::Event &&
        std::holds_alternative<TimedSample>(read.event->payload)) {
      new_measurement = std::move(read.event);
    }
  }
  ASSERT_TRUE(new_measurement);
  EXPECT_TRUE(new_measurement->valid_for_delivery());
  EXPECT_NE(new_measurement->measurement_epoch(), old_epoch);
}

TEST(ViewerSessionTest, SnapshotWaitsForPauseToPublishACompositeState) {
  netft::test::FakeSensor sensor;
  CapturingSink sink;
  auto writer = std::make_shared<test::ControlledWriterState>();
  auto recorder = std::make_shared<Recorder>(
      RecorderOptions{}, nullptr,
      std::make_shared<test::ControlledRecorderStorage>(writer));
  ViewerSession session(sink.channel(), options({}, recorder));
  connect_and_stream(session, sink, sensor);
  ASSERT_EQ(session.start_recording("session-coherence.csv", false),
            SessionResult::Ok);
  {
    std::lock_guard<std::mutex> lock(writer->mutex);
    writer->block_writes = true;
    writer->write_entered = false;
  }
  sensor.send_record_now(2U, 0U, 108U);
  ASSERT_TRUE(test::wait_for_write_entry(writer, 1s));

  auto pause =
      std::async(std::launch::async, [&] { return session.set_paused(true); });
  const auto deadline = std::chrono::steady_clock::now() + 1s;
  while (recorder->snapshot().state != RecordingState::Pausing &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::yield();
  }
  ASSERT_EQ(recorder->snapshot().state, RecordingState::Pausing);

  auto composite =
      std::async(std::launch::async, [&] { return session.snapshot(); });
  EXPECT_EQ(composite.wait_for(50ms), std::future_status::timeout);
  test::unblock_writes(writer);
  ASSERT_EQ(pause.get(), SessionResult::Ok);
  const auto snapshot = composite.get();
  EXPECT_TRUE(snapshot.connection.paused);
  EXPECT_EQ(snapshot.recording.state, RecordingState::Paused);
}

TEST(ViewerSessionTest, DestructionStopsOwnedWorkersAndFinalizesRecording) {
  netft::test::FakeSensor sensor;
  CapturingSink sink;
  auto writer = std::make_shared<test::ControlledWriterState>();
  auto recorder = std::make_shared<Recorder>(
      RecorderOptions{}, nullptr,
      std::make_shared<test::ControlledRecorderStorage>(writer));
  {
    ViewerSession session(sink.channel(), options({}, recorder));
    connect_and_stream(session, sink, sensor);
    ASSERT_EQ(session.start_recording("session-lifecycle.csv", false),
              SessionResult::Ok);
    sensor.send_record_now(2U, 0U, 108U);
    ASSERT_TRUE(sink.wait(
        [&] { return session.snapshot().recording.accepted_samples == 1U; }));
  }

  EXPECT_EQ(recorder->snapshot().state, RecordingState::Idle);
  EXPECT_TRUE(sensor.wait_for_command(netft::detail::Command::StopStreaming));
}

} // namespace
} // namespace netft_viewer
