#include "netft_viewer/recorder.hpp"

#include <array>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <system_error>
#include <utility>

#ifdef _WIN32
#include <Windows.h>
#include <fcntl.h>
#include <io.h>
#include <share.h>
#include <sys/stat.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace netft_viewer {
namespace {

constexpr std::size_t writer_batch_size = 512;
constexpr std::string_view csv_header =
    "host_receive_timestamp_ns,elapsed_recording_time_ns,rdt_sequence,ft_"
    "sequence,status,"
    "configuration_revision,raw_fx,raw_fy,raw_fz,raw_tx,raw_ty,raw_tz,force_x,"
    "force_y,"
    "force_z,torque_x,torque_y,torque_z,force_unit,torque_unit\n";

class SystemRecorderClock final : public RecorderClock {
public:
  std::chrono::steady_clock::time_point steady_now() const noexcept override {
    return std::chrono::steady_clock::now();
  }

  std::chrono::system_clock::time_point system_now() const noexcept override {
    return std::chrono::system_clock::now();
  }
};

std::string system_error_text(std::string_view operation) {
  return std::string{operation} + ": " + std::strerror(errno);
}

class NativeRecorderFile final : public RecorderFile {
public:
  explicit NativeRecorderFile(std::FILE *file) : file_(file) {}

  ~NativeRecorderFile() override {
    if (file_ != nullptr) {
      std::fclose(file_);
    }
  }

  bool write(std::string_view bytes, std::string &error) override {
    if (file_ == nullptr) {
      error = "write requested after file close";
      return false;
    }
    const auto written = std::fwrite(bytes.data(), 1U, bytes.size(), file_);
    if (written != bytes.size()) {
      error = system_error_text("CSV write failed");
      return false;
    }
    bytes_written_.fetch_add(static_cast<std::uint64_t>(written),
                             std::memory_order_relaxed);
    return true;
  }

  bool flush(std::string &error) override {
    if (file_ == nullptr) {
      error = "flush requested after file close";
      return false;
    }
    if (std::fflush(file_) != 0) {
      error = system_error_text("CSV flush failed");
      return false;
    }
    return true;
  }

  bool close(std::string &error) override {
    if (file_ == nullptr) {
      return true;
    }
    auto *file = std::exchange(file_, nullptr);
    if (std::fclose(file) != 0) {
      error = system_error_text("CSV close failed");
      return false;
    }
    return true;
  }

  std::uint64_t bytes_written() const noexcept override {
    return bytes_written_.load(std::memory_order_relaxed);
  }

private:
  std::FILE *file_{};
  std::atomic<std::uint64_t> bytes_written_{0};
};

class NativeRecorderStorage final : public RecorderStorage {
public:
  std::unique_ptr<RecorderFile>
  create_exclusive(const std::filesystem::path &partial_path,
                   std::string &error) override {
#ifdef _WIN32
    int descriptor = -1;
    const auto result = _wsopen_s(&descriptor, partial_path.c_str(),
                                  _O_WRONLY | _O_CREAT | _O_EXCL | _O_BINARY,
                                  _SH_DENYRW, _S_IREAD | _S_IWRITE);
    if (result != 0) {
      errno = result;
      error = system_error_text("CSV partial creation failed");
      return nullptr;
    }
    auto *file = _fdopen(descriptor, "wb");
    if (file == nullptr) {
      error = system_error_text("CSV stream creation failed");
      _close(descriptor);
      return nullptr;
    }
#else
    const auto descriptor = ::open(
        partial_path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0666);
    if (descriptor < 0) {
      error = system_error_text("CSV partial creation failed");
      return nullptr;
    }
    auto *file = ::fdopen(descriptor, "wb");
    if (file == nullptr) {
      error = system_error_text("CSV stream creation failed");
      ::close(descriptor);
      return nullptr;
    }
#endif
    return std::make_unique<NativeRecorderFile>(file);
  }

