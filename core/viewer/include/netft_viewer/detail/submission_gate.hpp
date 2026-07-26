#pragma once

#include <atomic>
#include <cstdint>
#include <utility>

namespace netft_viewer::detail {

class SubmissionGate {
public:
  class Entry {
  public:
    Entry() noexcept = default;
    Entry(const Entry &) = delete;
    Entry &operator=(const Entry &) = delete;

    Entry(Entry &&other) noexcept
        : gate_(std::exchange(other.gate_, nullptr)),
          accepted_(other.accepted_) {}

    Entry &operator=(Entry &&other) noexcept {
      if (this != &other) {
        release();
        gate_ = std::exchange(other.gate_, nullptr);
        accepted_ = other.accepted_;
      }
      return *this;
    }

    ~Entry() { release(); }

    bool accepted() const noexcept { return accepted_; }

    void release() noexcept {
      if (gate_ != nullptr) {
        gate_->in_flight_.fetch_sub(1, std::memory_order_release);
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
    in_flight_.fetch_add(1, std::memory_order_acq_rel);
    return Entry{*this, open_.load(std::memory_order_acquire)};
  }

  void close() noexcept { open_.store(false, std::memory_order_release); }

  bool try_open() noexcept {
    if (!drained()) {
      return false;
    }
    open_.store(true, std::memory_order_release);
    return true;
  }

  bool drained() const noexcept {
    return in_flight_.load(std::memory_order_acquire) == 0U;
  }

private:
  std::atomic<bool> open_{false};
  std::atomic<std::uint32_t> in_flight_{0};
};

} // namespace netft_viewer::detail
