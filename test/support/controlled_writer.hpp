#pragma once

#include <condition_variable>
#include <cstddef>
#include <filesystem>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>

#include "netft_viewer/recorder.hpp"

namespace netft_viewer::test {

struct ControlledWriterState {
  std::mutex mutex;
  std::condition_variable condition;
  bool block_writes{false};
  bool write_entered{false};
  bool fail_write{false};
  bool fail_flush{false};
  bool fail_close{false};
  bool fail_create{false};
  bool fail_promote{false};
  bool throw_write{false};
  bool throw_flush{false};
  bool throw_close{false};
  bool throw_promote{false};
  std::size_t write_calls{0};
  std::size_t flush_calls{0};
  std::size_t close_calls{0};
  std::size_t promote_calls{0};
  std::size_t bytes{0};
  std::string output;
};

class ControlledRecorderFile final : public RecorderFile {
public:
  explicit ControlledRecorderFile(std::shared_ptr<ControlledWriterState> state)
      : state_(std::move(state)) {}

  bool write(std::string_view bytes, std::string &error) override {
    std::unique_lock<std::mutex> lock(state_->mutex);
    ++state_->write_calls;
    state_->write_entered = true;
    state_->condition.notify_all();
    state_->condition.wait(lock, [&] { return !state_->block_writes; });
    if (state_->throw_write) {
      throw std::runtime_error{"injected throwing write"};
    }
    if (state_->fail_write) {
      error = "injected write failure";
      return false;
    }
    state_->output.append(bytes.data(), bytes.size());
    state_->bytes += bytes.size();
    return true;
  }

  bool flush(std::string &error) override {
    std::lock_guard<std::mutex> lock(state_->mutex);
    ++state_->flush_calls;
    state_->condition.notify_all();
    if (state_->throw_flush) {
      throw std::runtime_error{"injected throwing flush"};
    }
    if (state_->fail_flush) {
      error = "injected flush failure";
      return false;
    }
    return true;
  }

  bool close(std::string &error) override {
    std::lock_guard<std::mutex> lock(state_->mutex);
    ++state_->close_calls;
    state_->condition.notify_all();
    if (state_->throw_close) {
      throw std::runtime_error{"injected throwing close"};
    }
    if (state_->fail_close) {
      error = "injected close failure";
      return false;
    }
    return true;
  }

  std::uint64_t bytes_written() const noexcept override {
    std::lock_guard<std::mutex> lock(state_->mutex);
    return state_->bytes;
  }

private:
  std::shared_ptr<ControlledWriterState> state_;
};

class ControlledRecorderStorage final : public RecorderStorage {
public:
  explicit ControlledRecorderStorage(
      std::shared_ptr<ControlledWriterState> state)
      : state_(std::move(state)) {}

  std::unique_ptr<RecorderFile> create_exclusive(const std::filesystem::path &,
                                                 std::string &error) override {
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (state_->fail_create) {
      error = "injected create failure";
      return nullptr;
    }
    return std::make_unique<ControlledRecorderFile>(state_);
  }

  bool promote(const std::filesystem::path &, const std::filesystem::path &,
               OverwritePolicy, std::string &error) override {
    std::lock_guard<std::mutex> lock(state_->mutex);
    ++state_->promote_calls;
    state_->condition.notify_all();
    if (state_->throw_promote) {
      throw std::runtime_error{"injected throwing promotion"};
    }
    if (state_->fail_promote) {
      error = "injected promotion failure";
      return false;
    }
    return true;
  }

private:
  std::shared_ptr<ControlledWriterState> state_;
};

inline bool
wait_for_write_entry(const std::shared_ptr<ControlledWriterState> &state,
                     std::chrono::milliseconds timeout) {
  std::unique_lock<std::mutex> lock(state->mutex);
  return state->condition.wait_for(lock, timeout,
                                   [&] { return state->write_entered; });
}

inline bool
wait_for_flush_count(const std::shared_ptr<ControlledWriterState> &state,
                     std::size_t minimum, std::chrono::milliseconds timeout) {
  std::unique_lock<std::mutex> lock(state->mutex);
  return state->condition.wait_for(
      lock, timeout, [&] { return state->flush_calls >= minimum; });
}

inline void
unblock_writes(const std::shared_ptr<ControlledWriterState> &state) {
  std::lock_guard<std::mutex> lock(state->mutex);
  state->block_writes = false;
  state->condition.notify_all();
}

} // namespace netft_viewer::test