  bool promote(const std::filesystem::path &partial_path,
               const std::filesystem::path &final_path,
               OverwritePolicy overwrite, std::string &error) override {
#ifdef _WIN32
    DWORD flags = MOVEFILE_WRITE_THROUGH;
    if (overwrite == OverwritePolicy::Replace) {
      flags |= MOVEFILE_REPLACE_EXISTING;
    }
    if (MoveFileExW(partial_path.c_str(), final_path.c_str(), flags) == 0) {
      error = "CSV promotion failed with Windows error " +
              std::to_string(static_cast<unsigned long>(GetLastError()));
      return false;
    }
#else
    if (overwrite == OverwritePolicy::Refuse) {
      std::error_code exists_error;
      if (std::filesystem::exists(final_path, exists_error)) {
        error = "CSV destination appeared before promotion";
        return false;
      }
      if (exists_error) {
        error = "CSV destination check failed: " + exists_error.message();
        return false;
      }
    }
    if (::rename(partial_path.c_str(), final_path.c_str()) != 0) {
      error = system_error_text("CSV promotion failed");
      return false;
    }
#endif
    return true;
  }
};

RecordedSample make_recorded_sample(
    const netft::Sample &sample,
    std::chrono::steady_clock::time_point steady_origin,
    std::chrono::system_clock::time_point system_origin) noexcept {
  const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
      sample.received_at - steady_origin);
  const auto host_time = std::chrono::duration_cast<std::chrono::nanoseconds>(
                             system_origin.time_since_epoch()) +
                         elapsed;

  RecordedSample recorded;
  recorded.host_receive_timestamp_ns = host_time.count();
  recorded.elapsed_recording_time_ns = elapsed.count();
  recorded.rdt_sequence = sample.rdt_sequence;
  recorded.ft_sequence = sample.ft_sequence;
  recorded.status = sample.status;
  recorded.configuration_revision = sample.configuration_revision;
  recorded.raw_wrench = sample.raw_wrench;
  recorded.force = sample.force;
  recorded.torque = sample.torque;
  recorded.force_unit = sample.force_unit;
  recorded.torque_unit = sample.torque_unit;
  return recorded;
}

void append_csv_row(std::ostringstream &stream, const RecordedSample &sample) {
  stream << sample.host_receive_timestamp_ns << ','
         << sample.elapsed_recording_time_ns << ',' << sample.rdt_sequence
         << ',' << sample.ft_sequence << ',' << sample.status << ','
         << sample.configuration_revision;
  for (const auto value : sample.raw_wrench) {
    stream << ',' << value;
  }
  for (const auto value : sample.force) {
    stream << ',' << value;
  }
  for (const auto value : sample.torque) {
    stream << ',' << value;
  }
  stream << ',' << netft::to_string(sample.force_unit) << ','
         << netft::to_string(sample.torque_unit) << '\n';
}

} // namespace

Recorder::Recorder(RecorderOptions options,
                   std::shared_ptr<RecorderClock> clock,
                   std::shared_ptr<RecorderStorage> storage)
    : options_(options),
      clock_(clock ? std::move(clock)
                   : std::make_shared<SystemRecorderClock>()),
      storage_(storage ? std::move(storage)
                       : std::make_shared<NativeRecorderStorage>()) {
  if (options_.flush_interval <= std::chrono::milliseconds::zero()) {
    throw std::invalid_argument("recorder flush interval must be positive");
  }
}

Recorder::~Recorder() {
  const auto current = state_.load(std::memory_order_acquire);
  if (current != RecordingState::Idle || writer_thread_.joinable()) {
    stop();
  }
}

