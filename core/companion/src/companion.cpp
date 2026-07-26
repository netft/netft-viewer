#include "netft_viewer_companion/companion.hpp"

#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <istream>
#include <memory>
#include <mutex>
#include <optional>
#include <ostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#endif

#include "netft_viewer/session.hpp"
#include "netft_viewer_companion/messages.hpp"
#include "netft_viewer_companion/protocol.hpp"

namespace netft_viewer::companion {
namespace {

constexpr auto writer_poll_interval = std::chrono::milliseconds{5};

std::int64_t monotonic_now_ns() noexcept {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

class OutputWriter {
public:
  OutputWriter(SessionEventSink &sink, std::ostream &events,
               std::function<void()> failure_notify)
      : sink_(sink), events_(events),
        failure_notify_(std::move(failure_notify)),
        thread_(&OutputWriter::run, this) {}

  ~OutputWriter() {
    sink_.close();
    close();
    join();
  }

  OutputWriter(const OutputWriter &) = delete;
  OutputWriter &operator=(const OutputWriter &) = delete;

  bool submit(SerializedEvent frame) {
    std::unique_lock<std::mutex> lock(mutex_);
    condition_.wait(lock, [&] { return !pending_ || failed_ || closing_; });
    if (failed_ || closing_) {
      return false;
    }
    const auto ticket = ++next_ticket_;
    pending_.emplace(Pending{std::move(frame), ticket});
    condition_.notify_all();
    condition_.wait(lock, [&] {
      return completed_ticket_ >= ticket || failed_ || closing_;
    });
    return completed_ticket_ >= ticket && !failed_;
  }

  void close() noexcept {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      closing_ = true;
    }
    condition_.notify_all();
  }

  void join() noexcept {
    if (thread_.joinable()) {
      thread_.join();
    }
  }

  [[nodiscard]] bool failed() const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    return failed_;
  }

private:
  struct Pending {
    SerializedEvent frame;
    std::uint64_t ticket{};
  };

  bool commit(SerializedEvent &frame) {
    if (!frame.valid_for_delivery()) {
      return true;
    }
    events_ << frame.json_line() << '\n';
    events_.flush();
    return static_cast<bool>(events_);
  }

  bool write_response() {
    std::optional<Pending> pending;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!pending_) {
        return true;
      }
      pending.emplace(std::move(*pending_));
      pending_.reset();
    }
    const auto success = commit(pending->frame);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (success) {
        completed_ticket_ = pending->ticket;
      }
    }
    if (success) {
      condition_.notify_all();
    } else {
      fail();
    }
    return success;
  }

  void run() noexcept {
    for (;;) {
      if (!write_response()) {
        return;
      }

      const auto read = sink_.wait_for_event(writer_poll_interval);
      if (read.status == SessionEventReadStatus::Event && read.event) {
        std::optional<RecorderSnapshot> recording_progress;
        if (const auto *recording =
                std::get_if<RecorderSnapshot>(&read.event->payload)) {
          recording_progress = *recording;
        }
        auto frame = serialize_event(
            SessionEventMessage{monotonic_now_ns(), std::move(*read.event)});
        if (frame && !commit(*frame)) {
          fail();
          return;
        }
        if (recording_progress) {
          auto progress = serialize_event(RecordingProgressEvent{
              monotonic_now_ns(), std::move(*recording_progress)});
          if (progress && !commit(*progress)) {
            fail();
            return;
          }
        }
      }

      std::lock_guard<std::mutex> lock(mutex_);
      if (closing_ && !pending_ &&
          read.status == SessionEventReadStatus::Closed) {
        return;
      }
    }
  }

  void fail() noexcept {
    bool notify = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!failed_) {
        failed_ = true;
        notify = true;
      }
    }
    condition_.notify_all();
    if (notify) {
      failure_notify_();
    }
  }

  SessionEventSink &sink_;
  std::ostream &events_;
  std::function<void()> failure_notify_;
  mutable std::mutex mutex_;
  std::condition_variable condition_;
  std::optional<Pending> pending_;
  std::uint64_t next_ticket_{};
  std::uint64_t completed_ticket_{};
  bool closing_{};
  bool failed_{};
  std::thread thread_;
};

enum class InputStatus { Line, End, Cancelled, Failed };

struct InputResult {
  InputStatus status{InputStatus::Failed};
  std::string value;
  bool oversized{};
};

class LineFramer {
public:
  std::optional<InputResult> push(char character) {
    if (character == '\n') {
      return take();
    }
    if (!oversized_) {
      if (value_.size() < maximum_line_bytes) {
        value_.push_back(character);
      } else {
        value_.clear();
        oversized_ = true;
      }
    }
    return std::nullopt;
  }

