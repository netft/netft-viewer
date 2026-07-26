#include "netft_viewer_companion/protocol.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <limits>
#include <set>
#include <sstream>
#include <type_traits>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "netft/types.hpp"
#include "netft_viewer/axis.hpp"

namespace netft_viewer::companion {
namespace {

using Json = nlohmann::json;

Json parse_unique_json(std::string_view line) {
  if (line.size() > maximum_line_bytes) {
    throw ProtocolError("protocol line exceeds byte limit");
  }
  if (line.empty() || line.find_first_of("\r\n") != std::string_view::npos) {
    throw ProtocolError("protocol input must contain exactly one JSON line");
  }

  std::vector<std::set<std::string>> object_keys;
  const auto callback = [&object_keys](int depth, Json::parse_event_t event,
                                       Json &parsed) {
    if ((event == Json::parse_event_t::object_start ||
         event == Json::parse_event_t::array_start) &&
        (depth < 0 ||
         static_cast<std::size_t>(depth) >= maximum_json_nesting_depth)) {
      throw ProtocolError("JSON nesting depth exceeds protocol limit");
    }
    if (event == Json::parse_event_t::object_start) {
      object_keys.emplace_back();
    } else if (event == Json::parse_event_t::key) {
      if (object_keys.empty() ||
          !object_keys.back().insert(parsed.get<std::string>()).second) {
        throw ProtocolError("duplicate object key");
      }
    } else if (event == Json::parse_event_t::object_end) {
      object_keys.pop_back();
    }
    return true;
  };
  try {
    return Json::parse(line.begin(), line.end(), callback);
  } catch (const ProtocolError &) {
    throw;
  } catch (const std::exception &error) {
    throw ProtocolError(std::string{"invalid JSON: "} + error.what());
  }
}

const Json &required(const Json &object, std::string_view name) {
  if (!object.is_object()) {
    throw ProtocolError("expected object");
  }
  const auto iterator = object.find(std::string{name});
  if (iterator == object.end()) {
    throw ProtocolError("missing required field");
  }
  return *iterator;
}

std::string required_string(const Json &object, std::string_view name,
                            std::size_t maximum = 4096U) {
  const auto &value = required(object, name);
  if (!value.is_string()) {
    throw ProtocolError("field has wrong scalar type");
  }
  auto result = value.get<std::string>();
  if (result.empty() || result.size() > maximum ||
      result.find('\0') != std::string::npos) {
    throw ProtocolError("string field is outside its allowed range");
  }
  return result;
}

std::uint32_t required_u32(const Json &object, std::string_view name) {
  const auto &value = required(object, name);
  if (!value.is_number_integer()) {
    throw ProtocolError("field has wrong scalar type");
  }
  try {
    const auto result = value.get<std::int64_t>();
    if (result < 0 || static_cast<std::uint64_t>(result) >
                          std::numeric_limits<std::uint32_t>::max()) {
      throw ProtocolError("integer field is outside its allowed range");
    }
    return static_cast<std::uint32_t>(result);
  } catch (const ProtocolError &) {
    throw;
  } catch (const std::exception &) {
    throw ProtocolError("integer field is outside its allowed range");
  }
}

std::int64_t canonical_i64_decimal(const Json &object, std::string_view name) {
  const auto text = required_string(object, name, 19U);
  if ((text.size() > 1U && text.front() == '0') ||
      !std::all_of(text.begin(), text.end(), [](unsigned char character) {
        return std::isdigit(character) != 0;
      })) {
    throw ProtocolError("decimal string is not canonical");
  }
  std::uint64_t result{};
  for (const auto character : text) {
    const auto digit = static_cast<std::uint64_t>(character - '0');
    if (result >
        (static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) -
         digit) /
            10U) {
      throw ProtocolError("decimal string is outside its allowed range");
    }
    result = result * 10U + digit;
  }
  return static_cast<std::int64_t>(result);
}

bool valid_ipv4(std::string_view host) {
  std::size_t start{};
  for (std::size_t part = 0; part < 4U; ++part) {
    const auto end = host.find('.', start);
    const auto token =
        host.substr(start, end == std::string_view::npos ? host.size() - start
                                                         : end - start);
    if (token.empty() || token.size() > 3U ||
        (token.size() > 1U && token.front() == '0') ||
        !std::all_of(token.begin(), token.end(), [](unsigned char character) {
          return std::isdigit(character) != 0;
        })) {
      return false;
    }
    unsigned value{};
    for (const auto character : token) {
      value = value * 10U + static_cast<unsigned>(character - '0');
    }
    if (value > 255U) {
      return false;
    }
    if (part < 3U) {
      if (end == std::string_view::npos) {
        return false;
      }
      start = end + 1U;
    } else if (end != std::string_view::npos) {
      return false;
    }
  }
  return true;
}

bool valid_dns_name(std::string_view host) {
  if (host.empty() || host.size() > 253U || host.front() == '.' ||
      host.back() == '.') {
    return false;
  }
  std::size_t start{};
  while (start < host.size()) {
    const auto end = host.find('.', start);
    const auto label =
        host.substr(start, end == std::string_view::npos ? host.size() - start
                                                         : end - start);
    if (label.empty() || label.size() > 63U || label.front() == '-' ||
        label.back() == '-' ||
        !std::all_of(label.begin(), label.end(), [](unsigned char character) {
          return std::isalnum(character) != 0 || character == '-';
        })) {
      return false;
    }
    if (end == std::string_view::npos) {
      return true;
    }
    start = end + 1U;
  }
  return true;
}

bool valid_sensor_host(std::string_view host) {
  const bool numeric =
      std::all_of(host.begin(), host.end(), [](unsigned char character) {
        return std::isdigit(character) != 0 || character == '.';
      });
  return numeric ? valid_ipv4(host) : valid_dns_name(host);
}

bool valid_request_id(std::string_view request_id) {
  return !request_id.empty() && request_id.size() <= maximum_request_id_bytes &&
         std::all_of(
             request_id.begin(), request_id.end(), [](unsigned char character) {
               const auto ascii_alphanumeric =
                   (character >= '0' && character <= '9') ||
                   (character >= 'A' && character <= 'Z') ||
                   (character >= 'a' && character <= 'z');
               return ascii_alphanumeric || character == '-' ||
                      character == '_' || character == '.' || character == ':';
             });
}

bool valid_non_hello_command(std::string_view type) {
  constexpr std::array<std::string_view, 7> types{
      "connect",         "disconnect",     "set_paused", "bias",
      "start_recording", "stop_recording", "shutdown"};
  return std::find(types.begin(), types.end(), type) != types.end();
}

bool valid_snapshot_id(std::string_view value) {
  return value.size() == 40U &&
         std::all_of(value.begin(), value.end(), [](unsigned char character) {
           return std::isdigit(character) != 0 ||
                  (character >= 'a' && character <= 'f');
         });
}

CommandHeader parse_header(const Json &root) {
  const auto &protocol = required(root, "protocol");
  const auto major = required_u32(protocol, "major");
  if (major != protocol_major) {
    throw ProtocolError("incompatible protocol major");
  }
  const auto minor = required_u32(protocol, "minor");
  auto request_id =
      required_string(root, "requestId", maximum_request_id_bytes);
  if (!valid_request_id(request_id)) {
    throw ProtocolError("request ID contains unsupported characters");
  }
  return {std::move(request_id), canonical_i64_decimal(root, "monotonicNs"),
          minor};
}

std::string decimal(std::uint64_t value) { return std::to_string(value); }

std::string decimal_nonnegative(std::int64_t value) {
  if (value < 0) {
    throw ProtocolError("timestamp must be nonnegative");
  }
  return std::to_string(value);
}

Json envelope(std::string_view type, std::int64_t monotonic_ns, Json payload) {
  return Json{
      {"protocol", {{"major", protocol_major}, {"minor", protocol_minor}}},
      {"type", type},
      {"monotonicNs", decimal_nonnegative(monotonic_ns)},
      {"payload", std::move(payload)}};
}

std::string_view connection_state_name(ConnectionState state) {
  switch (state) {
  case ConnectionState::Disconnected:
    return "disconnected";
  case ConnectionState::Connecting:
    return "connecting";
  case ConnectionState::Streaming:
    return "streaming";
  case ConnectionState::Reconnecting:
    return "reconnecting";
  case ConnectionState::Disconnecting:
    return "disconnecting";
  case ConnectionState::Error:
    return "error";
  }
  return "error";
}

std::string_view recording_state_name(RecordingState state) {
  switch (state) {
  case RecordingState::Idle:
    return "idle";
  case RecordingState::Starting:
    return "starting";
  case RecordingState::Recording:
    return "recording";
  case RecordingState::Pausing:
    return "pausing";
  case RecordingState::Paused:
    return "paused";
  case RecordingState::Stopping:
    return "stopping";
  case RecordingState::Error:
    return "error";
  }
  return "error";
}

std::string_view operation_name(SessionOperation operation) {
  switch (operation) {
  case SessionOperation::Connect:
    return "connect";
  case SessionOperation::Disconnect:
    return "disconnect";
  case SessionOperation::Pause:
    return "pause";
  case SessionOperation::Resume:
    return "resume";
  case SessionOperation::Bias:
    return "bias";
  case SessionOperation::StartRecording:
    return "start_recording";
  case SessionOperation::StopRecording:
    return "stop_recording";
  case SessionOperation::Sensor:
    return "sensor";
  case SessionOperation::Recording:
    return "recording";
  }
  return "sensor";
}

Json configuration_payload(const netft::SensorConfiguration &configuration) {
  netft::validate(configuration.calibration);
  return {
      {"productName", configuration.product_name},
      {"countsPerForceUnit", configuration.calibration.counts_per_force_unit},
      {"countsPerTorqueUnit", configuration.calibration.counts_per_torque_unit},
      {"forceUnit",
       std::string{netft::to_string(configuration.calibration.force_unit)}},
      {"torqueUnit",
       std::string{netft::to_string(configuration.calibration.torque_unit)}},
      {"source", configuration.source == netft::CalibrationSource::Sensor
                     ? "sensor"
                     : "override"},
      {"revision", decimal(configuration.revision)}};
}

Json health_payload(const netft::HealthSnapshot &health) {
  if (!std::isfinite(health.receive_rate_hz) ||
      !std::isfinite(health.delivery_rate_hz) || health.receive_rate_hz < 0.0 ||
      health.delivery_rate_hz < 0.0 || health.rdt_port < 0 ||
      health.rdt_port > 65'535) {
    throw ProtocolError("health payload contains an invalid scalar");
  }
  if (health.last_record_age) {
    const auto seconds = health.last_record_age->count();
    constexpr auto maximum_seconds =
        static_cast<double>(std::numeric_limits<std::int64_t>::max()) /
        1'000'000'000.0;
    if (!std::isfinite(seconds) || seconds < 0.0 || seconds > maximum_seconds) {
      throw ProtocolError("health age is outside its allowed range");
    }
  }
  Json result{
      {"state", netft::to_string(health.state)},
      {"faultCode", netft::to_string(health.fault_code)},
      {"sensorHost", health.sensor_host},
      {"rdtPort", health.rdt_port},
      {"lastRdtSequence", health.last_rdt_sequence
                              ? Json{*health.last_rdt_sequence}
                              : Json{nullptr}},
      {"lastFtSequence", health.last_ft_sequence
                             ? Json{*health.last_ft_sequence}
                             : Json{nullptr}},
      {"lastStatus", health.last_status},
      {"receiveRateHz", health.receive_rate_hz},
      {"deliveryRateHz", health.delivery_rate_hz},
      {"receivedCount", decimal(health.received_count)},
      {"deliveredCount", decimal(health.delivered_count)},
      {"rateLimitedCount", decimal(health.rate_limited_count)},
      {"deviceErrorCount", decimal(health.device_error_count)},
      {"warningCount", decimal(health.warning_count)},
      {"lostCount", decimal(health.lost_count)},
      {"duplicateCount", decimal(health.duplicate_count)},
      {"outOfOrderCount", decimal(health.out_of_order_count)},
      {"malformedCount", decimal(health.malformed_count)},
      {"reconnectCount", decimal(health.reconnect_count)},
      {"timeoutCount", decimal(health.timeout_count)},
      {"callbackErrorCount", decimal(health.callback_error_count)},
      {"ftStallCount", decimal(health.ft_stall_count)},
      {"ftBackwardCount", decimal(health.ft_backward_count)},
      {"ftRestartCount", decimal(health.ft_restart_count)},
      {"calibrationChangeCount", decimal(health.calibration_change_count)},
      {"lastRecordAgeNs", nullptr},
      {"lastError", health.last_error},
      {"lastFtProgress", health.last_ft_progress}};
  if (health.last_record_age) {
    const auto age = std::chrono::duration_cast<std::chrono::nanoseconds>(
        *health.last_record_age);
    result["lastRecordAgeNs"] = decimal_nonnegative(age.count());
  }
  if (health.sensor_configuration) {
    result["sensorConfiguration"] =
        configuration_payload(*health.sensor_configuration);
  }
  return result;
}

bool finite_sample(const TimedSample &timed) {
  return std::all_of(timed.sample.force.begin(), timed.sample.force.end(),
                     [](double value) { return std::isfinite(value); }) &&
         std::all_of(timed.sample.torque.begin(), timed.sample.torque.end(),
                     [](double value) { return std::isfinite(value); });
}

std::optional<Json> session_envelope(const SessionEventMessage &message) {
  const auto &event = message.event;
  return std::visit(
      [&](const auto &payload) -> std::optional<Json> {
        using Payload = std::decay_t<decltype(payload)>;
        if constexpr (std::is_same_v<Payload, ConnectionSnapshot>) {
          return envelope("connection_state", message.monotonic_ns,
                          {{"state", connection_state_name(payload.state)},
                           {"paused", payload.paused},
                           {"generation", decimal(payload.generation)},
                           {"lastError", payload.last_error}});
        } else if constexpr (std::is_same_v<Payload, netft::HealthSnapshot>) {
          return envelope("health", message.monotonic_ns,
                          health_payload(payload));
        } else if constexpr (std::is_same_v<Payload, TimedSample>) {
          if (!event.valid_for_delivery() || !finite_sample(payload)) {
            return std::nullopt;
          }
          return envelope(
              "live_wrench", message.monotonic_ns,
              {{"hostTimeNs", decimal_nonnegative(payload.host_time_ns)},
               {"sampleMonotonicNs",
                decimal_nonnegative(payload.monotonic_time_ns)},
               {"rdtSequence", payload.sample.rdt_sequence},
               {"ftSequence", payload.sample.ft_sequence},
               {"status", payload.sample.status},
               {"raw", payload.sample.raw_wrench},
               {"force", payload.sample.force},
               {"torque", payload.sample.torque},
               {"forceUnit",
                std::string{netft::to_string(payload.sample.force_unit)}},
               {"torqueUnit",
                std::string{netft::to_string(payload.sample.torque_unit)}},
               {"configurationRevision",
                decimal(payload.sample.configuration_revision)}});
        } else if constexpr (std::is_same_v<Payload, PlotBatch>) {
          if (!event.valid_for_delivery()) {
            return std::nullopt;
          }
          Json batches = Json::array();
          for (std::size_t index = 0; index < axes.size(); ++index) {
            const auto &axis_batch = payload.axes[index];
            if (axis_batch.axis != axes[index] ||
                axis_batch.count > axis_batch.points.size()) {
              return std::nullopt;
            }
            Json points = Json::array();
            for (std::size_t point = 0; point < axis_batch.count; ++point) {
              if (!std::isfinite(axis_batch.points[point].value)) {
                return std::nullopt;
              }
              points.push_back(
                  {{"hostTimeNs",
                    decimal_nonnegative(axis_batch.points[point].host_time_ns)},
                   {"value", axis_batch.points[point].value}});
            }
            batches.push_back({{"axis", axis_name(axis_batch.axis)},
                               {"points", std::move(points)}});
          }
          return envelope("plot_batch", message.monotonic_ns,
                          {{"axes", std::move(batches)}});
        } else if constexpr (std::is_same_v<Payload, RecorderSnapshot>) {
          return envelope("recording_state", message.monotonic_ns,
                          {{"state", recording_state_name(payload.state)},
                           {"partialPath", payload.partial_path.u8string()},
                           {"lastError", payload.last_error}});
        } else if constexpr (std::is_same_v<Payload,
                                            netft::SensorConfiguration>) {
          return envelope("configuration_changed", message.monotonic_ns,
                          configuration_payload(payload));
        } else {
          static_assert(std::is_same_v<Payload, SessionError>);
          return envelope("error", message.monotonic_ns,
                          {{"operation", operation_name(payload.operation)},
                           {"message", payload.message},
                           {"sequence", decimal(payload.sequence)},
                           {"droppedBefore", decimal(payload.dropped_before)}});
        }
      },
      event.payload);
}

} // namespace