RecorderResult Recorder::start(const std::filesystem::path &target,
                               OverwritePolicy overwrite) {
  std::lock_guard<std::mutex> operation_lock(operation_mutex_);
  if (state_.load(std::memory_order_acquire) != RecordingState::Idle ||
      writer_thread_.joinable()) {
    return RecorderResult::InvalidState;
  }
  if (target.empty()) {
    return RecorderResult::Failed;
  }

  auto partial = target;
  partial += ".partial";
  std::error_code filesystem_error;
  if (std::filesystem::exists(partial, filesystem_error)) {
    return RecorderResult::PartialExists;
  }
  if (filesystem_error) {
    return RecorderResult::Failed;
  }
  if (overwrite == OverwritePolicy::Refuse &&
      std::filesystem::exists(target, filesystem_error)) {
    return RecorderResult::DestinationExists;
  }
  if (filesystem_error) {
    return RecorderResult::Failed;
  }

  state_.store(RecordingState::Starting, std::memory_order_release);
  accepted_samples_.store(0, std::memory_order_relaxed);
  written_samples_.store(0, std::memory_order_relaxed);
  bytes_written_.store(0, std::memory_order_relaxed);
  writer_done_.store(false, std::memory_order_release);
  {
    std::lock_guard<std::mutex> metadata_lock(metadata_mutex_);
    final_path_ = target;
    partial_path_ = partial;
    overwrite_ = overwrite;
    last_error_.clear();
  }

  std::string error;
  file_ = storage_->create_exclusive(partial, error);
  if (!file_) {
    state_.store(RecordingState::Idle, std::memory_order_release);
    writer_done_.store(true, std::memory_order_release);
    std::lock_guard<std::mutex> metadata_lock(metadata_mutex_);
    last_error_ = std::move(error);
    std::error_code ignored;
    if (std::filesystem::exists(partial, ignored)) {
      return RecorderResult::PartialExists;
    }
    return RecorderResult::Failed;
  }
  if (!file_->write(csv_header, error) || !file_->flush(error)) {
    std::string close_error;
    file_->close(close_error);
    bytes_written_.store(file_->bytes_written(), std::memory_order_relaxed);
    file_.reset();
    enter_error(error);
    writer_done_.store(true, std::memory_order_release);
    return RecorderResult::Failed;
  }

  recording_steady_origin_ = clock_->steady_now();
  recording_system_origin_ = clock_->system_now();
  bytes_written_.store(file_->bytes_written(), std::memory_order_relaxed);
  state_.store(RecordingState::Recording, std::memory_order_release);
  accepting_.store(true, std::memory_order_release);
  try {
    writer_thread_ = std::thread(&Recorder::writer_loop, this);
  } catch (const std::exception &exception) {
    accepting_.store(false, std::memory_order_release);
    enter_error(std::string{"CSV writer thread creation failed: "} +
                exception.what());
    finish_error_file();
    writer_done_.store(true, std::memory_order_release);
    return RecorderResult::Failed;
  }
  return RecorderResult::Ok;
}

SubmitResult Recorder::submit(const netft::Sample &sample) noexcept {
  if (!accepting_.load(std::memory_order_acquire)) {
    return closed_gate_result();
  }

  in_flight_submissions_.fetch_add(1, std::memory_order_acq_rel);
  if (!accepting_.load(std::memory_order_acquire)) {
    finish_submit();
    return closed_gate_result();
  }

  const auto recorded = make_recorded_sample(sample, recording_steady_origin_,
                                             recording_system_origin_);
  if (!queue_.try_push(recorded)) {
    accepting_.store(false, std::memory_order_release);
    enter_error("recording queue overflow");
    finish_submit();
    writer_condition_.notify_one();
    return SubmitResult::Overflow;
  }

  accepted_samples_.fetch_add(1, std::memory_order_relaxed);
  finish_submit();
  writer_condition_.notify_one();
  return SubmitResult::Accepted;
}

RecorderResult Recorder::pause() {
  std::lock_guard<std::mutex> operation_lock(operation_mutex_);
  if (state_.load(std::memory_order_acquire) != RecordingState::Recording) {
    return RecorderResult::InvalidState;
  }

  accepting_.store(false, std::memory_order_release);
  state_.store(RecordingState::Pausing, std::memory_order_release);
  {
    std::unique_lock<std::mutex> wait_lock(wait_mutex_);
    control_condition_.wait(wait_lock, [&] {
      return in_flight_submissions_.load(std::memory_order_acquire) == 0U;
    });
  }
  writer_condition_.notify_one();
  {
    std::unique_lock<std::mutex> wait_lock(wait_mutex_);
    control_condition_.wait(wait_lock, [&] {
      const auto current = state_.load(std::memory_order_acquire);
      return current == RecordingState::Paused ||
             current == RecordingState::Error;
    });
  }
  return state_.load(std::memory_order_acquire) == RecordingState::Paused
             ? RecorderResult::Ok
             : RecorderResult::Failed;
}

