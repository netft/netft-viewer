#pragma once

#include <cstddef>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

#include "netft_viewer_companion/messages.hpp"

namespace netft_viewer::companion {

inline constexpr std::uint32_t protocol_major = 1U;
inline constexpr std::uint32_t protocol_minor = 0U;
inline constexpr std::size_t maximum_line_bytes = 1024U * 1024U;
inline constexpr std::size_t maximum_json_nesting_depth = 64U;
inline constexpr std::size_t maximum_request_id_bytes = 128U;

class ProtocolError : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

class SerializedEvent {
public:
  SerializedEvent(const SerializedEvent &) = delete;
  SerializedEvent &operator=(const SerializedEvent &) = delete;
  SerializedEvent(SerializedEvent &&) noexcept = default;
  SerializedEvent &operator=(SerializedEvent &&) noexcept = default;

  // Queue and move the complete frame. The unique stdout writer must call
  // valid_for_delivery() immediately before committing json_line(); a
  // measurement lease can be revoked after serialization.
  [[nodiscard]] const std::string &json_line() const noexcept;
  [[nodiscard]] bool valid_for_delivery() const noexcept;

private:
  friend std::optional<SerializedEvent>
  serialize_event(const CompanionEvent &event);

  SerializedEvent(std::string json_line,
                  std::optional<MeasurementLease> delivery_lease,
                  bool measurement);

  std::string json_line_;
  std::optional<MeasurementLease> delivery_lease_;
  bool measurement_{};
};

[[nodiscard]] Command parse_command(std::string_view line);
[[nodiscard]] std::optional<SerializedEvent>
serialize_event(const CompanionEvent &event);

} // namespace netft_viewer::companion
