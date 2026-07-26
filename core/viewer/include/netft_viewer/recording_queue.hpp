#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <type_traits>

namespace netft_viewer {

template <typename T, std::size_t Capacity> class RecordingQueue {
  static_assert(Capacity > 0, "RecordingQueue capacity must be positive");
  static_assert(std::is_trivially_copyable<T>::value,
                "RecordingQueue values must be trivially copyable");

public:
  bool try_push(const T &value) noexcept {
    const auto write = write_.load(std::memory_order_relaxed);
    const auto read = read_.load(std::memory_order_acquire);
    if (write - read == Capacity) {
      return false;
    }

    storage_[write % Capacity] = value;
    write_.store(write + 1, std::memory_order_release);
    return true;
  }

  bool try_pop(T &value) noexcept {
    const auto read = read_.load(std::memory_order_relaxed);
    const auto write = write_.load(std::memory_order_acquire);
    if (read == write) {
      return false;
    }

    value = storage_[read % Capacity];
    read_.store(read + 1, std::memory_order_release);
    return true;
  }

  std::size_t size() const noexcept {
    const auto write = write_.load(std::memory_order_acquire);
    const auto read = read_.load(std::memory_order_acquire);
    return write - read;
  }

  static constexpr std::size_t capacity() noexcept { return Capacity; }

private:
  alignas(64) std::atomic<std::size_t> write_{0};
  alignas(64) std::atomic<std::size_t> read_{0};
  std::array<T, Capacity> storage_{};
};

} // namespace netft_viewer
