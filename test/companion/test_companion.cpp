#include <algorithm>
#include <csignal>
#include <sstream>
#include <streambuf>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include "netft_viewer_companion/companion.hpp"
#include "netft_viewer_companion/protocol.hpp"

namespace netft_viewer::companion {
namespace {

std::string command(std::string_view type, std::string_view request_id,
                    std::string_view payload = "{}") {
  return "{\"protocol\":{\"major\":1,\"minor\":0},\"type\":\"" +
         std::string{type} + "\",\"requestId\":\"" + std::string{request_id} +
         "\",\"monotonicNs\":\"0\",\"payload\":" + std::string{payload} + "}\n";
}

std::vector<nlohmann::json> output_lines(const std::string &output) {
  std::vector<nlohmann::json> frames;
  std::istringstream lines{output};
  std::string line;
  while (std::getline(lines, line)) {
    frames.push_back(nlohmann::json::parse(line));
  }
  return frames;
}

class FailingOutputBuffer final : public std::streambuf {
protected:
  std::streamsize xsputn(const char *, std::streamsize) override { return 0; }
  int overflow(int) override { return traits_type::eof(); }
};

#ifndef _WIN32
void preserved_signal_handler(int) {}

TEST(CompanionTest, DoesNotReplaceProcessSignalHandlers) {
  struct sigaction original{};
  ASSERT_EQ(sigaction(SIGUSR1, nullptr, &original), 0);
  struct sigaction expected{};
  expected.sa_handler = preserved_signal_handler;
  sigemptyset(&expected.sa_mask);
  ASSERT_EQ(sigaction(SIGUSR1, &expected, nullptr), 0);

  std::istringstream commands{command("shutdown", "shutdown-1")};
  std::ostringstream events;
  std::ostringstream logs;
  Companion companion;
  EXPECT_EQ(companion.run(commands, events, logs), 0);

  struct sigaction actual{};
  ASSERT_EQ(sigaction(SIGUSR1, nullptr, &actual), 0);
  EXPECT_EQ(actual.sa_handler, preserved_signal_handler);
  ASSERT_EQ(sigaction(SIGUSR1, &original, nullptr), 0);
}
#endif

TEST(CompanionTest, WritesShutdownResultLastAndJoinsItsWriter) {
  std::istringstream commands{command("hello", "hello-1") +
                              command("shutdown", "shutdown-1")};
  std::ostringstream events;
  std::ostringstream logs;

  Companion companion;
  ASSERT_EQ(companion.run(commands, events, logs), 0);

  const auto frames = output_lines(events.str());
  ASSERT_EQ(frames.size(), 2U);
  EXPECT_EQ(frames.front().at("type"), "hello");
  EXPECT_EQ(frames.back().at("type"), "command_result");
  EXPECT_EQ(frames.back().at("requestId"), "shutdown-1");
  EXPECT_TRUE(frames.back().at("payload").at("success").get<bool>());
}

TEST(CompanionTest, AcceptsCrLfDelimitedCommands) {
  auto commands_text =
      command("hello", "hello-1") + command("shutdown", "shutdown-1");
  for (auto position = commands_text.find('\n'); position != std::string::npos;
       position = commands_text.find('\n', position + 2)) {
    commands_text.insert(position, 1, '\r');
  }
  std::istringstream commands{commands_text};
  std::ostringstream events;
  std::ostringstream logs;

  Companion companion;
  ASSERT_EQ(companion.run(commands, events, logs), 0);

  const auto frames = output_lines(events.str());
  ASSERT_EQ(frames.size(), 2U);
  ASSERT_EQ(frames.front().at("type"), "hello");
  ASSERT_EQ(frames.back().at("type"), "command_result");
  EXPECT_EQ(frames.back().at("requestId"), "shutdown-1");
  EXPECT_TRUE(frames.back().at("payload").at("success").get<bool>());
}

TEST(CompanionTest, DoesNotCountCrLfCarriageReturnTowardsLineLimit) {
  auto commands_text = command("hello", "hello-1");
  commands_text.pop_back();
  ASSERT_LT(commands_text.size(), maximum_line_bytes);
  commands_text.append(maximum_line_bytes - commands_text.size(), ' ');
  commands_text.append("\r\n");
  std::istringstream commands{commands_text};
  std::ostringstream events;
  std::ostringstream logs;

  Companion companion;
  ASSERT_EQ(companion.run(commands, events, logs), 0);

  const auto frames = output_lines(events.str());
  ASSERT_EQ(frames.size(), 1U);
  EXPECT_EQ(frames.front().at("type"), "hello");
}

TEST(CompanionTest, RejectsNonCrLfCarriageReturns) {
  auto trailing_carriage_return = command("hello", "hello-1");
  trailing_carriage_return.pop_back();
  trailing_carriage_return.push_back('\r');

  auto embedded_carriage_return = command("hello", "hello-1");
  embedded_carriage_return.insert(embedded_carriage_return.find("hello-1") + 5,
                                  1, '\r');

  for (const auto &commands_text :
       {trailing_carriage_return, embedded_carriage_return}) {
    std::istringstream commands{commands_text};
    std::ostringstream events;
    std::ostringstream logs;

    Companion companion;
    ASSERT_EQ(companion.run(commands, events, logs), 0);

    const auto frames = output_lines(events.str());
    ASSERT_EQ(frames.size(), 1U);
    EXPECT_EQ(frames.front().at("type"), "error");
  }
}

TEST(CompanionTest, ReportsOutputFailureWithoutWritingDiagnosticsToStdout) {
  std::istringstream commands{command("hello", "hello-1")};
  FailingOutputBuffer failure;
  std::ostream events{&failure};
  std::ostringstream logs;

  Companion companion;
  EXPECT_EQ(companion.run(commands, events, logs), 3);
  EXPECT_FALSE(logs.str().empty());
}

TEST(CompanionTest, DoesNotLogRejectedInputContents) {
  constexpr std::string_view marker = "input-content-must-remain-private/";
  std::istringstream commands{
      "{\"protocol\":{\"major\":1,\"minor\":0},\"type\":\"connect\","
      "\"requestId\":\"req-1\",\"monotonicNs\":\"0\",\"payload\":{"
      "\"sensorHost\":\"input-content-must-remain-private/\"}}\n" +
      command("shutdown", "shutdown-1")};
  std::ostringstream events;
  std::ostringstream logs;

  Companion companion;
  ASSERT_EQ(companion.run(commands, events, logs), 0);
  EXPECT_EQ(logs.str().find(marker), std::string::npos);
  const auto frames = output_lines(events.str());
  const auto result = std::find_if(
      frames.begin(), frames.end(), [](const nlohmann::json &frame) {
        return frame.value("requestId", "") == "req-1";
      });
  ASSERT_NE(result, frames.end());
  EXPECT_EQ(result->at("type"), "command_result");
  EXPECT_FALSE(result->at("payload").at("success").get<bool>());
}

} // namespace
} // namespace netft_viewer::companion