  std::optional<InputResult> finish() {
    if (value_.empty() && !oversized_) {
      return std::nullopt;
    }
    return take();
  }

private:
  InputResult take() {
    InputResult result{InputStatus::Line, std::move(value_), oversized_};
    value_.clear();
    oversized_ = false;
    return result;
  }

  std::string value_;
  bool oversized_{};
};

class InputSource {
public:
  virtual ~InputSource() = default;
  virtual InputResult next() = 0;
  virtual void cancel() noexcept = 0;
};

class StreamInputSource final : public InputSource {
public:
  explicit StreamInputSource(std::istream &commands) : commands_(commands) {}

  InputResult next() override {
    char character{};
    while (!cancelled_.load(std::memory_order_acquire) &&
           commands_.get(character)) {
      if (auto line = framer_.push(character)) {
        return std::move(*line);
      }
    }
    if (cancelled_.load(std::memory_order_acquire)) {
      return {InputStatus::Cancelled, {}, false};
    }
    if (auto line = framer_.finish()) {
      return std::move(*line);
    }
    return {
        commands_.eof() ? InputStatus::End : InputStatus::Failed, {}, false};
  }

  void cancel() noexcept override {
    cancelled_.store(true, std::memory_order_release);
  }

private:
  std::istream &commands_;
  LineFramer framer_;
  std::atomic<bool> cancelled_{false};
};

class NativeStdinSource final : public InputSource {
public:
#ifdef _WIN32
  NativeStdinSource() : input_(GetStdHandle(STD_INPUT_HANDLE)) {}
#else
  NativeStdinSource() {
    if (pipe(wake_) != 0) {
      throw std::runtime_error("failed to create stdin cancellation pipe");
    }
    for (const auto descriptor : wake_) {
      const auto flags = fcntl(descriptor, F_GETFL, 0);
      const auto descriptor_flags = fcntl(descriptor, F_GETFD, 0);
      if (flags < 0 || descriptor_flags < 0 ||
          fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) < 0 ||
          fcntl(descriptor, F_SETFD, descriptor_flags | FD_CLOEXEC) < 0) {
        close(wake_[0]);
        close(wake_[1]);
        throw std::runtime_error("failed to configure stdin cancellation pipe");
      }
    }
  }

  ~NativeStdinSource() override {
    close(wake_[0]);
    close(wake_[1]);
  }
#endif

  InputResult next() override {
    for (;;) {
      if (cancelled_.load(std::memory_order_acquire)) {
        return {InputStatus::Cancelled, {}, false};
      }
      while (offset_ < buffered_) {
        if (auto line = framer_.push(buffer_[offset_++])) {
          return std::move(*line);
        }
      }
      if (eof_) {
        if (auto line = framer_.finish()) {
          return std::move(*line);
        }
        return {InputStatus::End, {}, false};
      }
      const auto status = fill();
      if (status != InputStatus::Line) {
        return {status, {}, false};
      }
    }
  }

  void cancel() noexcept override {
    if (cancelled_.exchange(true, std::memory_order_acq_rel)) {
      return;
    }
#ifdef _WIN32
    condition_.notify_all();
#else
    constexpr char wake = 1;
    const auto ignored = write(wake_[1], &wake, sizeof(wake));
    static_cast<void>(ignored);
#endif
  }

private:
  InputStatus fill() noexcept {
    offset_ = 0;
    buffered_ = 0;
#ifdef _WIN32
    if (input_ == nullptr || input_ == INVALID_HANDLE_VALUE) {
      return InputStatus::Failed;
    }
    const auto type = GetFileType(input_);
    if (type == FILE_TYPE_PIPE) {
      DWORD available{};
      if (!PeekNamedPipe(input_, nullptr, 0, nullptr, &available, nullptr)) {
        const auto error = GetLastError();
        if (error == ERROR_BROKEN_PIPE) {
          eof_ = true;
          return InputStatus::Line;
        }
        return InputStatus::Failed;
      }
      if (available == 0) {
        std::unique_lock<std::mutex> lock(wait_mutex_);
        condition_.wait_for(lock, writer_poll_interval, [&] {
          return cancelled_.load(std::memory_order_acquire);
        });
        return cancelled_.load(std::memory_order_acquire)
                   ? InputStatus::Cancelled
                   : InputStatus::Line;
      }
    } else if (type == FILE_TYPE_CHAR) {
      const auto wait = WaitForSingleObject(
          input_, static_cast<DWORD>(writer_poll_interval.count()));
      if (wait == WAIT_TIMEOUT) {
        return cancelled_.load(std::memory_order_acquire)
                   ? InputStatus::Cancelled
                   : InputStatus::Line;
      }
      if (wait != WAIT_OBJECT_0) {
        return InputStatus::Failed;
      }
    }

    DWORD read{};
    if (!ReadFile(input_, buffer_.data(), static_cast<DWORD>(buffer_.size()),
                  &read, nullptr)) {
      const auto error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF) {
        eof_ = true;
        return InputStatus::Line;
      }
      return InputStatus::Failed;
    }
    if (read == 0) {
      eof_ = true;
    } else {
      buffered_ = static_cast<std::size_t>(read);
    }
    return InputStatus::Line;
