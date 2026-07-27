#include <gtest/gtest.h>

#include "bias_authorization.hpp"

namespace netft_viewer::hardware {
namespace {

TEST(HardwareAuthorizationTest, RequiresBothExactBiasOptIns) {
  EXPECT_FALSE(bias_authorized(nullptr, nullptr));
  EXPECT_FALSE(bias_authorized("1", nullptr));
  EXPECT_FALSE(bias_authorized(nullptr, "YES"));
  EXPECT_FALSE(bias_authorized("0", "YES"));
  EXPECT_FALSE(bias_authorized("1", "yes"));
  EXPECT_FALSE(bias_authorized("01", "YES"));
  EXPECT_TRUE(bias_authorized("1", "YES"));
}

} // namespace
} // namespace netft_viewer::hardware
