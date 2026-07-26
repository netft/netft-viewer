#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace netft_viewer {

enum class Axis : std::uint8_t { Fx, Fy, Fz, Tx, Ty, Tz };

constexpr std::array<Axis, 6> axes{Axis::Fx, Axis::Fy, Axis::Fz,
                                   Axis::Tx, Axis::Ty, Axis::Tz};

constexpr std::size_t axis_index(Axis axis) noexcept {
  return static_cast<std::size_t>(axis);
}

constexpr bool is_force_axis(Axis axis) noexcept {
  return axis_index(axis) < 3U;
}

constexpr std::string_view axis_name(Axis axis) noexcept {
  switch (axis) {
  case Axis::Fx:
    return "Fx";
  case Axis::Fy:
    return "Fy";
  case Axis::Fz:
    return "Fz";
  case Axis::Tx:
    return "Tx";
  case Axis::Ty:
    return "Ty";
  case Axis::Tz:
    return "Tz";
  }
  return "";
}

} // namespace netft_viewer
