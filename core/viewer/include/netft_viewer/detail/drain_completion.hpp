#pragma once

#include <utility>

namespace netft_viewer::detail {

template <typename Gate, typename Queue, typename BetweenObservations>
bool drain_complete(
    const Gate &gate, const Queue &queue,
    BetweenObservations &&
        between_observations) noexcept(noexcept(std::
                                                    forward<
                                                        BetweenObservations>(
                                                        between_observations)())) {
  if (!gate.drained()) {
    return false;
  }
  // The gate's acquire must precede the queue's acquire. An accepted
  // submission publishes its queue write before releasing its gate entry.
  std::forward<BetweenObservations>(between_observations)();
  return queue.size() == 0U;
}

template <typename Gate, typename Queue>
bool drain_complete(const Gate &gate, const Queue &queue) noexcept {
  return drain_complete(gate, queue, []() noexcept {});
}

} // namespace netft_viewer::detail
