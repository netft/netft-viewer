#pragma once

#include <array>
#include <chrono>
#include <cstdint>
#include <optional>

#include "netft_viewer/axis.hpp"
#include "netft_viewer/clock.hpp"

namespace netft_viewer {

struct PlotPoint {
  std::int64_t host_time_ns{};
  double value{};
};

struct AxisPlotBatch {
  Axis axis{};
  std::array<PlotPoint, 4> points{};
  std::uint8_t count{};
};

struct PlotBatch {
  std::array<AxisPlotBatch, netft_viewer::axes.size()> axes{};
};

class PlotAggregator {
public:
  explicit PlotAggregator(std::chrono::nanoseconds interval);

  // Input samples must be nondecreasing in monotonic_time_ns. A sample that
  // violates this contract is ignored and returns no batch.
  [[nodiscard]] std::optional<PlotBatch> push(const TimedSample &sample);
  void reset() noexcept;

private:
  struct Candidate {
    std::int64_t host_time_ns{};
    std::int64_t monotonic_time_ns{};
    double value{};
    std::uint64_t sample_index{};
  };

  struct AxisCandidates {
    Candidate first{};
    Candidate minimum{};
    Candidate maximum{};
    Candidate last{};
  };

  void seed_interval(const TimedSample &sample) noexcept;
  void add_to_interval(const TimedSample &sample) noexcept;
  [[nodiscard]] PlotBatch make_batch() const noexcept;
  [[nodiscard]] static bool precedes(const Candidate &left,
                                     const Candidate &right) noexcept;

  std::chrono::nanoseconds interval_;
  std::array<AxisCandidates, axes.size()> candidates_{};
  std::int64_t interval_start_ns_{};
  std::int64_t last_monotonic_time_ns_{};
  std::uint64_t configuration_revision_{};
  std::uint64_t next_sample_index_{};
  bool has_interval_{};
};

} // namespace netft_viewer