#else
    pollfd descriptors[2] = {
        {STDIN_FILENO, POLLIN, 0},
        {wake_[0], POLLIN, 0},
    };
    int poll_result{};
    do {
      poll_result = poll(descriptors, 2, -1);
    } while (poll_result < 0 && errno == EINTR);
    if (poll_result < 0) {
      return InputStatus::Failed;
    }
    if ((descriptors[1].revents & POLLIN) != 0 ||
        cancelled_.load(std::memory_order_acquire)) {
      return InputStatus::Cancelled;
    }
    if ((descriptors[0].revents & (POLLIN | POLLHUP)) != 0) {
      ssize_t read_count{};
      do {
        read_count = read(STDIN_FILENO, buffer_.data(), buffer_.size());
      } while (read_count < 0 && errno == EINTR);
      if (read_count > 0) {
        buffered_ = static_cast<std::size_t>(read_count);
        return InputStatus::Line;
      }
      if (read_count == 0) {
        eof_ = true;
        return InputStatus::Line;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        return InputStatus::Line;
      }
      return InputStatus::Failed;
    }
    return (descriptors[0].revents & (POLLERR | POLLNVAL)) != 0
               ? InputStatus::Failed
               : InputStatus::Line;
#endif
  }

  LineFramer framer_;
  std::array<char, 4096> buffer_{};
  std::size_t offset_{};
  std::size_t buffered_{};
  bool eof_{};
  std::atomic<bool> cancelled_{false};
#ifdef _WIN32
  HANDLE input_;
  std::mutex wait_mutex_;
  std::condition_variable condition_;
#else
  int wake_[2]{-1, -1};
#endif
};

} // namespace

class Companion::Impl {
public:
  explicit Impl(CompanionOptions options) : options_(options) {}

  int run(std::istream &commands, std::ostream &events, std::ostream &logs) {
    StreamInputSource source(commands);
    return run(source, events, logs);
  }

  int run_standard_io(std::ostream &events, std::ostream &logs) {
    NativeStdinSource source;
    return run(source, events, logs);
  }

private:
  int run(InputSource &source, std::ostream &events, std::ostream &logs) {
    SessionEventSink sink;
    auto session = std::make_unique<ViewerSession>(sink);
    OutputWriter writer(sink, events, [&] { source.cancel(); });
    int result = 0;

    for (;;) {
      auto input = source.next();
      if (input.status != InputStatus::Line) {
        if (writer.failed() || input.status == InputStatus::Cancelled) {
          result = writer.failed() ? 3 : result;
        } else if (input.status == InputStatus::Failed) {
          logs << "companion command input failed\n";
          result = 2;
        }
        break;
      }
      try {
        if (input.oversized) {
          throw ProtocolError("protocol line exceeds byte limit");
        }
        auto parsed = parse_command(input.value);
        if (const auto *shutdown = std::get_if<ShutdownCommand>(&parsed)) {
          source.cancel();
          auto session_result = SessionResult::Failed;
          try {
            session_result = session->disconnect();
          } catch (...) {
            logs << "command processing failed\n";
          }
          session.reset();
          sink.close();
          auto response =
              command_result(shutdown->header, "shutdown", session_result);
          if (!response || !writer.submit(std::move(*response))) {
            logs << "companion event output failed\n";
            result = 3;
          }
          writer.close();
          writer.join();
          return writer.failed() ? 3 : result;
        }
        std::optional<SerializedEvent> response;
        try {
          response = dispatch(parsed, *session);
        } catch (...) {
          logs << "command processing failed\n";
          response =
              command_result(command_header(parsed), command_name(parsed),
                             SessionResult::Failed);
        }
        if (!response || !writer.submit(std::move(*response))) {
          logs << "companion event output failed\n";
          result = 3;
          break;
        }
      } catch (const ProtocolError &) {
        const auto context = input.oversized
                                 ? std::nullopt
                                 : recover_request_context(input.value);
        std::optional<SerializedEvent> response;
        if (context && context->command_type) {
          response = serialize_event(CommandResultEvent{
              context->request_id, monotonic_now_ns(), *context->command_type,
              false, "invalid_command",
              "Command does not satisfy protocol requirements"});
        } else {
          response = serialize_event(RequestErrorEvent{
              context ? std::optional<std::string>{context->request_id}
                      : std::nullopt,
              monotonic_now_ns(), "invalid_command",
              "Command does not satisfy protocol requirements",
              ++protocol_error_sequence_});
        }
        if (!response || !writer.submit(std::move(*response))) {
          logs << "companion event output failed\n";
          result = 3;
          break;
        }
        logs << "protocol command rejected\n";
      } catch (const std::exception &) {
        logs << "command processing failed\n";
        result = 2;
        break;
      }
      logs.flush();
    }

    source.cancel();
    session.reset();
    sink.close();
    writer.close();
    writer.join();
    if (writer.failed()) {
      return 3;
    }
    return result;
  }

