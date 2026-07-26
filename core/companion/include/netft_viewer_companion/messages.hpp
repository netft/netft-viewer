#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <variant>

#include "netft_viewer/session.hpp"

namespace netft_viewer::companion {

struct CommandHeader {
  std::string request_id;
  std::int64_t monotonic_ns{};
  std::uint32_t peer_minor{};
};

struct HelloCommand {
  CommandHeader header;
};
struct ConnectCommand {
  CommandHeader header;
  std::string sensor_host;
};
struct DisconnectCommand {
  CommandHeader header;
};
struct SetPausedCommand {
  CommandHeader header;
  bool paused{};
};
struct BiasCommand {
  CommandHeader header;
};
struct StartRecordingCommand {
  CommandHeader header;
  std::filesystem::path target_path;
  bool overwrite{};
};
struct StopRecordingCommand {
  CommandHeader header;
};
struct ShutdownCommand {
  CommandHeader header;
};

using Command =
    std::variant<HelloCommand, ConnectCommand, DisconnectCommand,
                 SetPausedCommand, BiasCommand, StartRecordingCommand,
                 StopRecordingCommand, ShutdownCommand>;

struct HelloEvent {
  std::string request_id;
  std::int64_t monotonic_ns{};
  std::string app_version;
  std::string core_snapshot;
};

struct CommandResultEvent {
  std::string request_id;
  std::int64_t monotonic_ns{};
  std::string command_type;
  bool success{};
  std::string error_code;
  std::string error_message;
};

struct SessionEventMessage {
  std::int64_t monotonic_ns{};
  SessionEvent event;
};

struct RecordingProgressEvent {
  std::int64_t monotonic_ns{};
  RecorderSnapshot snapshot;
};

using CompanionEvent =
    std::variant<HelloEvent, CommandResultEvent, SessionEventMessage,
                 RecordingProgressEvent>;

} // namespace netft_viewer::companion
