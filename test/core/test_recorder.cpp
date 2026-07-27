#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "netft_viewer/recorder.hpp"
#include "support/controlled_writer.hpp"

namespace netft_viewer {
namespace {

using namespace std::chrono_literals;

class FixedRecorderClock final : public RecorderClock {
public:
  std::chrono::steady_clock::time_point steady_now() const noexcept override {
    return steady_time_;
  }

  std::chrono::system_clock::time_point system_now() const noexcept override {
    return system_time_;
  }

  std::chrono::steady_clock::time_point steady_time_{100s};
  std::chrono::system_clock::time_point system_time_{1'700'000'000s};
};

class TestDirectory {
public:
  TestDirectory() {
    static std::atomic<std::uint64_t> counter{0};
    const auto id = counter.fetch_add(1, std::memory_order_relaxed);
    path_ = std::filesystem::temp_directory_path() /
            ("netft-viewer-recorder-" + std::to_string(id) + "-" +
             std::to_string(
                 std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(path_);
  }

  ~TestDirectory() {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
  }

  std::filesystem::path file(std::string_view name = "capture.csv") const {
    return path_ / name;
  }

private:
  std::filesystem::path path_;
};

netft::Sample sample_at(std::uint32_t sequence,
                        std::chrono::steady_clock::time_point received_at) {
  netft::Sample sample;
  sample.rdt_sequence = sequence;
  sample.ft_sequence = sequence + 100U;
  sample.status = 7U;
  sample.configuration_revision = 3U;
  sample.received_at = received_at;
  for (std::size_t index = 0; index < sample.raw_wrench.size(); ++index) {
    sample.raw_wrench[index] = static_cast<std::int32_t>(
        sequence * 10U + static_cast<std::uint32_t>(index));
  }
  sample.force = {1.25, -2.5, 3.75};
  sample.torque = {4.5, -5.25, 6.0};
  sample.force_unit = netft::ForceUnit::Newton;
  sample.torque_unit = netft::TorqueUnit::NewtonMillimeter;
  return sample;
}

std::vector<std::string> read_lines(const std::filesystem::path &path) {
  std::ifstream stream(path);
  std::vector<std::string> lines;
  for (std::string line; std::getline(stream, line);) {
    lines.push_back(std::move(line));
  }
  return lines;
}

std::vector<std::string> split_csv_row(const std::string &line) {
  std::istringstream stream(line);
  std::vector<std::string> fields;
  for (std::string field; std::getline(stream, field, ',');) {
    fields.push_back(std::move(field));
  }
  return fields;
}

TEST(RecorderTest, PauseDrainsAndResumeLeavesSequenceAndTimestampGap) {
  TestDirectory directory;
  const auto clock = std::make_shared<FixedRecorderClock>();
  Recorder recorder(RecorderOptions{}, clock);
  const auto target = directory.file();

  ASSERT_EQ(recorder.start(target, OverwritePolicy::Refuse),
            RecorderResult::Ok);
  ASSERT_EQ(recorder.submit(sample_at(1U, clock->steady_time_ + 1ms)),
            SubmitResult::Accepted);
  ASSERT_EQ(recorder.pause(), RecorderResult::Ok);
  EXPECT_EQ(recorder.submit(sample_at(2U, clock->steady_time_ + 2ms)),
            SubmitResult::Paused);
  ASSERT_EQ(recorder.resume(), RecorderResult::Ok);
  ASSERT_EQ(recorder.submit(sample_at(3U, clock->steady_time_ + 3ms)),
            SubmitResult::Accepted);
  ASSERT_EQ(recorder.stop(), RecorderResult::Ok);

  const auto lines = read_lines(target);
  ASSERT_EQ(lines.size(), 3U);
  const auto first = split_csv_row(lines[1]);
  const auto second = split_csv_row(lines[2]);
  ASSERT_EQ(first.size(), 20U);
  ASSERT_EQ(second.size(), 20U);
  EXPECT_EQ(first[2], "1");
  EXPECT_EQ(second[2], "3");
  EXPECT_EQ(first[0], "1700000000001000000");
  EXPECT_EQ(first[1], "1000000");
  EXPECT_FALSE(std::filesystem::exists(target.string() + ".partial"));
  const auto snapshot = recorder.snapshot();
  EXPECT_EQ(snapshot.accepted_samples, 2U);
  EXPECT_EQ(snapshot.written_samples, 2U);
}

TEST(RecorderTest, RefusesAnExistingRecoveryPartialWithoutChangingIt) {
  TestDirectory directory;
  const auto target = directory.file();
  const auto partial = std::filesystem::path(target.string() + ".partial");
  {
    std::ofstream stream(partial);
    stream << "recovery-data";
  }
  Recorder recorder;

  EXPECT_EQ(recorder.start(target, OverwritePolicy::Refuse),
            RecorderResult::PartialExists);
  EXPECT_EQ(recorder.snapshot().state, RecordingState::Idle);
  const auto lines = read_lines(partial);
  ASSERT_EQ(lines.size(), 1U);
  EXPECT_EQ(lines[0], "recovery-data");
}

TEST(RecorderTest,
     ReplacesAnExistingFinalOnlyAfterExplicitApprovalAndSuccessfulClose) {
  TestDirectory directory;
  const auto target = directory.file();
  {
    std::ofstream stream(target);
    stream << "old-data";
  }
  Recorder recorder;

  EXPECT_EQ(recorder.start(target, OverwritePolicy::Refuse),
            RecorderResult::DestinationExists);
  ASSERT_EQ(read_lines(target), (std::vector<std::string>{"old-data"}));

  ASSERT_EQ(recorder.start(target, OverwritePolicy::Replace),
            RecorderResult::Ok);
  ASSERT_EQ(recorder.submit(sample_at(11U, std::chrono::steady_clock::now())),
            SubmitResult::Accepted);
  ASSERT_EQ(read_lines(target), (std::vector<std::string>{"old-data"}));
  ASSERT_EQ(recorder.stop(), RecorderResult::Ok);
  const auto lines = read_lines(target);
  ASSERT_EQ(lines.size(), 2U);
  EXPECT_EQ(split_csv_row(lines[1])[2], "11");
}

TEST(RecorderTest, FlushesTheWriterAtTheOneSecondDeadline) {
  auto state = std::make_shared<test::ControlledWriterState>();
  auto storage = std::make_shared<test::ControlledRecorderStorage>(state);
  Recorder recorder(RecorderOptions{}, std::make_shared<FixedRecorderClock>(),
                    storage);

  ASSERT_EQ(recorder.start("deadline.csv", OverwritePolicy::Refuse),
            RecorderResult::Ok);
  std::size_t initial_flushes{};
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    initial_flushes = state->flush_calls;
  }
  ASSERT_TRUE(test::wait_for_flush_count(state, initial_flushes + 1U, 2s));
  EXPECT_EQ(recorder.stop(), RecorderResult::Ok);
}

TEST(RecorderTest, OverflowStopsAcceptanceWithoutBlockingTheProducer) {
  auto state = std::make_shared<test::ControlledWriterState>();
  auto storage = std::make_shared<test::ControlledRecorderStorage>(state);
  Recorder recorder(RecorderOptions{}, std::make_shared<FixedRecorderClock>(),
                    storage);
  ASSERT_EQ(recorder.start("overflow.csv", OverwritePolicy::Refuse),
            RecorderResult::Ok);
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->block_writes = true;
    state->write_entered = false;
  }
  ASSERT_EQ(recorder.submit(sample_at(1U, std::chrono::steady_clock::now())),
            SubmitResult::Accepted);
  ASSERT_TRUE(test::wait_for_write_entry(state, 1s));

