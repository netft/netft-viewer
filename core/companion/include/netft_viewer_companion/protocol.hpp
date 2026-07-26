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

class ProtocolError : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

[[nodiscard]] Command parse_command(std::string_view line);
[[nodiscard]] std::optional<std::string>
serialize_event(const CompanionEvent &event);

} // namespace netft_viewer::companion
