#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <vector>

#include "detail/protocol.hpp"
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

class CapturingSink final : public SessionEventSink {
public:
  void connection_changed(const ConnectionSnapshot &snapshot) override {
    publish([&] { connections.push_back(snapshot); });
  }

  void health_changed(const netft::HealthSnapshot &snapshot) override {
    publish([&] { health.push_back(snapshot); });
  }

  void live_wrench(const TimedSample &sample) override {
    std::unique_lock<std::mutex> lock(mutex);
    live.push_back(sample);
    condition.notify_all();
    condition.wait(lock, [&] { return !block_live; });
  }

  void plot_batch(const PlotBatch &batch) override {
    publish([&] { plots.push_back(batch); });
  }

  void recording_changed(const RecorderSnapshot &snapshot) override {
    publish([&] { recordings.push_back(snapshot); });
  }

  void configuration_changed(
      const netft::SensorConfiguration &configuration) override {
    publish([&] { configurations.push_back(configuration); });
  }

  void error(const SessionError &error) override {
    publish([&] { errors.push_back(error); });
  }

  template <typename Predicate>
  bool wait(Predicate predicate, std::chrono::milliseconds timeout = 2s) {
    std::unique_lock<std::mutex> lock(mutex);
    return condition.wait_for(lock, timeout, predicate);
  }

  void unblock_live() {
    std::lock_guard<std::mutex> lock(mutex);
    block_live = false;
    condition.notify_all();
  }

  std::mutex mutex;
  std::condition_variable condition;
  bool block_live{};
  std::vector<ConnectionSnapshot> connections;
  std::vector<netft::HealthSnapshot> health;
  std::vector<TimedSample> live;
  std::vector<PlotBatch> plots;
  std::vector<RecorderSnapshot> recordings;
  std::vector<netft::SensorConfiguration> configurations;
  std::vector<SessionError> errors;

private:
  template <typename Function> void publish(Function function) {
    std::lock_guard<std::mutex> lock(mutex);
    function();
    condition.notify_all();
  }
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
  ViewerSession session(sink, options(clock));
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
  ViewerSession session(sink, options({}, recorder));
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

TEST(ViewerSessionTest, BiasIsAcceptedOnlyWhileLiveStreaming) {
  netft::test::FakeSensor sensor;
  CapturingSink sink;
  ViewerSession session(sink, options());

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
  ViewerSession session(sink, options({}, recorder));
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
  ViewerSession session(sink, options());
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
  ViewerSession session(sink, options());
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
  ViewerSession session(sink, options());
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

TEST(ViewerSessionTest, BlockedUiDeliveryDoesNotBlockRecordingOrGrowLiveWork) {
  netft::test::FakeSensor sensor;
  CapturingSink sink;
  sink.block_live = true;
  auto writer = std::make_shared<test::ControlledWriterState>();
  auto recorder = std::make_shared<Recorder>(
      RecorderOptions{}, nullptr,
      std::make_shared<test::ControlledRecorderStorage>(writer));
  ViewerSession session(sink, options({}, recorder));
  sensor.pause();
  ASSERT_EQ(session.connect(config_for(sensor)), SessionResult::Ok);
  ASSERT_TRUE(sensor.wait_for_command(netft::detail::Command::StartRealtime));
  sensor.send_record_now(1U, 0U, 100U);
  ASSERT_TRUE(sink.wait([&] { return sink.live.size() == 1U; }));
  ASSERT_EQ(session.start_recording("session-backlog.csv", false),
            SessionResult::Ok);

  std::uint32_t sequence = 2U;
  for (std::uint64_t accepted = 1U; accepted <= 20U; ++accepted) {
    bool written{};
    for (unsigned attempt = 0; attempt < 5U && !written; ++attempt) {
      sensor.send_record_now(sequence, 0U, 100U + sequence * 4U);
      ++sequence;
      std::unique_lock<std::mutex> lock(writer->mutex);
      written = writer->condition.wait_for(lock, 200ms, [&] {
        return session.snapshot().recording.accepted_samples >= accepted;
      });
    }
    ASSERT_TRUE(written);
  }
  const auto final_sequence =
      session.snapshot().latest_sample->sample.rdt_sequence;
  EXPECT_EQ(session.snapshot().recording.accepted_samples, 20U);
  sink.unblock_live();
  ASSERT_TRUE(sink.wait([&] {
    return !sink.live.empty() &&
           sink.live.back().sample.rdt_sequence == final_sequence;
  }));
  EXPECT_LE(sink.live.size(), 2U);
}

} // namespace
} // namespace netft_viewer
