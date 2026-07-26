#pragma once

#include <chrono>
#include <cstdint>

#include "netft_viewer/clock.hpp"

namespace netft_viewer::test {

class ManualClock final : public Clock {
public:
  [[nodiscard]] std::int64_t monotonic_now_ns() const noexcept override {
    return monotonic_time_ns_;
  }

  [[nodiscard]] std::int64_t host_now_ns() const noexcept override {
    return host_time_ns_;
  }

  void advance(std::chrono::nanoseconds duration) noexcept {
    monotonic_time_ns_ += duration.count();
    host_time_ns_ += duration.count();
  }

  void set(std::int64_t monotonic_time_ns, std::int64_t host_time_ns) noexcept {
    monotonic_time_ns_ = monotonic_time_ns;
    host_time_ns_ = host_time_ns;
  }

private:
  std::int64_t monotonic_time_ns_{};
  std::int64_t host_time_ns_{};
};

} // namespace netft_viewer::test
