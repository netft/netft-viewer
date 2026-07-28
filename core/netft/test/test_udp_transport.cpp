#include "support/socket_runtime.hpp"

#include "detail/protocol.hpp"
#include "detail/udp_transport.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <exception>
#include <future>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

using namespace std::chrono_literals;

class FakeUdpPeer {
public:
  FakeUdpPeer() {
    socket_ = netft::test::create_socket(AF_INET, SOCK_DGRAM, 0);
    if (!netft::test::socket_is_valid(socket_)) {
      throw std::runtime_error("test UDP socket creation failed");
    }

    static_cast<void>(netft::test::set_socket_receive_timeout(
        socket_, std::chrono::seconds{1}));

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::bind(socket_, reinterpret_cast<sockaddr *>(&address),
               static_cast<netft::test::SocketLength>(sizeof(address))) != 0) {
      netft::test::close_socket(socket_);
      throw std::runtime_error("test UDP bind failed");
    }

    netft::test::SocketLength address_size = sizeof(address);
    if (::getsockname(socket_, reinterpret_cast<sockaddr *>(&address),
                      &address_size) != 0) {
      netft::test::close_socket(socket_);
      throw std::runtime_error("test UDP getsockname failed");
    }
    port_ = ntohs(address.sin_port);
  }

  ~FakeUdpPeer() { netft::test::close_socket(socket_); }

  FakeUdpPeer(const FakeUdpPeer &) = delete;
  FakeUdpPeer &operator=(const FakeUdpPeer &) = delete;

  const std::string &host() const noexcept { return host_; }
  int port() const noexcept { return port_; }

  std::array<std::uint8_t, 8>
  reply_with(const std::array<std::uint8_t, 36> &record) {
    sockaddr_in client{};
    netft::test::SocketLength client_size = sizeof(client);
    std::array<std::uint8_t, 8> request{};
    const auto received = netft::test::receive_from_socket(
        socket_, request.data(), request.size(), 0,
        reinterpret_cast<sockaddr *>(&client), &client_size);
    if (received != static_cast<std::ptrdiff_t>(request.size())) {
      throw std::runtime_error("test UDP request receive failed");
    }

    const auto sent = netft::test::send_to_socket(
        socket_, record.data(), record.size(), 0,
        reinterpret_cast<sockaddr *>(&client), client_size);
    if (sent != static_cast<std::ptrdiff_t>(record.size())) {
      throw std::runtime_error("test UDP record send failed");
    }
    return request;
  }

private:
  netft::test::SocketRuntime runtime_;
  netft::test::NativeSocket socket_{netft::test::kInvalidSocket};
  std::string host_{"127.0.0.1"};
  int port_{};
};

TEST(UdpTransportTest, SendsARequestAndReceivesARecord) {
  FakeUdpPeer peer;
  netft::detail::UdpTransport transport;
  transport.connect(peer.host(), peer.port());

  transport.send(
      netft::detail::encode_request(netft::detail::Command::StartRealtime));
  std::array<std::uint8_t, 36> record{};
  record.front() = 0x45;
  record.back() = 0xab;
  const auto request = peer.reply_with(record);

  std::array<std::uint8_t, 64> bytes{};
  ASSERT_EQ(transport.receive(bytes.data(), bytes.size(), 100ms),
            record.size());
  EXPECT_TRUE(std::equal(record.begin(), record.end(), bytes.begin()));
  EXPECT_EQ(request,
            (std::array<std::uint8_t, 8>{0x12, 0x34, 0x00, 0x02, 0, 0, 0, 0}));
}

TEST(UdpTransportTest, ShutdownInterruptsAWaitAsANonRecordResult) {
  FakeUdpPeer peer;
  netft::detail::UdpTransport transport;
  transport.connect(peer.host(), peer.port());

  std::promise<void> wait_started;
  auto wait_started_future = wait_started.get_future();
  transport.set_wait_started_test_hook(
      [](void *context) noexcept {
        try {
          static_cast<std::promise<void> *>(context)->set_value();
        } catch (...) {
          std::terminate();
        }
      },
      &wait_started);

  std::array<std::uint8_t, 64> bytes{};
  auto pending_receive = std::async(std::launch::async, [&] {
    return transport.receive(bytes.data(), bytes.size(),
                             std::chrono::seconds{5});
  });
  ASSERT_EQ(wait_started_future.wait_for(500ms), std::future_status::ready);
  transport.shutdown();

  ASSERT_EQ(pending_receive.wait_for(500ms), std::future_status::ready);
  EXPECT_EQ(pending_receive.get(), 0U);
  EXPECT_EQ(transport.receive(bytes.data(), bytes.size(), 10ms), 0U);
}

} // namespace
