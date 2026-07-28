#include "support/socket_runtime.hpp"

#include <gtest/gtest.h>

TEST(SocketRuntimeTest, OpensConfiguresAndClosesAUdpSocket) {
  netft::test::SocketRuntime runtime;
  auto socket = netft::test::create_socket(AF_INET, SOCK_DGRAM, 0);

  ASSERT_TRUE(netft::test::socket_is_valid(socket));
  EXPECT_TRUE(netft::test::set_socket_nonblocking(socket));

  netft::test::close_socket(socket);
  EXPECT_FALSE(netft::test::socket_is_valid(socket));
}
