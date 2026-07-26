#include <gtest/gtest.h>

#include <atomic>
#include <thread>
#include <vector>

#include "netft_viewer/recording_queue.hpp"

namespace netft_viewer {
namespace {

TEST(RecordingQueueTest, PreservesOrderAndRejectsOverflow) {
  RecordingQueue<int, 4> queue;

  EXPECT_TRUE(queue.try_push(1));
  EXPECT_TRUE(queue.try_push(2));
  EXPECT_TRUE(queue.try_push(3));
  EXPECT_TRUE(queue.try_push(4));
  EXPECT_FALSE(queue.try_push(5));
  EXPECT_EQ(queue.size(), 4U);

  int value{};
  EXPECT_TRUE(queue.try_pop(value));
  EXPECT_EQ(value, 1);
  EXPECT_TRUE(queue.try_pop(value));
  EXPECT_EQ(value, 2);
  EXPECT_TRUE(queue.try_pop(value));
  EXPECT_EQ(value, 3);
  EXPECT_TRUE(queue.try_pop(value));
  EXPECT_EQ(value, 4);
  EXPECT_FALSE(queue.try_pop(value));
}

TEST(RecordingQueueTest, TransfersConcurrentValuesWithoutLossOrReordering) {
  constexpr int value_count = 100'000;
  RecordingQueue<int, 128> queue;
  std::vector<int> received;
  received.reserve(value_count);
  std::atomic<bool> producer_done{false};

  std::thread producer([&] {
    for (int value = 0; value < value_count; ++value) {
      while (!queue.try_push(value)) {
        std::this_thread::yield();
      }
    }
    producer_done.store(true, std::memory_order_release);
  });

  while (!producer_done.load(std::memory_order_acquire) || queue.size() != 0U) {
    int value{};
    if (queue.try_pop(value)) {
      received.push_back(value);
    } else {
      std::this_thread::yield();
    }
  }
  producer.join();

  ASSERT_EQ(received.size(), static_cast<std::size_t>(value_count));
  for (int value = 0; value < value_count; ++value) {
    EXPECT_EQ(received[static_cast<std::size_t>(value)], value);
  }
}

} // namespace
} // namespace netft_viewer
