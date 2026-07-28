#include "support/fake_http_server.hpp"
#include "support/socket_runtime.hpp"

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <utility>

namespace {

using netft::test::NativeSocket;

int wait_for_readable(const NativeSocket socket) noexcept {
  fd_set readable;
  FD_ZERO(&readable);
  FD_SET(socket, &readable);
  timeval timeout{};
  timeout.tv_usec = 50'000;
#ifdef _WIN32
  return ::select(0, &readable, nullptr, nullptr, &timeout);
#else
  return ::select(socket + 1, &readable, nullptr, nullptr, &timeout);
#endif
}

void send_all(const NativeSocket socket, std::string_view data) noexcept {
  while (!data.empty()) {
    const auto sent = netft::test::send_socket(
        socket, data.data(), data.size(), netft::test::socket_send_flags());
    if (sent <= 0) {
      return;
    }
    data.remove_prefix(static_cast<std::size_t>(sent));
  }
}

} // namespace

struct FakeHttpServer::Impl {
  explicit Impl(std::string initial_body, int initial_status)
      : body(std::move(initial_body)), status(initial_status) {
    listener = netft::test::create_socket(AF_INET, SOCK_STREAM, 0);
    if (!netft::test::socket_is_valid(listener)) {
      throw std::runtime_error("failed to create fake HTTP server socket");
    }

    static_cast<void>(netft::test::set_socket_reuse_address(listener));

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = 0;
    if (::bind(listener, reinterpret_cast<const sockaddr *>(&address),
               static_cast<netft::test::SocketLength>(sizeof(address))) != 0 ||
        ::listen(listener, 8) != 0) {
      const auto error =
          netft::test::socket_error_message("fake HTTP server bind failed");
      netft::test::close_socket(listener);
      throw std::runtime_error("failed to bind fake HTTP server: " + error);
    }

    netft::test::SocketLength address_length = sizeof(address);
    if (::getsockname(listener, reinterpret_cast<sockaddr *>(&address),
                      &address_length) != 0) {
      const auto error = netft::test::socket_error_message(
          "fake HTTP server getsockname failed");
      netft::test::close_socket(listener);
      throw std::runtime_error("failed to inspect fake HTTP server: " + error);
    }
    listening_port = ntohs(address.sin_port);
    worker = std::thread([this] { serve(); });
  }

  ~Impl() {
    stopping.store(true);
    response_changed.notify_all();
    if (netft::test::socket_is_valid(listener)) {
      netft::test::shutdown_socket(listener);
      auto listener_to_close = listener;
      netft::test::close_socket(listener_to_close);
    }
    {
      std::lock_guard<std::mutex> lock(active_client_mutex);
      netft::test::shutdown_socket(active_client);
    }
    if (worker.joinable()) {
      worker.join();
    }
    listener = netft::test::kInvalidSocket;
  }

  void serve() noexcept {
    while (!stopping.load()) {
      auto client = ::accept(listener, nullptr, nullptr);
      if (!netft::test::socket_is_valid(client)) {
        if (stopping.load()) {
          return;
        }
        continue;
      }
      {
        std::lock_guard<std::mutex> lock(active_client_mutex);
        active_client = client;
      }
      accepted_connections.fetch_add(1);
      if (stopping.load()) {
        netft::test::shutdown_socket(client);
      }
      handle_request(client);
      {
        std::lock_guard<std::mutex> lock(active_client_mutex);
        netft::test::close_socket(active_client);
      }
    }
  }

  void handle_request(const NativeSocket client) noexcept {
    std::string request;
    char buffer[1024];
    while (request.size() < 8192 &&
           request.find("\r\n\r\n") == std::string::npos) {
      if (stopping.load()) {
        return;
      }
      const int readiness = wait_for_readable(client);
      if (readiness < 0) {
        return;
      }
      if (readiness == 0) {
        continue;
      }
      const auto received =
          netft::test::receive_socket(client, buffer, sizeof(buffer));
      if (received <= 0) {
        return;
      }
      request.append(buffer, static_cast<std::size_t>(received));
    }
    requests.fetch_add(1);

    std::string response_body;
    std::string response_location;
    int response_status{};
    std::chrono::milliseconds response_delay{};
    {
      std::lock_guard<std::mutex> lock(response_mutex);
      response_body = body;
      response_location = redirect_location;
      response_status = status;
      response_delay = delay;
    }

    if (request.rfind("GET /netftapi2.xml ", 0) != 0) {
      response_body.clear();
      response_status = 404;
    }

    if (response_delay.count() > 0) {
      std::unique_lock<std::mutex> lock(response_mutex);
      if (response_changed.wait_for(lock, response_delay,
                                    [this] { return stopping.load(); })) {
        return;
      }
    }

    const std::string reason = response_status == 200 ? "OK" : "Error";
    const std::string location_header =
        response_location.empty() ? std::string{}
                                  : "Location: " + response_location + "\r\n";
    const std::string headers =
        "HTTP/1.1 " + std::to_string(response_status) + " " + reason + "\r\n" +
        "Content-Type: application/xml\r\n" + location_header +
        "Content-Length: " + std::to_string(response_body.size()) + "\r\n" +
        "Connection: close\r\n\r\n";
    send_all(client, headers);
    send_all(client, response_body);
  }

  std::string body;
  std::string redirect_location;
  int status;
  std::chrono::milliseconds delay{};
  std::mutex response_mutex;
  std::condition_variable response_changed;
  std::atomic<bool> stopping{false};
  std::atomic<std::uint64_t> requests{0};
  std::atomic<std::uint64_t> accepted_connections{0};
  netft::test::SocketRuntime runtime;
  std::mutex active_client_mutex;
  NativeSocket active_client{netft::test::kInvalidSocket};
  NativeSocket listener{netft::test::kInvalidSocket};
  int listening_port{};
  std::thread worker;
};

FakeHttpServer::FakeHttpServer(std::string body, int status)
    : impl_(std::make_unique<Impl>(std::move(body), status)) {}

FakeHttpServer::~FakeHttpServer() = default;

std::string FakeHttpServer::host() const { return "127.0.0.1"; }

int FakeHttpServer::port() const { return impl_->listening_port; }

std::uint64_t FakeHttpServer::request_count() const noexcept {
  return impl_->requests.load();
}

std::uint64_t FakeHttpServer::accepted_connection_count() const noexcept {
  return impl_->accepted_connections.load();
}

void FakeHttpServer::set_response(std::string body, int status) {
  std::lock_guard<std::mutex> lock(impl_->response_mutex);
  impl_->body = std::move(body);
  impl_->status = status;
}

void FakeHttpServer::set_response_delay(std::chrono::milliseconds delay) {
  std::lock_guard<std::mutex> lock(impl_->response_mutex);
  impl_->delay = delay;
}

void FakeHttpServer::set_redirect_location(std::string location) {
  std::lock_guard<std::mutex> lock(impl_->response_mutex);
  impl_->redirect_location = std::move(location);
}