  static std::string_view command_name(const Command &command) {
    return std::visit(
        [](const auto &value) -> std::string_view {
          using Value = std::decay_t<decltype(value)>;
          if constexpr (std::is_same_v<Value, ConnectCommand>) {
            return "connect";
          } else if constexpr (std::is_same_v<Value, DisconnectCommand>) {
            return "disconnect";
          } else if constexpr (std::is_same_v<Value, SetPausedCommand>) {
            return "set_paused";
          } else if constexpr (std::is_same_v<Value, BiasCommand>) {
            return "bias";
          } else if constexpr (std::is_same_v<Value, StartRecordingCommand>) {
            return "start_recording";
          } else if constexpr (std::is_same_v<Value, StopRecordingCommand>) {
            return "stop_recording";
          } else if constexpr (std::is_same_v<Value, ShutdownCommand>) {
            return "shutdown";
          }
          return "hello";
        },
        command);
  }

  static const CommandHeader &command_header(const Command &command) {
    return std::visit(
        [](const auto &value) -> const CommandHeader & { return value.header; },
        command);
  }

  static std::optional<SerializedEvent>
  command_result(const CommandHeader &header, std::string_view type,
                 SessionResult result) {
    const auto success = result == SessionResult::Ok;
    std::string code;
    std::string message;
    if (!success) {
      code = result == SessionResult::InvalidState ? "invalid_state"
                                                   : "operation_failed";
      message = result == SessionResult::InvalidState
                    ? "Command is not valid in the current session state"
                    : "Command could not be completed";
    }
    return serialize_event(CommandResultEvent{
        header.request_id, monotonic_now_ns(), std::string{type}, success,
        std::move(code), std::move(message)});
  }

  std::optional<SerializedEvent> dispatch(const Command &command,
                                          ViewerSession &session) const {
    if (const auto *hello = std::get_if<HelloCommand>(&command)) {
      return serialize_event(
          HelloEvent{hello->header.request_id, monotonic_now_ns(),
                     NETFT_VIEWER_APP_VERSION, NETFT_VIEWER_CORE_SNAPSHOT});
    }

    auto result = std::visit(
        [&](const auto &value) -> SessionResult {
          using Value = std::decay_t<decltype(value)>;
          if constexpr (std::is_same_v<Value, ConnectCommand>) {
            netft::Config config;
            config.sensor_host = value.sensor_host;
            config.rdt_port = options_.rdt_port;
            config.http_port = options_.http_port;
            return session.connect(std::move(config));
          } else if constexpr (std::is_same_v<Value, DisconnectCommand>) {
            return session.disconnect();
          } else if constexpr (std::is_same_v<Value, SetPausedCommand>) {
            return session.set_paused(value.paused);
          } else if constexpr (std::is_same_v<Value, BiasCommand>) {
            return session.bias();
          } else if constexpr (std::is_same_v<Value, StartRecordingCommand>) {
            return session.start_recording(value.target_path, value.overwrite);
          } else if constexpr (std::is_same_v<Value, StopRecordingCommand>) {
            return session.stop_recording();
          }
          return SessionResult::Failed;
        },
        command);
    return command_result(command_header(command), command_name(command),
                          result);
  }

  CompanionOptions options_;
  std::uint64_t protocol_error_sequence_{};
};

Companion::Companion(CompanionOptions options)
    : impl_(std::make_unique<Impl>(options)) {}

Companion::~Companion() = default;

int Companion::run(std::istream &commands, std::ostream &events,
                   std::ostream &logs) {
  return impl_->run(commands, events, logs);
}

int Companion::run_standard_io(std::ostream &events, std::ostream &logs) {
  return impl_->run_standard_io(events, logs);
}

} // namespace netft_viewer::companion