  auto submissions = std::async(std::launch::async, [&] {
    SubmitResult result = SubmitResult::Accepted;
    for (std::uint32_t sequence = 2U; result == SubmitResult::Accepted;
         ++sequence) {
      result = recorder.submit(
          sample_at(sequence, std::chrono::steady_clock::now()));
    }
    return result;
  });

  EXPECT_EQ(submissions.wait_for(1s), std::future_status::ready);
  EXPECT_EQ(submissions.get(), SubmitResult::Overflow);
  EXPECT_EQ(recorder.snapshot().state, RecordingState::Error);
  EXPECT_EQ(recorder.submit(sample_at(99U, std::chrono::steady_clock::now())),
            SubmitResult::Failed);

  test::unblock_writes(state);
  EXPECT_EQ(recorder.stop(), RecorderResult::Failed);
  const auto snapshot = recorder.snapshot();
  EXPECT_EQ(snapshot.state, RecordingState::Error);
  EXPECT_EQ(snapshot.written_samples, snapshot.accepted_samples);
}

TEST(RecorderTest, WriteFailureEntersErrorAndNeverPromotesThePartial) {
  auto state = std::make_shared<test::ControlledWriterState>();
  auto storage = std::make_shared<test::ControlledRecorderStorage>(state);
  Recorder recorder(RecorderOptions{}, std::make_shared<FixedRecorderClock>(),
                    storage);
  ASSERT_EQ(recorder.start("write-error.csv", OverwritePolicy::Refuse),
            RecorderResult::Ok);
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->fail_write = true;
  }

