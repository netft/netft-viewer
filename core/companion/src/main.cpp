#include "netft_viewer_companion/companion.hpp"

#include <charconv>
#include <csignal>
#include <cstdio>
#include <iostream>
#include <string_view>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

bool parse_port(std::string_view argument, std::string_view name, int &port) {
  if (argument.substr(0, name.size()) != name) {
    return false;
  }
  const auto value = argument.substr(name.size());
  int parsed{};
  const auto result =
      std::from_chars(value.data(), value.data() + value.size(), parsed);
  if (result.ec != std::errc{} || result.ptr != value.data() + value.size() ||
      parsed < 1 || parsed > 65'535) {
    return false;
  }
  port = parsed;
  return true;
}

} // namespace

int main(int argc, char **argv) {
#ifdef _WIN32
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 ||
      _setmode(_fileno(stdout), _O_BINARY) == -1) {
    std::cerr << "failed to configure binary standard streams\n";
    return 2;
  }
#else
  std::signal(SIGPIPE, SIG_IGN);
#endif

  netft_viewer::companion::CompanionOptions options;
  for (int index = 1; index < argc; ++index) {
    const std::string_view argument{argv[index]};
    if (!parse_port(argument, "--rdt-port=", options.rdt_port) &&
        !parse_port(argument, "--http-port=", options.http_port)) {
      std::cerr << "invalid companion option\n";
      return 2;
    }
  }
  netft_viewer::companion::Companion companion{options};
  try {
    return companion.run(std::cin, std::cout, std::cerr);
  } catch (...) {
    std::cerr << "companion process failed\n";
    return 2;
  }
}
