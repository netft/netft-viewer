#include "netft_viewer/plot_aggregator.hpp"

#include <array>
#include <cstddef>
#include <stdexcept>

namespace netft_viewer {
namespace {

double axis_value(const netft::Sample &sample, Axis axis) noexcept {
  const auto index = axis_index(axis);
  return index < sample.force.size()
             ? sample.force[index]
             : sample.torque[index - sample.force.size()];
}

} // namespace

PlotAggregator::PlotAggregator(std::chrono::nanoseconds interval)
    : interval_(interval) {
  if (interval_ <= std::chrono::nanoseconds::zero()) {
    throw std::invalid_argument{"plot interval must be positive"};
  }
}

std::optional<PlotBatch> PlotAggregator::push(const TimedSample &sample) {
  if (!has_interval_) {
    seed_interval(sample);
    return std::nullopt;
  }

  if (sample.sample.configuration_revision != configuration_revision_) {
    reset();
    seed_interval(sample);
    return std::nullopt;
  }

  if (sample.monotonic_time_ns < last_monotonic_time_ns_) {
    return std::nullopt;
  }

  const auto elapsed_ns = static_cast<std::uint64_t>(sample.monotonic_time_ns) -
                          static_cast<std::uint64_t>(interval_start_ns_);
  if (elapsed_ns >= static_cast<std::uint64_t>(interval_.count())) {
    const auto batch = make_batch();
    seed_interval(sample);
    return batch;
  }

  add_to_interval(sample);
  return std::nullopt;
}

void PlotAggregator::reset() noexcept {
  has_interval_ = false;
  interval_start_ns_ = 0;
  last_monotonic_time_ns_ = 0;
  next_sample_index_ = 0;
  configuration_revision_ = 0;
}

void PlotAggregator::seed_interval(const TimedSample &sample) noexcept {
  has_interval_ = true;
  interval_start_ns_ = sample.monotonic_time_ns;
  last_monotonic_time_ns_ = sample.monotonic_time_ns;
  configuration_revision_ = sample.sample.configuration_revision;
  for (const auto axis : axes) {
    const Candidate candidate{sample.host_time_ns, sample.monotonic_time_ns,
                              axis_value(sample.sample, axis),
                              next_sample_index_};
    auto &axis_candidates = candidates_[axis_index(axis)];
    axis_candidates.first = candidate;
    axis_candidates.minimum = candidate;
    axis_candidates.maximum = candidate;
    axis_candidates.last = candidate;
  }
  ++next_sample_index_;
}

void PlotAggregator::add_to_interval(const TimedSample &sample) noexcept {
  last_monotonic_time_ns_ = sample.monotonic_time_ns;
  for (const auto axis : axes) {
    const Candidate candidate{sample.host_time_ns, sample.monotonic_time_ns,
                              axis_value(sample.sample, axis),
                              next_sample_index_};
    auto &axis_candidates = candidates_[axis_index(axis)];
    if (candidate.value < axis_candidates.minimum.value) {
      axis_candidates.minimum = candidate;
    }
    if (candidate.value > axis_candidates.maximum.value) {
      axis_candidates.maximum = candidate;
    }
    axis_candidates.last = candidate;
  }
  ++next_sample_index_;
}

PlotBatch PlotAggregator::make_batch() const noexcept {
  PlotBatch batch;
  for (const auto axis : axes) {
    const auto &candidates = candidates_[axis_index(axis)];
    std::array<Candidate, 4> selected{candidates.first, candidates.minimum,
                                      candidates.maximum, candidates.last};
    for (std::size_t index = 1; index < selected.size(); ++index) {
      const Candidate current = selected[index];
      std::size_t insertion = index;
      while (insertion > 0U && precedes(current, selected[insertion - 1U])) {
        selected[insertion] = selected[insertion - 1U];
        --insertion;
      }
      selected[insertion] = current;
    }

    auto &axis_batch = batch.axes[axis_index(axis)];
    axis_batch.axis = axis;
    std::array<std::uint64_t, 4> emitted_sample_indices{};
    for (const auto &candidate : selected) {
      bool duplicate = false;
      for (std::uint8_t index = 0; index < axis_batch.count; ++index) {
        if (emitted_sample_indices[index] == candidate.sample_index) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) {
        continue;
      }
      axis_batch.points[axis_batch.count] =
          PlotPoint{candidate.host_time_ns, candidate.value};
      emitted_sample_indices[axis_batch.count] = candidate.sample_index;
      ++axis_batch.count;
    }
  }
  return batch;
}

bool PlotAggregator::precedes(const Candidate &left,
                              const Candidate &right) noexcept {
  if (left.monotonic_time_ns != right.monotonic_time_ns) {
    return left.monotonic_time_ns < right.monotonic_time_ns;
  }
  return left.sample_index < right.sample_index;
}

} // namespace netft_viewer
