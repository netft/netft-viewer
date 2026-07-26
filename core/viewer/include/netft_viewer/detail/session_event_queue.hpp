#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <type_traits>
#include <utility>

#include "netft_viewer/session.hpp"

namespace netft_viewer::detail {

class SessionEventQueue {
public:
  static constexpr std::size_t capacity = 64U;
  static constexpr std::size_t error_capacity = 16U;

  void push(SessionEvent event) {
    if (!is_error(event)) {
      const auto existing = std::find_if(
          events_.begin(), events_.end(), [&](const SessionEvent &candidate) {
            return candidate.generation == event.generation &&
                   candidate.payload.index() == event.payload.index();
          });
      if (existing != events_.end()) {
        *existing = std::move(event);
        return;
      }
    } else if (error_count() >= error_capacity) {
      drop_oldest_error();
      annotate_error(event);
    }

    while (events_.size() >= capacity) {
      const auto state = std::find_if(
          events_.begin(), events_.end(),
          [](const SessionEvent &candidate) { return !is_error(candidate); });
      if (state != events_.end()) {
        events_.erase(state);
      } else {
        drop_oldest_error();
        annotate_error(event);
      }
    }
    events_.push_back(std::move(event));
  }

  [[nodiscard]] std::optional<SessionEvent> pop() {
    if (events_.empty()) {
      return std::nullopt;
    }
    auto event = std::move(events_.front());
    events_.pop_front();
    return event;
  }

  void purge_measurements(std::uint64_t generation) {
    auto iterator = events_.begin();
    while (iterator != events_.end()) {
      const auto measurement =
          std::holds_alternative<TimedSample>(iterator->payload) ||
          std::holds_alternative<PlotBatch>(iterator->payload);
      if (iterator->generation == generation && measurement) {
        iterator = events_.erase(iterator);
      } else {
        ++iterator;
      }
    }
  }

  void retain_generation(std::uint64_t generation) {
    auto iterator = events_.begin();
    while (iterator != events_.end()) {
      if (iterator->generation != generation) {
        iterator = events_.erase(iterator);
      } else {
        ++iterator;
      }
    }
  }

  void clear() noexcept { events_.clear(); }

  [[nodiscard]] bool empty() const noexcept { return events_.empty(); }
  [[nodiscard]] std::size_t size() const noexcept { return events_.size(); }

  [[nodiscard]] std::size_t error_count() const noexcept {
    return static_cast<std::size_t>(
        std::count_if(events_.begin(), events_.end(), is_error));
  }

  [[nodiscard]] std::uint64_t dropped_error_count() const noexcept {
    return dropped_errors_;
  }

private:
  static bool is_error(const SessionEvent &event) noexcept {
    return std::holds_alternative<SessionError>(event.payload);
  }

  void drop_oldest_error() {
    const auto error = std::find_if(events_.begin(), events_.end(), is_error);
    if (error != events_.end()) {
      events_.erase(error);
      ++dropped_errors_;
    }
  }

  void annotate_error(SessionEvent &event) const noexcept {
    if (auto *error = std::get_if<SessionError>(&event.payload)) {
      error->dropped_before = dropped_errors_;
    }
  }

  std::deque<SessionEvent> events_;
  std::uint64_t dropped_errors_{};
};

} // namespace netft_viewer::detail
