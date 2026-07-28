#pragma once

#include <array>
#include <cstdint>
#include <type_traits>

#include "netft/types.hpp"

namespace netft_viewer {

struct RecordedSample {
  std::int64_t host_receive_timestamp_ns{};
  std::int64_t elapsed_recording_time_ns{};
  std::uint32_t rdt_sequence{};
  std::uint32_t ft_sequence{};
  std::uint32_t status{};
  std::uint64_t configuration_revision{};
  std::array<std::int32_t, 6> raw_wrench{};
  std::array<double, 3> force{};
  std::array<double, 3> torque{};
  netft::ForceUnit force_unit{netft::ForceUnit::Unknown};
  netft::TorqueUnit torque_unit{netft::TorqueUnit::Unknown};
};

static_assert(std::is_trivially_copyable<RecordedSample>::value,
              "RecordedSample must remain safe for the lock-free queue");

} // namespace netft_viewer