  ASSERT_EQ(recorder.submit(sample_at(1U, std::chrono::steady_clock::now())),
            SubmitResult::Accepted);
  EXPECT_EQ(recorder.stop(), RecorderResult::Failed);
  EXPECT_EQ(recorder.snapshot().state, RecordingState::Error);
  std::lock_guard<std::mutex> lock(state->mutex);
  EXPECT_EQ(state->promote_calls, 0U);
}

TEST(RecorderTest, PauseReportsFailureWhenTheRequiredFlushFails) {
  auto state = std::make_shared<test::ControlledWriterState>();
  auto storage = std::make_shared<test::ControlledRecorderStorage>(state);
  Recorder recorder(RecorderOptions{}, std::make_shared<FixedRecorderClock>(),
                    storage);
  ASSERT_EQ(recorder.start("flush-error.csv", OverwritePolicy::Refuse),
            RecorderResult::Ok);
  ASSERT_EQ(recorder.submit(sample_at(1U, std::chrono::steady_clock::now())),
            SubmitResult::Accepted);
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->fail_flush = true;
  }

  EXPECT_EQ(recorder.pause(), RecorderResult::Failed);
  EXPECT_EQ(recorder.snapshot().state, RecordingState::Error);
  EXPECT_EQ(recorder.stop(), RecorderResult::Failed);
}

TEST(RecorderTest,
     PromotionFailureRetainsTheRecoveryPartialAndExistingDestination) {
  TestDirectory directory;
  const auto target = directory.file("existing-directory.csv");
  std::filesystem::create_directory(target);
  const auto partial = std::filesystem::path(target.string() + ".partial");
  Recorder recorder;

  ASSERT_EQ(recorder.start(target, OverwritePolicy::Replace),
            RecorderResult::Ok);
  ASSERT_EQ(recorder.submit(sample_at(5U, std::chrono::steady_clock::now())),
            SubmitResult::Accepted);
  EXPECT_EQ(recorder.stop(), RecorderResult::Failed);
  EXPECT_EQ(recorder.snapshot().state, RecordingState::Error);
  EXPECT_TRUE(std::filesystem::is_directory(target));
  EXPECT_TRUE(std::filesystem::exists(partial));
  EXPECT_GE(std::filesystem::file_size(partial), 1U);
}

TEST(RecorderTest,
     AClosedErrorCanRestartAtANewPathWithoutRemovingRecoveryData) {
  TestDirectory directory;
  const auto failed_target = directory.file("failed.csv");
  std::filesystem::create_directory(failed_target);
  const auto recovery =
      std::filesystem::path(failed_target.string() + ".partial");
  Recorder recorder;

  ASSERT_EQ(recorder.start(failed_target, OverwritePolicy::Replace),
            RecorderResult::Ok);
  ASSERT_EQ(recorder.submit(sample_at(5U, std::chrono::steady_clock::now())),
            SubmitResult::Accepted);
  ASSERT_EQ(recorder.stop(), RecorderResult::Failed);
  ASSERT_EQ(recorder.snapshot().state, RecordingState::Error);
  ASSERT_TRUE(std::filesystem::exists(recovery));

  EXPECT_EQ(recorder.start(failed_target, OverwritePolicy::Replace),
            RecorderResult::PartialExists);
  EXPECT_EQ(recorder.snapshot().state, RecordingState::Error);
  EXPECT_EQ(recorder.snapshot().partial_path, recovery);

  const auto restarted_target = directory.file("restarted.csv");
  ASSERT_EQ(recorder.start(restarted_target, OverwritePolicy::Refuse),
            RecorderResult::Ok);
  ASSERT_EQ(recorder.submit(sample_at(6U, std::chrono::steady_clock::now())),
            SubmitResult::Accepted);
  ASSERT_EQ(recorder.stop(), RecorderResult::Ok);

  EXPECT_TRUE(std::filesystem::exists(recovery));
  EXPECT_TRUE(std::filesystem::exists(restarted_target));
  EXPECT_EQ(recorder.snapshot().state, RecordingState::Idle);
}

TEST(RecorderTest, RefusePromotionDoesNotClobberADestinationCreatedAfterStart) {
  TestDirectory directory;
  const auto target = directory.file();
  const auto partial = std::filesystem::path(target.string() + ".partial");
  Recorder recorder;
  ASSERT_EQ(recorder.start(target, OverwritePolicy::Refuse),
            RecorderResult::Ok);
  ASSERT_EQ(recorder.submit(sample_at(8U, std::chrono::steady_clock::now())),
            SubmitResult::Accepted);
  {
    std::ofstream competitor(target);
    competitor << "competitor-data";
  }

  EXPECT_EQ(recorder.stop(), RecorderResult::Failed);
  EXPECT_EQ(read_lines(target), (std::vector<std::string>{"competitor-data"}));
  EXPECT_TRUE(std::filesystem::exists(partial));
}

TEST(RecorderTest, ThrowingWriterIsContainedAndLeavesTheRecordingInError) {
  auto state = std::make_shared<test::ControlledWriterState>();
  auto storage = std::make_shared<test::ControlledRecorderStorage>(state);
  Recorder recorder(RecorderOptions{}, std::make_shared<FixedRecorderClock>(),
                    storage);
  ASSERT_EQ(recorder.start("throwing-write.csv", OverwritePolicy::Refuse),
            RecorderResult::Ok);
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->throw_write = true;
    state->throw_flush = true;
    state->throw_close = true;
  }

