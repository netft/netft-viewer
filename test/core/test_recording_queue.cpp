#include <gtest/gtest.h>

#include <atomic>
#include <thread>
#include <vector>

#include "netft_viewer/detail/drain_completion.hpp"
#include "netft_viewer/detail/submission_gate.hpp"
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

TEST(RecordingQueueTest, ApproximateSizeRemainsBoundedDuringConcurrentUse) {
  constexpr int value_count = 100'000;
  RecordingQueue<int, 128> queue;
  std::atomic<bool> producer_done{false};
  std::atomic<bool> size_out_of_bounds{false};

  std::thread producer([&] {
    for (int value = 0; value < value_count; ++value) {
      while (!queue.try_push(value)) {
        if (queue.size() > queue.capacity()) {
          size_out_of_bounds.store(true, std::memory_order_relaxed);
        }
        std::this_thread::yield();
      }
    }
    producer_done.store(true, std::memory_order_release);
  });

  while (!producer_done.load(std::memory_order_acquire) || queue.size() != 0U) {
    if (queue.size() > queue.capacity()) {
      size_out_of_bounds.store(true, std::memory_order_relaxed);
    }
    int value{};
    queue.try_pop(value);
  }
  producer.join();

  EXPECT_FALSE(size_out_of_bounds.load(std::memory_order_relaxed));
  static_assert(RecordingQueue<int, 128>::capacity() == 128U,
                "queue capacity is part of its compile-time contract");
}

TEST(SubmissionGateTest, CannotReopenUntilEveryPreCloseEntryLeaves) {
  detail::SubmissionGate gate;
  ASSERT_TRUE(gate.try_open());

  auto entry = gate.enter();
  ASSERT_TRUE(entry.accepted());
  gate.close();

  EXPECT_FALSE(gate.drained());
  EXPECT_FALSE(gate.try_open());
  entry.release();
  EXPECT_TRUE(gate.drained());
  EXPECT_TRUE(gate.try_open());
}

TEST(SubmissionGateTest,
     ReopenAtomicallyExcludesAnEntryFromTheClosedGeneration) {
  detail::SubmissionGate gate;
  gate.close();
  detail::SubmissionGate::Entry interleaved_entry;

  const auto opened = gate.try_open([&] { interleaved_entry = gate.enter(); });

  EXPECT_TRUE(opened);
  EXPECT_FALSE(interleaved_entry.accepted());
  EXPECT_TRUE(gate.drained());
  EXPECT_TRUE(gate.enter().accepted());
}

TEST(DrainCompletionTest,
     AcceptedPreCloseEntryMustPublishBeforeQueueCanBeObservedEmpty) {
  detail::SubmissionGate gate;
  RecordingQueue<int, 4> queue;
  ASSERT_TRUE(gate.try_open());
  auto accepted_entry = gate.enter();
  ASSERT_TRUE(accepted_entry.accepted());
  gate.close();
  bool interleaving_hook_ran = false;

  const auto complete = detail::drain_complete(gate, queue, [&] {
    interleaving_hook_ran = true;
    ASSERT_TRUE(queue.try_push(42));
    accepted_entry.release();
  });

  EXPECT_FALSE(complete);
  EXPECT_FALSE(interleaving_hook_ran);
  if (!interleaving_hook_ran) {
    ASSERT_TRUE(queue.try_push(42));
    accepted_entry.release();
  }
  EXPECT_FALSE(detail::drain_complete(gate, queue));
  int recorded_value{};
  ASSERT_TRUE(queue.try_pop(recorded_value));
  EXPECT_EQ(recorded_value, 42);
  EXPECT_TRUE(detail::drain_complete(gate, queue));
}

} // namespace
} // namespace netft_viewer