RecorderResult Recorder::resume() {
  std::lock_guard<std::mutex> operation_lock(operation_mutex_);
  if (state_.load(std::memory_order_acquire) != RecordingState::Paused) {
    return RecorderResult::InvalidState;
  }
  state_.store(RecordingState::Recording, std::memory_order_release);
  accepting_.store(true, std::memory_order_release);
  writer_condition_.notify_one();
  return RecorderResult::Ok;
}

RecorderResult Recorder::stop() {
  std::lock_guard<std::mutex> operation_lock(operation_mutex_);
  auto current = state_.load(std::memory_order_acquire);
  if (current == RecordingState::Idle && !writer_thread_.joinable()) {
    return RecorderResult::InvalidState;
  }

  accepting_.store(false, std::memory_order_release);
  if (current != RecordingState::Error) {
    state_.store(RecordingState::Stopping, std::memory_order_release);
  }
  {
    std::unique_lock<std::mutex> wait_lock(wait_mutex_);
    control_condition_.wait(wait_lock, [&] {
      return in_flight_submissions_.load(std::memory_order_acquire) == 0U;
    });
  }
  writer_condition_.notify_one();
  {
    std::unique_lock<std::mutex> wait_lock(wait_mutex_);
    control_condition_.wait(wait_lock, [&] {
      return writer_done_.load(std::memory_order_acquire);
    });
  }
  if (writer_thread_.joinable()) {
    writer_thread_.join();
  }
  current = state_.load(std::memory_order_acquire);
  return current == RecordingState::Idle ? RecorderResult::Ok
                                         : RecorderResult::Failed;
}

RecorderSnapshot Recorder::snapshot() const {
  RecorderSnapshot result;
  result.state = state_.load(std::memory_order_acquire);
  result.accepted_samples = accepted_samples_.load(std::memory_order_relaxed);
  result.written_samples = written_samples_.load(std::memory_order_relaxed);
  result.bytes_written = bytes_written_.load(std::memory_order_relaxed);
  result.queue_size = queue_.size();
  result.queue_capacity = queue_.capacity();
  {
    std::lock_guard<std::mutex> metadata_lock(metadata_mutex_);
    result.partial_path = partial_path_;
    result.last_error = last_error_;
  }
  return result;
}

SubmitResult Recorder::closed_gate_result() const noexcept {
  switch (state_.load(std::memory_order_acquire)) {
  case RecordingState::Pausing:
  case RecordingState::Paused:
    return SubmitResult::Paused;
  case RecordingState::Error:
    return SubmitResult::Failed;
  case RecordingState::Idle:
  case RecordingState::Starting:
  case RecordingState::Stopping:
    return SubmitResult::Idle;
  case RecordingState::Recording:
    return SubmitResult::Failed;
  }
  return SubmitResult::Failed;
}

void Recorder::finish_submit() noexcept {
  if (in_flight_submissions_.fetch_sub(1, std::memory_order_acq_rel) == 1U) {
    control_condition_.notify_all();
    writer_condition_.notify_one();
  }
}

