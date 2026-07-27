#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>

#include "netft_viewer/plot_aggregator.hpp"
#include "support/manual_clock.hpp"

namespace netft_viewer {
namespace {

using namespace std::chrono_literals;

TimedSample timed_sample(std::chrono::milliseconds timestamp,
                         const std::array<double, 6> &values,
                         std::uint64_t configuration_revision = 1U) {
  TimedSample timed;
  timed.host_time_ns =
      std::chrono::duration_cast<std::chrono::nanoseconds>(timestamp).count();
  timed.monotonic_time_ns = timed.host_time_ns;
  timed.sample.force = {values[0], values[1], values[2]};
  timed.sample.torque = {values[3], values[4], values[5]};
  timed.sample.configuration_revision = configuration_revision;
  return timed;
}

std::array<double, 6> axis_values(double value) {
  return {value, value, value, value, value, value};
}

std::vector<PlotPoint> points_for(const PlotBatch &batch, Axis axis) {
  const auto &axis_batch = batch.axes[axis_index(axis)];
  EXPECT_EQ(axis_batch.axis, axis);
  return std::vector<PlotPoint>(axis_batch.points.begin(),
                                axis_batch.points.begin() + axis_batch.count);
}

std::vector<double> values_for(const PlotBatch &batch, Axis axis) {
  std::vector<double> values;
  for (const auto &point : points_for(batch, axis)) {
    values.push_back(point.value);
  }
  return values;
}

TEST(PlotAggregatorTest, EmitsChronologicalUniqueExtrema) {
  PlotAggregator aggregator(33ms);
  EXPECT_FALSE(
      aggregator.push(timed_sample(0ms, axis_values(4.0))).has_value());
  EXPECT_FALSE(
      aggregator.push(timed_sample(5ms, axis_values(-2.0))).has_value());
  EXPECT_FALSE(
      aggregator.push(timed_sample(10ms, axis_values(8.0))).has_value());

  const auto batch = aggregator.push(timed_sample(34ms, axis_values(6.0)));

  ASSERT_TRUE(batch.has_value());
  EXPECT_EQ(values_for(*batch, Axis::Fx),
            (std::vector<double>{4.0, -2.0, 8.0}));
  EXPECT_EQ(values_for(*batch, Axis::Tz),
            (std::vector<double>{4.0, -2.0, 8.0}));
}

TEST(PlotAggregatorTest, RemovesDuplicateExtremaBySampleIndex) {
  PlotAggregator aggregator(33ms);
  static_cast<void>(aggregator.push(timed_sample(0ms, axis_values(2.0))));
  static_cast<void>(aggregator.push(timed_sample(10ms, axis_values(-3.0))));
  static_cast<void>(aggregator.push(timed_sample(20ms, axis_values(5.0))));

  const auto batch = aggregator.push(timed_sample(40ms, axis_values(8.0)));

  ASSERT_TRUE(batch.has_value());
  const auto points = points_for(*batch, Axis::Fx);
  ASSERT_EQ(points.size(), 3U);
  EXPECT_EQ(points[0].host_time_ns, 0);
  EXPECT_EQ(points[1].host_time_ns, 10'000'000);
  EXPECT_EQ(points[2].host_time_ns, 20'000'000);
  EXPECT_EQ(values_for(*batch, Axis::Fx),
            (std::vector<double>{2.0, -3.0, 5.0}));
}

TEST(PlotAggregatorTest, EmitsOnePointForASingleSampleInterval) {
  PlotAggregator aggregator(33ms);
  static_cast<void>(aggregator.push(timed_sample(0ms, axis_values(7.0))));

  const auto batch = aggregator.push(timed_sample(33ms, axis_values(9.0)));

  ASSERT_TRUE(batch.has_value());
  const auto points = points_for(*batch, Axis::Fy);
  ASSERT_EQ(points.size(), 1U);
  EXPECT_EQ(points[0].host_time_ns, 0);
  EXPECT_EQ(points[0].value, 7.0);
}

TEST(PlotAggregatorTest, AggregatesEachAxisIndependently) {
  PlotAggregator aggregator(33ms);
  static_cast<void>(
      aggregator.push(timed_sample(0ms, {0.0, 10.0, 3.0, 20.0, -1.0, 6.0})));
  static_cast<void>(
      aggregator.push(timed_sample(10ms, {3.0, -4.0, 7.0, 10.0, 4.0, 8.0})));
  static_cast<void>(
      aggregator.push(timed_sample(20ms, {1.0, 8.0, -2.0, 30.0, -5.0, 2.0})));

  const auto batch = aggregator.push(timed_sample(33ms, axis_values(0.0)));

  ASSERT_TRUE(batch.has_value());
  EXPECT_EQ(values_for(*batch, Axis::Fx), (std::vector<double>{0.0, 3.0, 1.0}));
  EXPECT_EQ(values_for(*batch, Axis::Fy),
            (std::vector<double>{10.0, -4.0, 8.0}));
  EXPECT_EQ(values_for(*batch, Axis::Fz),
            (std::vector<double>{3.0, 7.0, -2.0}));
  EXPECT_EQ(values_for(*batch, Axis::Tx),
            (std::vector<double>{20.0, 10.0, 30.0}));
  EXPECT_EQ(values_for(*batch, Axis::Ty),
            (std::vector<double>{-1.0, 4.0, -5.0}));
  EXPECT_EQ(values_for(*batch, Axis::Tz), (std::vector<double>{6.0, 8.0, 2.0}));
}

TEST(PlotAggregatorTest, BoundarySampleSeedsTheNextInterval) {
  PlotAggregator aggregator(33ms);
  static_cast<void>(aggregator.push(timed_sample(10ms, axis_values(1.0))));
  const auto first_batch =
      aggregator.push(timed_sample(43ms, axis_values(2.0)));
  ASSERT_TRUE(first_batch.has_value());
  EXPECT_EQ(values_for(*first_batch, Axis::Fx), (std::vector<double>{1.0}));

  const auto second_batch =
      aggregator.push(timed_sample(76ms, axis_values(3.0)));
  ASSERT_TRUE(second_batch.has_value());
  EXPECT_EQ(values_for(*second_batch, Axis::Fx), (std::vector<double>{2.0}));
}

TEST(PlotAggregatorTest,
     LargeGapEmitsOnlyTheActiveIntervalAndSeedsTheLateSample) {
  PlotAggregator aggregator(33ms);
  static_cast<void>(aggregator.push(timed_sample(0ms, axis_values(1.0))));

  const auto first_batch =
      aggregator.push(timed_sample(std::chrono::hours{1}, axis_values(2.0)));
  ASSERT_TRUE(first_batch.has_value());
  EXPECT_EQ(values_for(*first_batch, Axis::Fx), (std::vector<double>{1.0}));

  const auto second_batch = aggregator.push(
      timed_sample(std::chrono::hours{1} + 33ms, axis_values(3.0)));
  ASSERT_TRUE(second_batch.has_value());
  EXPECT_EQ(values_for(*second_batch, Axis::Fx), (std::vector<double>{2.0}));
}

TEST(PlotAggregatorTest, ResetDropsTheCurrentInterval) {
  PlotAggregator aggregator(33ms);
  static_cast<void>(aggregator.push(timed_sample(0ms, axis_values(1.0))));
  static_cast<void>(aggregator.push(timed_sample(10ms, axis_values(2.0))));
  aggregator.reset();

  EXPECT_FALSE(
      aggregator.push(timed_sample(20ms, axis_values(3.0))).has_value());
  const auto batch = aggregator.push(timed_sample(53ms, axis_values(4.0)));
  ASSERT_TRUE(batch.has_value());
  EXPECT_EQ(values_for(*batch, Axis::Fx), (std::vector<double>{3.0}));
}

TEST(PlotAggregatorTest, ConfigurationRevisionStartsANewEmptyInterval) {
  PlotAggregator aggregator(33ms);
  ASSERT_FALSE(
      aggregator.push(timed_sample(0ms, axis_values(1.0), 1U)).has_value());
  ASSERT_FALSE(
      aggregator.push(timed_sample(10ms, axis_values(2.0), 1U)).has_value());

  EXPECT_FALSE(
      aggregator.push(timed_sample(40ms, axis_values(3.0), 2U)).has_value());
  const auto batch = aggregator.push(timed_sample(73ms, axis_values(4.0), 2U));

  ASSERT_TRUE(batch.has_value());
  EXPECT_EQ(values_for(*batch, Axis::Fx), (std::vector<double>{3.0}));
}

TEST(ManualClockTest, AdvancesHostAndMonotonicTimeTogether) {
  test::ManualClock clock;
  clock.advance(7ms);

  EXPECT_EQ(clock.monotonic_now_ns(), 7'000'000);
  EXPECT_EQ(clock.host_now_ns(), 7'000'000);
}

TEST(PlotAggregatorTest, RejectsNonMonotonicInputWithoutMutatingTheInterval) {
  PlotAggregator aggregator(33ms);
  static_cast<void>(aggregator.push(timed_sample(10ms, axis_values(1.0))));
  EXPECT_FALSE(
      aggregator.push(timed_sample(9ms, axis_values(99.0))).has_value());
  const auto batch = aggregator.push(timed_sample(43ms, axis_values(2.0)));

  ASSERT_TRUE(batch.has_value());
  EXPECT_EQ(values_for(*batch, Axis::Fx), (std::vector<double>{1.0}));
}

TEST(PlotAggregatorTest, BatchesHaveMonotonicallyIncreasingHostTimestamps) {
  PlotAggregator aggregator(33ms);
  std::vector<std::int64_t> timestamps;
  for (int millisecond = 0; millisecond <= 165; millisecond += 11) {
    const auto batch = aggregator.push(timed_sample(
        std::chrono::milliseconds{millisecond}, axis_values(millisecond)));
    if (batch.has_value()) {
      for (const auto &point : points_for(*batch, Axis::Fx)) {
        timestamps.push_back(point.host_time_ns);
      }
    }
  }

  ASSERT_FALSE(timestamps.empty());
  EXPECT_TRUE(std::is_sorted(timestamps.begin(), timestamps.end()));
}

TEST(PlotAggregatorTest, HandlesTheFullMonotonicTimestampRangeWithoutOverflow) {
  PlotAggregator aggregator(33ms);
  auto first = timed_sample(0ms, axis_values(1.0));
  first.monotonic_time_ns = std::numeric_limits<std::int64_t>::min();
  auto boundary = timed_sample(33ms, axis_values(2.0));
  boundary.monotonic_time_ns = std::numeric_limits<std::int64_t>::max();

  EXPECT_FALSE(aggregator.push(first).has_value());
  const auto batch = aggregator.push(boundary);

  ASSERT_TRUE(batch.has_value());
  EXPECT_EQ(values_for(*batch, Axis::Fx), (std::vector<double>{1.0}));
}

TEST(PlotAggregatorTest, RejectsANonPositiveInterval) {
  EXPECT_THROW(PlotAggregator aggregator(0ns), std::invalid_argument);
  EXPECT_THROW(PlotAggregator aggregator(-1ns), std::invalid_argument);
}

} // namespace
} // namespace netft_viewer
