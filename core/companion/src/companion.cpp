#include "netft_viewer_companion/companion.hpp"

#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <istream>
#include <memory>
#include <mutex>
#include <optional>
#include <ostream>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>

#ifdef _WIN32
#include <windows.h>
#else
#include <pthread.h>
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
  OutputWriter(SessionEventSink &sink, std::ostream &events)
      : sink_(sink), events_(events), thread_(&OutputWriter::run, this) {}

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
      } else {
        failed_ = true;
      }
    }
    condition_.notify_all();
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
    {
      std::lock_guard<std::mutex> lock(mutex_);
      failed_ = true;
    }
    condition_.notify_all();
  }

  SessionEventSink &sink_;
  std::ostream &events_;
  mutable std::mutex mutex_;
  std::condition_variable condition_;
  std::optional<Pending> pending_;
  std::uint64_t next_ticket_{};
  std::uint64_t completed_ticket_{};
  bool closing_{};
  bool failed_{};
  std::thread thread_;
};

class InputReader {
public:
  struct Line {
    std::string value;
    bool oversized{};
  };

  explicit InputReader(std::istream &commands) : commands_(commands) {
#ifndef _WIN32
    static std::once_flag signal_once;
    std::call_once(signal_once, [] {
      struct sigaction action{};
      action.sa_handler = [](int) {};
      sigemptyset(&action.sa_mask);
      action.sa_flags = 0;
      static_cast<void>(sigaction(SIGUSR1, &action, nullptr));
    });
#endif
    thread_ = std::thread(&InputReader::run, this);
  }

  ~InputReader() {
    stop();
    join();
  }

  InputReader(const InputReader &) = delete;
  InputReader &operator=(const InputReader &) = delete;

  std::optional<Line> next(const OutputWriter &writer) {
    std::unique_lock<std::mutex> lock(mutex_);
    for (;;) {
      if (line_) {
        auto result = std::move(line_);
        line_.reset();
        condition_.notify_all();
        return result;
      }
      if (eof_ || stopping_ || writer.failed()) {
        return std::nullopt;
      }
      condition_.wait_for(lock, writer_poll_interval);
    }
  }

  void stop() noexcept {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_) {
        return;
      }
      stopping_ = true;
    }
    condition_.notify_all();
    interrupt();
  }

  void join() noexcept {
    if (thread_.joinable()) {
      thread_.join();
    }
  }

private:
  void interrupt() noexcept {
    if (!thread_.joinable()) {
      return;
    }
#ifdef _WIN32
    static_cast<void>(CancelSynchronousIo(thread_.native_handle()));
#else
    static_cast<void>(pthread_kill(thread_.native_handle(), SIGUSR1));
#endif
  }

  void publish(Line line) {
    std::unique_lock<std::mutex> lock(mutex_);
    condition_.wait(lock, [&] { return !line_ || stopping_; });
    if (!stopping_) {
      line_.emplace(std::move(line));
    }
    condition_.notify_all();
  }

  void run() noexcept {
    Line line;
    char character{};
    while (!is_stopping() && commands_.get(character)) {
      if (character == '\n') {
        publish(std::move(line));
        line = {};
        continue;
      }
      if (!line.oversized) {
        if (line.value.size() < maximum_line_bytes) {
          line.value.push_back(character);
        } else {
          line.value.clear();
          line.oversized = true;
        }
      }
    }
    if (!is_stopping() && (!line.value.empty() || line.oversized)) {
      publish(std::move(line));
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      eof_ = true;
    }
    condition_.notify_all();
  }

  [[nodiscard]] bool is_stopping() const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    return stopping_;
  }

  std::istream &commands_;
  mutable std::mutex mutex_;
  std::condition_variable condition_;
  std::optional<Line> line_;
  bool stopping_{};
  bool eof_{};
  std::thread thread_;
};

} // namespace

class Companion::Impl {
public:
  explicit Impl(CompanionOptions options) : options_(options) {}

  int run(std::istream &commands, std::ostream &events, std::ostream &logs) {
    SessionEventSink sink;
    auto session = std::make_unique<ViewerSession>(sink);
    OutputWriter writer(sink, events);
    InputReader reader(commands);
    int result = 0;

    for (;;) {
      auto input = reader.next(writer);
      if (!input) {
        if (writer.failed()) {
          result = 3;
        }
        break;
      }
      try {
        if (input->oversized) {
          throw ProtocolError("protocol line exceeds byte limit");
        }
        auto parsed = parse_command(input->value);
        if (const auto *shutdown = std::get_if<ShutdownCommand>(&parsed)) {
          reader.stop();
          reader.join();
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
        const auto context = input->oversized
                                 ? std::nullopt
                                 : recover_request_context(input->value);
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

    reader.stop();
    reader.join();
    session.reset();
    sink.close();
    writer.close();
    writer.join();
    if (writer.failed()) {
      return 3;
    }
    return result;
  }

private:
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

} // namespace netft_viewer::companion
