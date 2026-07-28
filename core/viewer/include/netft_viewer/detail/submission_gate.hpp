#pragma once

#include <atomic>
#include <cstdint>
#include <utility>

namespace netft_viewer::detail {

class SubmissionGate {
  static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
                "SubmissionGate requires lock-free 64-bit atomics");

public:
  class Entry {
  public:
    Entry() noexcept = default;
    Entry(const Entry &) = delete;
    Entry &operator=(const Entry &) = delete;

    Entry(Entry &&other) noexcept
        : gate_(std::exchange(other.gate_, nullptr)),
          accepted_(std::exchange(other.accepted_, false)) {}

    Entry &operator=(Entry &&other) noexcept {
      if (this != &other) {
        release();
        gate_ = std::exchange(other.gate_, nullptr);
        accepted_ = std::exchange(other.accepted_, false);
      }
      return *this;
    }

    ~Entry() { release(); }

    bool accepted() const noexcept { return accepted_; }

    void release() noexcept {
      if (gate_ != nullptr) {
        gate_->admission_.fetch_sub(1U, std::memory_order_release);
        gate_ = nullptr;
      }
    }

  private:
    friend class SubmissionGate;

    Entry(SubmissionGate &gate, bool accepted) noexcept
        : gate_(&gate), accepted_(accepted) {}

    SubmissionGate *gate_{};
    bool accepted_{false};
  };

  Entry enter() noexcept {
    auto current = admission_.load(std::memory_order_acquire);
    while ((current & open_bit) != 0U) {
      if ((current & count_mask) == count_mask) {
        return Entry{};
      }
      if (admission_.compare_exchange_weak(current, current + 1U,
                                           std::memory_order_acq_rel,
                                           std::memory_order_acquire)) {
        return Entry{*this, true};
      }
    }
    return Entry{};
  }

  void close() noexcept {
    admission_.fetch_and(count_mask, std::memory_order_acq_rel);
  }

  template <typename BeforeCommit>
  bool try_open(BeforeCommit &&before_commit) noexcept(
      noexcept(std::forward<BeforeCommit>(before_commit)())) {
    std::uint64_t expected = 0U;
    // The hook makes the commit point deterministically testable without
    // changing the single-CAS production protocol.
    std::forward<BeforeCommit>(before_commit)();
    return admission_.compare_exchange_strong(expected, open_bit,
                                              std::memory_order_acq_rel,
                                              std::memory_order_acquire);
  }

  bool try_open() noexcept {
    return try_open([]() noexcept {});
  }

  bool drained() const noexcept {
    return (admission_.load(std::memory_order_acquire) & count_mask) == 0U;
  }

private:
  static constexpr std::uint64_t open_bit = std::uint64_t{1} << 63U;
  static constexpr std::uint64_t count_mask = open_bit - 1U;

  std::atomic<std::uint64_t> admission_{0U};
};

} // namespace netft_viewer::detail
