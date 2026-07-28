#pragma once

#include <cstdint>

#include "netft/types.hpp"

namespace netft_viewer {

class Clock {
public:
  virtual ~Clock() = default;

  [[nodiscard]] virtual std::int64_t monotonic_now_ns() const noexcept = 0;
  [[nodiscard]] virtual std::int64_t host_now_ns() const noexcept = 0;
};

struct TimedSample {
  netft::Sample sample;
  std::int64_t host_time_ns{};
  std::int64_t monotonic_time_ns{};
};

} // namespace netft_viewer
