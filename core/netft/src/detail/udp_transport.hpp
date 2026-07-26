#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>

namespace netft::detail {

#ifdef _WIN32
class WinSockRuntime {
public:
  WinSockRuntime();
  ~WinSockRuntime();
  WinSockRuntime(const WinSockRuntime &) = delete;
  WinSockRuntime &operator=(const WinSockRuntime &) = delete;
};
#endif

class UdpTransport {
public:
  UdpTransport() = default;
  ~UdpTransport();
  UdpTransport(const UdpTransport &) = delete;
  UdpTransport &operator=(const UdpTransport &) = delete;

  void connect(const std::string &host, int port);
  void send(std::array<std::uint8_t, 8> request);
  std::size_t receive(std::uint8_t *data, std::size_t capacity,
                      std::chrono::duration<double> timeout);
  void shutdown() noexcept;
  void close() noexcept;

private:
#ifdef _WIN32
  WinSockRuntime runtime_;
#endif
  mutable std::mutex mutex_;
  std::uintptr_t socket_{~std::uintptr_t{0}};
  bool shutdown_requested_{false};
};

} // namespace netft::detail