void Recorder::writer_loop() {
  auto next_flush = std::chrono::steady_clock::now() + options_.flush_interval;
  for (;;) {
    if (!write_available_batch()) {
      finish_error_file();
      break;
    }

    const auto current = state_.load(std::memory_order_acquire);
    if (current == RecordingState::Pausing && drain_complete()) {
      if (!flush_file()) {
        finish_error_file();
        break;
      }
      state_.store(RecordingState::Paused, std::memory_order_release);
      control_condition_.notify_all();
      next_flush = std::chrono::steady_clock::now() + options_.flush_interval;
      continue;
    }
    if (current == RecordingState::Stopping && drain_complete()) {
      if (flush_file() && close_file() && promote_file()) {
        state_.store(RecordingState::Idle, std::memory_order_release);
        std::lock_guard<std::mutex> metadata_lock(metadata_mutex_);
        partial_path_.clear();
      } else {
        finish_error_file();
      }
      break;
    }
    if (current == RecordingState::Error && drain_complete()) {
      finish_error_file();
      break;
    }

    const auto now = std::chrono::steady_clock::now();
    if (now >= next_flush) {
      if (!flush_file()) {
        finish_error_file();
        break;
      }
      next_flush = now + options_.flush_interval;
    }

    std::unique_lock<std::mutex> wait_lock(wait_mutex_);
    if (state_.load(std::memory_order_acquire) == RecordingState::Paused) {
      writer_condition_.wait(wait_lock, [&] {
        return state_.load(std::memory_order_acquire) != RecordingState::Paused;
      });
    } else {
      writer_condition_.wait_until(wait_lock, next_flush, [&] {
        const auto state = state_.load(std::memory_order_acquire);
        return queue_.size() != 0U || state == RecordingState::Pausing ||
               state == RecordingState::Stopping ||
               state == RecordingState::Error;
      });
    }
  }
  writer_done_.store(true, std::memory_order_release);
  control_condition_.notify_all();
}

bool Recorder::write_available_batch() {
  std::array<RecordedSample, writer_batch_size> batch{};
  std::size_t count{};
  while (count < batch.size() && queue_.try_pop(batch[count])) {
    ++count;
  }
  if (count == 0U) {
    return true;
  }

  std::ostringstream stream;
  stream.imbue(std::locale::classic());
  stream << std::setprecision(std::numeric_limits<double>::max_digits10);
  for (std::size_t index = 0; index < count; ++index) {
    append_csv_row(stream, batch[index]);
  }
  const auto text = stream.str();
  std::string error;
  if (!file_->write(text, error)) {
    enter_error(error);
    return false;
  }
  written_samples_.fetch_add(static_cast<std::uint64_t>(count),
                             std::memory_order_relaxed);
  bytes_written_.store(file_->bytes_written(), std::memory_order_relaxed);
  return true;
}

bool Recorder::flush_file() {
  std::string error;
  if (!file_ || !file_->flush(error)) {
    enter_error(error.empty() ? std::string_view{"CSV flush failed"}
                              : std::string_view{error});
    return false;
  }
  bytes_written_.store(file_->bytes_written(), std::memory_order_relaxed);
  return true;
}

bool Recorder::close_file() {
  std::string error;
  if (!file_ || !file_->close(error)) {
    enter_error(error.empty() ? std::string_view{"CSV close failed"}
                              : std::string_view{error});
    return false;
  }
  bytes_written_.store(file_->bytes_written(), std::memory_order_relaxed);
  file_.reset();
  return true;
}

bool Recorder::promote_file() {
  std::filesystem::path partial;
  std::filesystem::path final;
  OverwritePolicy overwrite;
  {
    std::lock_guard<std::mutex> metadata_lock(metadata_mutex_);
    partial = partial_path_;
    final = final_path_;
    overwrite = overwrite_;
  }
  std::string error;
  if (!storage_->promote(partial, final, overwrite, error)) {
    enter_error(error.empty() ? std::string_view{"CSV promotion failed"}
                              : std::string_view{error});
    return false;
  }
  return true;
}

void Recorder::enter_error(std::string_view error) noexcept {
  accepting_.store(false, std::memory_order_release);
  try {
    std::lock_guard<std::mutex> metadata_lock(metadata_mutex_);
    if (last_error_.empty()) {
      last_error_.assign(error.data(), error.size());
    }
  } catch (...) {
    // State publication still makes the failure visible if diagnostics cannot
    // allocate.
  }
  state_.store(RecordingState::Error, std::memory_order_release);
  writer_condition_.notify_one();
  control_condition_.notify_all();
}

void Recorder::finish_error_file() noexcept {
  if (!file_) {
    return;
  }
  std::string ignored;
  file_->flush(ignored);
  file_->close(ignored);
  bytes_written_.store(file_->bytes_written(), std::memory_order_relaxed);
  file_.reset();
}

bool Recorder::drain_complete() const noexcept {
  return queue_.size() == 0U &&
         in_flight_submissions_.load(std::memory_order_acquire) == 0U;
}

} // namespace netft_viewer