  ASSERT_EQ(recorder.submit(sample_at(1U, std::chrono::steady_clock::now())),
            SubmitResult::Accepted);
  EXPECT_EQ(recorder.stop(), RecorderResult::Failed);
  EXPECT_EQ(recorder.snapshot().state, RecordingState::Error);
  EXPECT_FALSE(recorder.snapshot().last_error.empty());
}

TEST(RecorderTest, ThrowingPromotionIsContainedAndRetainsErrorState) {
  auto state = std::make_shared<test::ControlledWriterState>();
  auto storage = std::make_shared<test::ControlledRecorderStorage>(state);
  Recorder recorder(RecorderOptions{}, std::make_shared<FixedRecorderClock>(),
                    storage);
  ASSERT_EQ(recorder.start("throwing-promotion.csv", OverwritePolicy::Refuse),
            RecorderResult::Ok);
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->throw_promote = true;
  }

  ASSERT_EQ(recorder.submit(sample_at(1U, std::chrono::steady_clock::now())),
            SubmitResult::Accepted);
  EXPECT_EQ(recorder.stop(), RecorderResult::Failed);
  EXPECT_EQ(recorder.snapshot().state, RecordingState::Error);
  EXPECT_FALSE(recorder.snapshot().last_error.empty());
}

TEST(RecorderTest, StopDrainsAllAcceptedRowsBeforeAtomicPromotion) {
  TestDirectory directory;
  const auto target = directory.file();
  Recorder recorder;
  ASSERT_EQ(recorder.start(target, OverwritePolicy::Refuse),
            RecorderResult::Ok);
  for (std::uint32_t sequence = 0; sequence < 2'000U; ++sequence) {
    ASSERT_EQ(
        recorder.submit(sample_at(sequence, std::chrono::steady_clock::now())),
        SubmitResult::Accepted);
  }

  ASSERT_EQ(recorder.stop(), RecorderResult::Ok);
  const auto snapshot = recorder.snapshot();
  EXPECT_EQ(snapshot.accepted_samples, 2'000U);
  EXPECT_EQ(snapshot.written_samples, 2'000U);
  const auto lines = read_lines(target);
  ASSERT_EQ(lines.size(), 2'001U);
  for (std::uint32_t sequence = 0; sequence < 2'000U; ++sequence) {
    const auto fields =
        split_csv_row(lines[static_cast<std::size_t>(sequence) + 1U]);
    ASSERT_EQ(fields.size(), 20U);
    EXPECT_EQ(fields[2], std::to_string(sequence));
  }
}

} // namespace
} // namespace netft_viewer
