#pragma once

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>

namespace netft::test {

#ifdef _WIN32
using NativeSocket = SOCKET;
using SocketLength = int;
constexpr NativeSocket kInvalidSocket = INVALID_SOCKET;
constexpr int kShutdownBoth = SD_BOTH;
#else
using NativeSocket = int;
using SocketLength = socklen_t;
constexpr NativeSocket kInvalidSocket = -1;
constexpr int kShutdownBoth = SHUT_RDWR;
#endif

class SocketRuntime {
public:
  SocketRuntime() {
#ifdef _WIN32
    WSADATA data{};
    const int result = ::WSAStartup(MAKEWORD(2, 2), &data);
    if (result != 0) {
      throw std::runtime_error("test WinSock startup failed (error " + std::to_string(result) +
                               ")");
    }
#endif
  }

  ~SocketRuntime() {
#ifdef _WIN32
    ::WSACleanup();
#endif
  }

  SocketRuntime(const SocketRuntime &) = delete;
  SocketRuntime &operator=(const SocketRuntime &) = delete;
};

inline bool socket_is_valid(const NativeSocket socket) noexcept { return socket != kInvalidSocket; }

inline NativeSocket create_socket(const int family, const int type, const int protocol) noexcept {
  return ::socket(family, type, protocol);
}

inline void close_socket(NativeSocket &socket) noexcept {
  if (!socket_is_valid(socket)) {
    return;
  }
#ifdef _WIN32
  static_cast<void>(::closesocket(socket));
#else
  static_cast<void>(::close(socket));
#endif
  socket = kInvalidSocket;
}

inline void shutdown_socket(const NativeSocket socket) noexcept {
  if (socket_is_valid(socket)) {
    static_cast<void>(::shutdown(socket, kShutdownBoth));
  }
}

inline bool set_socket_nonblocking(const NativeSocket socket) noexcept {
#ifdef _WIN32
  u_long enabled = 1;
  return ::ioctlsocket(socket, FIONBIO, &enabled) != SOCKET_ERROR;
#else
  const int flags = ::fcntl(socket, F_GETFL, 0);
  return flags >= 0 && ::fcntl(socket, F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

inline bool set_socket_receive_timeout(const NativeSocket socket,
                                       const std::chrono::milliseconds timeout) noexcept {
#ifdef _WIN32
  const auto bounded = std::min<std::int64_t>(timeout.count(), std::numeric_limits<DWORD>::max());
  const DWORD milliseconds = static_cast<DWORD>(std::max<std::int64_t>(0, bounded));
  return ::setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO,
                      reinterpret_cast<const char *>(&milliseconds), sizeof(milliseconds)) == 0;
#else
  const auto seconds = std::chrono::duration_cast<std::chrono::seconds>(timeout);
  const auto microseconds =
      std::chrono::duration_cast<std::chrono::microseconds>(timeout - seconds);
  const timeval value{static_cast<time_t>(seconds.count()),
                      static_cast<suseconds_t>(microseconds.count())};
  return ::setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &value, sizeof(value)) == 0;
#endif
}

inline bool set_socket_reuse_address(const NativeSocket socket) noexcept {
  const int enabled = 1;
#ifdef _WIN32
  return ::setsockopt(socket, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char *>(&enabled),
                      sizeof(enabled)) == 0;
#else
  return ::setsockopt(socket, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled)) == 0;
#endif
}

inline std::string socket_error_message(const char *operation) {
#ifdef _WIN32
  return std::string{operation} + " (WinSock error " + std::to_string(::WSAGetLastError()) + ")";
#else
  return std::string{operation} + ": " + std::strerror(errno);
#endif
}

inline int socket_send_flags() noexcept {
#ifdef MSG_NOSIGNAL
  return MSG_NOSIGNAL;
#else
  return 0;
#endif
}

inline std::size_t socket_io_size(const std::size_t size) noexcept {
#ifdef _WIN32
  return std::min(size, static_cast<std::size_t>(std::numeric_limits<int>::max()));
#else
  return size;
#endif
}

inline std::ptrdiff_t send_socket(const NativeSocket socket, const void *data,
                                  const std::size_t size, const int flags = 0) noexcept {
  const auto bounded_size = socket_io_size(size);
#ifdef _WIN32
  return static_cast<std::ptrdiff_t>(
      ::send(socket, static_cast<const char *>(data), static_cast<int>(bounded_size), flags));
#else
  return static_cast<std::ptrdiff_t>(::send(socket, data, bounded_size, flags));
#endif
}

inline std::ptrdiff_t receive_socket(const NativeSocket socket, void *data, const std::size_t size,
                                     const int flags = 0) noexcept {
  const auto bounded_size = socket_io_size(size);
#ifdef _WIN32
  return static_cast<std::ptrdiff_t>(
      ::recv(socket, static_cast<char *>(data), static_cast<int>(bounded_size), flags));
#else
  return static_cast<std::ptrdiff_t>(::recv(socket, data, bounded_size, flags));
#endif
}

inline std::ptrdiff_t send_to_socket(const NativeSocket socket, const void *data,
                                     const std::size_t size, const int flags,
                                     const sockaddr *address,
                                     const SocketLength address_size) noexcept {
  const auto bounded_size = socket_io_size(size);
#ifdef _WIN32
  return static_cast<std::ptrdiff_t>(::sendto(socket, static_cast<const char *>(data),
                                              static_cast<int>(bounded_size), flags, address,
                                              address_size));
#else
  return static_cast<std::ptrdiff_t>(
      ::sendto(socket, data, bounded_size, flags, address, address_size));
#endif
}

inline std::ptrdiff_t receive_from_socket(const NativeSocket socket, void *data,
                                          const std::size_t size, const int flags,
                                          sockaddr *address, SocketLength *address_size) noexcept {
  const auto bounded_size = socket_io_size(size);
#ifdef _WIN32
  return static_cast<std::ptrdiff_t>(::recvfrom(socket, static_cast<char *>(data),
                                                static_cast<int>(bounded_size), flags, address,
                                                address_size));
#else
  return static_cast<std::ptrdiff_t>(
      ::recvfrom(socket, data, bounded_size, flags, address, address_size));
#endif
}

} // namespace netft::test
