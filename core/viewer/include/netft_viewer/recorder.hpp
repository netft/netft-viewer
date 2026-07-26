#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>

#include "netft/types.hpp"
#include "netft_viewer/detail/submission_gate.hpp"
#include "netft_viewer/recorded_sample.hpp"
#include "netft_viewer/recording_queue.hpp"

namespace netft_viewer {

enum class RecordingState {
  Idle,
  Starting,
  Recording,
  Pausing,
  Paused,
  Stopping,
  Error
};
enum class SubmitResult { Accepted, Idle, Paused, Overflow, Failed };
enum class RecorderResult {
  Ok,
  InvalidState,
  DestinationExists,
  PartialExists,
  Failed
};
enum class OverwritePolicy { Refuse, Replace };

struct RecorderOptions {
  std::chrono::milliseconds flush_interval{std::chrono::seconds{1}};
};

struct RecorderSnapshot {
  RecordingState state{RecordingState::Idle};
  std::filesystem::path partial_path;
  std::uint64_t accepted_samples{};
  std::uint64_t written_samples{};
  std::uint64_t bytes_written{};
  std::size_t queue_size{};
  std::size_t queue_capacity{};
  std::string last_error;
};

class RecorderClock {
public:
  virtual ~RecorderClock() = default;
  virtual std::chrono::steady_clock::time_point steady_now() const noexcept = 0;
  virtual std::chrono::system_clock::time_point system_now() const noexcept = 0;
};

class RecorderFile {
public:
  virtual ~RecorderFile() = default;
  virtual bool write(std::string_view bytes, std::string &error) = 0;
  virtual bool flush(std::string &error) = 0;
  virtual bool close(std::string &error) = 0;
  virtual std::uint64_t bytes_written() const noexcept = 0;
};

class RecorderStorage {
public:
  virtual ~RecorderStorage() = default;
  virtual std::unique_ptr<RecorderFile>
  create_exclusive(const std::filesystem::path &partial_path,
                   std::string &error) = 0;
  virtual bool promote(const std::filesystem::path &partial_path,
                       const std::filesystem::path &final_path,
                       OverwritePolicy overwrite, std::string &error) = 0;
};

class Recorder {
public:
  static constexpr std::size_t recording_queue_capacity = 65'536;

  explicit Recorder(RecorderOptions options = {},
                    std::shared_ptr<RecorderClock> clock = {},
                    std::shared_ptr<RecorderStorage> storage = {});
  ~Recorder();

  Recorder(const Recorder &) = delete;
  Recorder &operator=(const Recorder &) = delete;

  RecorderResult start(const std::filesystem::path &target,
                       OverwritePolicy overwrite);
  SubmitResult submit(const netft::Sample &sample) noexcept;
  RecorderResult pause();
  RecorderResult resume();
  RecorderResult stop();
  RecorderSnapshot snapshot() const;

private:
  enum class FailureCode { None, QueueOverflow };

  SubmitResult closed_gate_result() const noexcept;
  void writer_loop() noexcept;
  void writer_loop_impl();
  void publish_writer_done();
  bool write_available_batch();
  bool flush_file();
  bool close_file();
  bool promote_file();
  void enter_error(std::string_view error) noexcept;
  void enter_overflow_error() noexcept;
  void finish_error_file() noexcept;
  bool drain_complete() const noexcept;

  RecorderOptions options_;
  std::shared_ptr<RecorderClock> clock_;
  std::shared_ptr<RecorderStorage> storage_;
  RecordingQueue<RecordedSample, recording_queue_capacity> queue_;
  detail::SubmissionGate submission_gate_;

  std::atomic<RecordingState> state_{RecordingState::Idle};
  std::atomic<std::uint64_t> accepted_samples_{0};
  std::atomic<std::uint64_t> written_samples_{0};
  std::atomic<std::uint64_t> bytes_written_{0};
  std::atomic<FailureCode> failure_code_{FailureCode::None};

  mutable std::mutex operation_mutex_;
  mutable std::mutex metadata_mutex_;
  std::mutex wait_mutex_;
  bool writer_done_{true};
  std::condition_variable writer_condition_;
  std::condition_variable control_condition_;
  std::thread writer_thread_;
  std::unique_ptr<RecorderFile> file_;
  std::filesystem::path final_path_;
  std::filesystem::path partial_path_;
  OverwritePolicy overwrite_{OverwritePolicy::Refuse};
  std::string last_error_;
  std::chrono::steady_clock::time_point recording_steady_origin_;
  std::chrono::system_clock::time_point recording_system_origin_;
};

} // namespace netft_viewer
