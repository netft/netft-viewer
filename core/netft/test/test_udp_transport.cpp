#include "detail/protocol.hpp"
#include "detail/udp_transport.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <future>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

using namespace std::chrono_literals;

#ifdef _WIN32
using NativeSocket = SOCKET;
constexpr NativeSocket kInvalidSocket = INVALID_SOCKET;

class SocketRuntime {
public:
  SocketRuntime() {
    WSADATA data{};
    if (::WSAStartup(MAKEWORD(2, 2), &data) != 0) {
      throw std::runtime_error("test UDP runtime startup failed");
    }
  }

  ~SocketRuntime() { ::WSACleanup(); }
};

void close_socket(const NativeSocket socket) { ::closesocket(socket); }
#else
using NativeSocket = int;
constexpr NativeSocket kInvalidSocket = -1;

class SocketRuntime {};

void close_socket(const NativeSocket socket) { ::close(socket); }
#endif

class FakeUdpPeer {
public:
  FakeUdpPeer() {
    socket_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (socket_ == kInvalidSocket) {
      throw std::runtime_error("test UDP socket creation failed");
    }

#ifdef _WIN32
    const DWORD timeout = 1000;
    static_cast<void>(::setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO,
                                   reinterpret_cast<const char *>(&timeout),
                                   sizeof(timeout)));
#else
    const timeval timeout{1, 0};
    static_cast<void>(::setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO, &timeout,
                                   sizeof(timeout)));
#endif

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::bind(socket_, reinterpret_cast<sockaddr *>(&address),
               sizeof(address)) != 0) {
      close_socket(socket_);
      socket_ = kInvalidSocket;
      throw std::runtime_error("test UDP bind failed");
    }

#ifdef _WIN32
    int address_size = sizeof(address);
#else
    socklen_t address_size = sizeof(address);
#endif
    if (::getsockname(socket_, reinterpret_cast<sockaddr *>(&address),
                      &address_size) != 0) {
      close_socket(socket_);
      socket_ = kInvalidSocket;
      throw std::runtime_error("test UDP getsockname failed");
    }
    port_ = ntohs(address.sin_port);
  }

  ~FakeUdpPeer() {
    if (socket_ != kInvalidSocket) {
      close_socket(socket_);
    }
  }

  FakeUdpPeer(const FakeUdpPeer &) = delete;
  FakeUdpPeer &operator=(const FakeUdpPeer &) = delete;

  const std::string &host() const noexcept { return host_; }
  int port() const noexcept { return port_; }

  std::array<std::uint8_t, 8>
  reply_with(const std::array<std::uint8_t, 36> &record) {
    sockaddr_in client{};
#ifdef _WIN32
    int client_size = sizeof(client);
#else
    socklen_t client_size = sizeof(client);
#endif
    std::array<std::uint8_t, 8> request{};
    const auto received =
        ::recvfrom(socket_, reinterpret_cast<char *>(request.data()),
                   static_cast<int>(request.size()), 0,
                   reinterpret_cast<sockaddr *>(&client), &client_size);
    if (received != static_cast<decltype(received)>(request.size())) {
      throw std::runtime_error("test UDP request receive failed");
    }

    const auto sent =
        ::sendto(socket_, reinterpret_cast<const char *>(record.data()),
                 static_cast<int>(record.size()), 0,
                 reinterpret_cast<sockaddr *>(&client), client_size);
    if (sent != static_cast<decltype(sent)>(record.size())) {
      throw std::runtime_error("test UDP record send failed");
    }
    return request;
  }

private:
  SocketRuntime runtime_;
  NativeSocket socket_{kInvalidSocket};
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

  std::array<std::uint8_t, 64> bytes{};
  auto pending_receive = std::async(std::launch::async, [&] {
    return transport.receive(bytes.data(), bytes.size(),
                             std::chrono::seconds{5});
  });
  std::this_thread::sleep_for(20ms);
  transport.shutdown();

  ASSERT_EQ(pending_receive.wait_for(500ms), std::future_status::ready);
  EXPECT_EQ(pending_receive.get(), 0U);
  EXPECT_EQ(transport.receive(bytes.data(), bytes.size(), 10ms), 0U);
}

} // namespace
