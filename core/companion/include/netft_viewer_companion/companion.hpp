#pragma once

#include <iosfwd>
#include <memory>

namespace netft_viewer::companion {

struct CompanionOptions {
  int rdt_port{49152};
  int http_port{80};
};

class Companion {
public:
  explicit Companion(CompanionOptions options = {});
  ~Companion();

  Companion(const Companion &) = delete;
  Companion &operator=(const Companion &) = delete;

  int run(std::istream &commands, std::ostream &events, std::ostream &logs);
  int run_standard_io(std::ostream &events, std::ostream &logs);

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace netft_viewer::companion