SerializedEvent::SerializedEvent(std::string json_line,
                                 std::optional<MeasurementLease> delivery_lease,
                                 bool measurement)
    : json_line_(std::move(json_line)),
      delivery_lease_(std::move(delivery_lease)), measurement_(measurement) {}

const std::string &SerializedEvent::json_line() const noexcept {
  return json_line_;
}

bool SerializedEvent::valid_for_delivery() const noexcept {
  return !measurement_ ||
         (delivery_lease_.has_value() && delivery_lease_->valid());
}

Command parse_command(std::string_view line) {
  const auto root = parse_unique_json(line);
  if (!root.is_object()) {
    throw ProtocolError("command envelope must be an object");
  }
  auto header = parse_header(root);
  const auto type = required_string(root, "type", 32U);
  const auto &payload = required(root, "payload");
  if (!payload.is_object()) {
    throw ProtocolError("command payload must be an object");
  }

  if (type == "hello") {
    return HelloCommand{std::move(header)};
  }
  if (type == "connect") {
    auto host = required_string(payload, "sensorHost", 253U);
    if (!valid_sensor_host(host)) {
      throw ProtocolError(
          "sensor host is not a valid IPv4 address or DNS name");
    }
    return ConnectCommand{std::move(header), std::move(host)};
  }
  if (type == "disconnect") {
    return DisconnectCommand{std::move(header)};
  }
  if (type == "set_paused") {
    const auto &paused = required(payload, "paused");
    if (!paused.is_boolean()) {
      throw ProtocolError("paused must be boolean");
    }
    return SetPausedCommand{std::move(header), paused.get<bool>()};
  }
  if (type == "bias") {
    return BiasCommand{std::move(header)};
  }
  if (type == "start_recording") {
    auto path = required_string(payload, "targetPath", 32768U);
    const auto &overwrite = required(payload, "overwrite");
    if (!overwrite.is_boolean()) {
      throw ProtocolError("overwrite must be boolean");
    }
    return StartRecordingCommand{std::move(header),
                                 std::filesystem::u8path(path),
                                 overwrite.get<bool>()};
  }
  if (type == "stop_recording") {
    return StopRecordingCommand{std::move(header)};
  }
  if (type == "shutdown") {
    return ShutdownCommand{std::move(header)};
  }
  throw ProtocolError("unknown command type");
}

