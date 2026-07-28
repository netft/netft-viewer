#include <filesystem>
#include <fstream>
#include <limits>
#include <sstream>
#include <string>
#include <variant>
#include <vector>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include "netft_viewer_companion/protocol.hpp"

namespace {

std::vector<std::string> fixture_lines(const std::string &name) {
  const auto path = std::filesystem::path{NETFT_VIEWER_SOURCE_DIR} /
                    "protocol" / "fixtures" / name;
  std::ifstream input(path);
  std::vector<std::string> lines;
  for (std::string line; std::getline(input, line);) {
    lines.push_back(std::move(line));
  }
  return lines;
}

nlohmann::json fixture_json(const std::string &name) {
  const auto path = std::filesystem::path{NETFT_VIEWER_SOURCE_DIR} /
                    "protocol" / "fixtures" / name;
  std::ifstream input(path);
  return nlohmann::json::parse(input);
}

std::string serialized_session_type(netft_viewer::SessionEventPayload payload,
                                    bool measurement = false) {
  netft_viewer::SessionEvent event{1U, std::move(payload), std::nullopt};
  if (!measurement) {
    const auto line = netft_viewer::companion::serialize_event(
        netft_viewer::companion::SessionEventMessage{10, std::move(event)});
    if (!line) {
      return {};
    }
    return nlohmann::json::parse(line->json_line())
        .at("type")
        .get<std::string>();
  }

  netft_viewer::SessionEventSink sink;
  if (!sink.begin_measurements()) {
    return {};
  }
  sink.enqueue(std::move(event));
  auto read = sink.try_pop();
  if (!read.event) {
    return {};
  }
  const auto line = netft_viewer::companion::serialize_event(
      netft_viewer::companion::SessionEventMessage{10, std::move(*read.event)});
  if (!line) {
    return {};
  }
  return nlohmann::json::parse(line->json_line()).at("type").get<std::string>();
}

std::string command_at_depth(std::size_t depth) {
  auto command =
      nlohmann::json::parse(fixture_lines("valid-commands.jsonl").front());
  nlohmann::json nested = 0;
  for (std::size_t current = 1U; current < depth; ++current) {
    nested = nlohmann::json{{"next", std::move(nested)}};
  }
  command["padding"] = std::move(nested);
  return command.dump();
}

TEST(ProtocolTest, ParsesEveryValidCommandFixture) {
  const auto lines = fixture_lines("valid-commands.jsonl");
  ASSERT_EQ(lines.size(), 8U);
  for (const auto &line : lines) {
    EXPECT_NO_THROW({
      const auto command = netft_viewer::companion::parse_command(line);
      (void)command;
    });
  }
}

TEST(ProtocolTest, RejectsEveryInvalidCommandFixture) {
  for (const auto &line : fixture_lines("invalid-commands.jsonl")) {
    EXPECT_THROW(
        {
          const auto command = netft_viewer::companion::parse_command(line);
          (void)command;
        },
        netft_viewer::companion::ProtocolError);
  }
  for (const auto &line : fixture_lines("duplicate-commands.jsonl")) {
    EXPECT_THROW(
        {
          const auto command = netft_viewer::companion::parse_command(line);
          (void)command;
        },
        netft_viewer::companion::ProtocolError);
  }
}

TEST(ProtocolTest, RejectsACommandAboveTheByteLimitBeforeParsing) {
  const auto manifest = fixture_json("limits-manifest.json");
  auto value =
      nlohmann::json::parse(fixture_lines("valid-commands.jsonl").front());
  value["padding"] =
      std::string(manifest.at("commandPaddingBytes").get<std::size_t>(), 'x');
  const auto line = value.dump();
  ASSERT_GT(line.size(), manifest.at("limitBytes").get<std::size_t>());
  EXPECT_THROW(
      {
        const auto command = netft_viewer::companion::parse_command(line);
        (void)command;
      },
      netft_viewer::companion::ProtocolError);
}

TEST(ProtocolTest, EnforcesTheSharedJsonNestingBoundary) {
  const auto manifest = fixture_json("limits-manifest.json");
  const auto maximum = manifest.at("maximumNestingDepth").get<std::size_t>();
  EXPECT_EQ(netft_viewer::companion::maximum_json_nesting_depth, maximum);
  EXPECT_NO_THROW({
    const auto command =
        netft_viewer::companion::parse_command(command_at_depth(maximum));
    (void)command;
  });
  EXPECT_THROW(
      {
        const auto command = netft_viewer::companion::parse_command(
            command_at_depth(maximum + 1U));
        (void)command;
      },
      netft_viewer::companion::ProtocolError);
}

TEST(ProtocolTest, EnforcesMinorAndRequestIdBoundaries) {
  const auto manifest = fixture_json("limits-manifest.json");
  EXPECT_EQ(netft_viewer::companion::maximum_request_id_bytes,
            manifest.at("maximumRequestIdBytes").get<std::size_t>());
  auto value =
      nlohmann::json::parse(fixture_lines("valid-commands.jsonl").front());
  value["protocol"]["minor"] = manifest.at("maximumProtocolMinor");
  value["requestId"] =
      std::string(manifest.at("maximumRequestIdBytes").get<std::size_t>(), 'r');
  const auto command = netft_viewer::companion::parse_command(value.dump());
  EXPECT_EQ(std::get<netft_viewer::companion::HelloCommand>(command)
                .header.peer_minor,
            std::numeric_limits<std::uint32_t>::max());

  value["requestId"] = std::string(
      manifest.at("maximumRequestIdBytes").get<std::size_t>() + 1U, 'r');
  EXPECT_THROW(
      {
        const auto invalid =
            netft_viewer::companion::parse_command(value.dump());
        (void)invalid;
      },
      netft_viewer::companion::ProtocolError);
}

TEST(ProtocolTest, PreservesConcreteCommandPayloads) {
  const auto commands = fixture_lines("valid-commands.jsonl");
  const auto connect = netft_viewer::companion::parse_command(commands.at(1));
  ASSERT_TRUE(
      std::holds_alternative<netft_viewer::companion::ConnectCommand>(connect));
  EXPECT_EQ(
      std::get<netft_viewer::companion::ConnectCommand>(connect).sensor_host,
      "192.168.1.1");
}

TEST(ProtocolTest, SerializesOnlyDeliverableMeasurementEvents) {
  netft_viewer::SessionEvent live{1U, netft_viewer::TimedSample{},
                                  std::nullopt};
  netft_viewer::companion::SessionEventMessage message{4, std::move(live)};
  EXPECT_FALSE(netft_viewer::companion::serialize_event(message).has_value());
}

TEST(ProtocolTest, SerializesRecordingProgressCountersAsDecimalStrings) {
  netft_viewer::RecorderSnapshot snapshot;
  snapshot.accepted_samples = 10U;
  snapshot.written_samples = 9U;
  snapshot.bytes_written = 1024U;
  snapshot.queue_size = 1U;
  snapshot.queue_capacity = 65'536U;
  netft_viewer::companion::RecordingProgressEvent event{7, std::move(snapshot)};

  const auto line = netft_viewer::companion::serialize_event(event);
  ASSERT_TRUE(line);
  EXPECT_TRUE(line->valid_for_delivery());
  const auto value = nlohmann::json::parse(line->json_line());
  EXPECT_EQ(value.at("type"), "recording_progress");
  EXPECT_EQ(value.at("payload").at("acceptedSamples"), "10");
  EXPECT_EQ(value.at("payload").at("queueCapacity"), "65536");
}

TEST(ProtocolTest, SerializesOptionalHealthSequencesAsScalarsOrNull) {
  netft::HealthSnapshot populated;
  populated.last_rdt_sequence = 12U;
  populated.last_ft_sequence = 34U;
  netft_viewer::SessionEvent populated_event{1U, std::move(populated),
                                             std::nullopt};
  const auto populated_line = netft_viewer::companion::serialize_event(
      netft_viewer::companion::SessionEventMessage{7,
                                                   std::move(populated_event)});
  ASSERT_TRUE(populated_line);
  const auto populated_payload =
      nlohmann::json::parse(populated_line->json_line()).at("payload");
  EXPECT_EQ(populated_payload.at("lastRdtSequence"), 12U);
  EXPECT_EQ(populated_payload.at("lastFtSequence"), 34U);

  netft::HealthSnapshot empty;
  netft_viewer::SessionEvent empty_event{1U, std::move(empty), std::nullopt};
  const auto empty_line = netft_viewer::companion::serialize_event(
      netft_viewer::companion::SessionEventMessage{8, std::move(empty_event)});
  ASSERT_TRUE(empty_line);
  const auto empty_payload =
      nlohmann::json::parse(empty_line->json_line()).at("payload");
  EXPECT_TRUE(empty_payload.at("lastRdtSequence").is_null());
  EXPECT_TRUE(empty_payload.at("lastFtSequence").is_null());
}

TEST(ProtocolTest, RejectsUncorrelatableResponseValues) {
  const netft_viewer::companion::HelloEvent bad_hello{"", 1, "0.1.0",
                                                      "not-a-snapshot"};
  EXPECT_FALSE(netft_viewer::companion::serialize_event(bad_hello));
  const netft_viewer::companion::HelloEvent bad_request_id{
      "bad/request", 1, "0.1.0", "e424c401587052f03de9b94f76f1e86b78902105"};
  EXPECT_FALSE(netft_viewer::companion::serialize_event(bad_request_id));

  const netft_viewer::companion::CommandResultEvent hello_result{
      "req-1", 2, "hello", true, "", ""};
  EXPECT_FALSE(netft_viewer::companion::serialize_event(hello_result));

  const netft_viewer::companion::CommandResultEvent incomplete_failure{
      "req-1", 3, "connect", false, "", ""};
  EXPECT_FALSE(netft_viewer::companion::serialize_event(incomplete_failure));
}

TEST(ProtocolTest, RetainsMeasurementValidityUntilOutputCommit) {
  netft_viewer::SessionEventSink sink;
  ASSERT_TRUE(sink.begin_measurements());
  netft_viewer::TimedSample sample;
  sample.sample.raw_wrench = {
      std::numeric_limits<std::int32_t>::min(),
      std::numeric_limits<std::int32_t>::max(),
      0,
      0,
      0,
      0,
  };
  sink.enqueue(netft_viewer::SessionEvent{1U, std::move(sample), std::nullopt});
  auto read = sink.try_pop();
  ASSERT_TRUE(read.event);
  auto frame = netft_viewer::companion::serialize_event(
      netft_viewer::companion::SessionEventMessage{4, std::move(*read.event)});
  ASSERT_TRUE(frame);
  ASSERT_TRUE(frame->valid_for_delivery());
  const auto raw =
      nlohmann::json::parse(frame->json_line()).at("payload").at("raw");
  EXPECT_EQ(raw.at(0), std::numeric_limits<std::int32_t>::min());
  EXPECT_EQ(raw.at(1), std::numeric_limits<std::int32_t>::max());

  sink.revoke_measurements();

  EXPECT_FALSE(frame->valid_for_delivery());
}

TEST(ProtocolTest, RejectsSessionPayloadsThatWouldViolateTheEventSchema) {
  netft::SensorConfiguration invalid_configuration;
  netft_viewer::SessionEvent configuration_event{
      1U, std::move(invalid_configuration), std::nullopt};
  EXPECT_FALSE(netft_viewer::companion::serialize_event(
      netft_viewer::companion::SessionEventMessage{
          4, std::move(configuration_event)}));

  netft::HealthSnapshot invalid_health;
  invalid_health.receive_rate_hz = std::numeric_limits<double>::quiet_NaN();
  netft_viewer::SessionEvent health_event{1U, std::move(invalid_health),
                                          std::nullopt};
  EXPECT_FALSE(netft_viewer::companion::serialize_event(
      netft_viewer::companion::SessionEventMessage{5,
                                                   std::move(health_event)}));
}

TEST(ProtocolTest, MapsEverySessionEventVariantToItsProtocolType) {
  netft_viewer::ConnectionSnapshot connection;
  netft::HealthSnapshot health;
  netft_viewer::TimedSample live;
  netft_viewer::PlotBatch plot;
  for (std::size_t index = 0; index < netft_viewer::axes.size(); ++index) {
    plot.axes[index].axis = netft_viewer::axes[index];
  }
  netft_viewer::RecorderSnapshot recorder;
  netft::SensorConfiguration configuration;
  configuration.calibration.counts_per_force_unit = 1.0;
  configuration.calibration.counts_per_torque_unit = 1.0;
  configuration.calibration.force_unit = netft::ForceUnit::Newton;
  configuration.calibration.torque_unit = netft::TorqueUnit::NewtonMillimeter;
  netft_viewer::SessionError error;

  EXPECT_EQ(serialized_session_type(std::move(connection)), "connection_state");
  EXPECT_EQ(serialized_session_type(std::move(health)), "health");
  EXPECT_EQ(serialized_session_type(std::move(live), true), "live_wrench");
  EXPECT_EQ(serialized_session_type(std::move(plot), true), "plot_batch");
  EXPECT_EQ(serialized_session_type(std::move(recorder)), "recording_state");
  EXPECT_EQ(serialized_session_type(std::move(configuration)),
            "configuration_changed");
  EXPECT_EQ(serialized_session_type(std::move(error)), "error");
}

} // namespace