std::optional<SerializedEvent> serialize_event(const CompanionEvent &event) {
  try {
    const auto serialized = std::visit(
        [](const auto &message) -> std::optional<Json> {
          using Message = std::decay_t<decltype(message)>;
          if constexpr (std::is_same_v<Message, HelloEvent>) {
            if (!valid_request_id(message.request_id) ||
                message.app_version.empty() ||
                !valid_snapshot_id(message.core_snapshot)) {
              return std::nullopt;
            }
            auto result = envelope("hello", message.monotonic_ns,
                                   {{"protocolMajor", protocol_major},
                                    {"protocolMinor", protocol_minor},
                                    {"appVersion", message.app_version},
                                    {"coreSnapshot", message.core_snapshot}});
            result["requestId"] = message.request_id;
            return result;
          } else if constexpr (std::is_same_v<Message, CommandResultEvent>) {
            if (!valid_request_id(message.request_id) ||
                !valid_non_hello_command(message.command_type) ||
                (!message.success && (message.error_code.empty() ||
                                      message.error_message.empty()))) {
              return std::nullopt;
            }
            auto payload = Json{{"commandType", message.command_type},
                                {"success", message.success}};
            if (!message.success) {
              payload["errorCode"] = message.error_code;
              payload["errorMessage"] = message.error_message;
            }
            auto result = envelope("command_result", message.monotonic_ns,
                                   std::move(payload));
            result["requestId"] = message.request_id;
            return result;
          } else if constexpr (std::is_same_v<Message, SessionEventMessage>) {
            return session_envelope(message);
          } else {
            return envelope(
                "recording_progress", message.monotonic_ns,
                {{"acceptedSamples",
                  decimal(message.snapshot.accepted_samples)},
                 {"writtenSamples", decimal(message.snapshot.written_samples)},
                 {"bytesWritten", decimal(message.snapshot.bytes_written)},
                 {"queueSize", decimal(static_cast<std::uint64_t>(
                                   message.snapshot.queue_size))},
                 {"queueCapacity", decimal(static_cast<std::uint64_t>(
                                       message.snapshot.queue_capacity))}});
          }
        },
        event);
    if (!serialized) {
      return std::nullopt;
    }
    auto line = serialized->dump();
    if (line.size() > maximum_line_bytes) {
      return std::nullopt;
    }
    std::optional<MeasurementLease> delivery_lease;
    bool measurement = false;
    if (const auto *message = std::get_if<SessionEventMessage>(&event)) {
      measurement =
          std::holds_alternative<TimedSample>(message->event.payload) ||
          std::holds_alternative<PlotBatch>(message->event.payload);
      if (measurement) {
        if (!message->event.valid_for_delivery() ||
            !message->event.measurement_lease) {
          return std::nullopt;
        }
        delivery_lease = message->event.measurement_lease;
      }
    }
    SerializedEvent frame{std::move(line), std::move(delivery_lease),
                          measurement};
    if (!frame.valid_for_delivery()) {
      return std::nullopt;
    }
    return std::optional<SerializedEvent>{std::move(frame)};
  } catch (const std::exception &) {
    return std::nullopt;
  }
}

} // namespace netft_viewer::companion
