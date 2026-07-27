#pragma once

#include <string_view>

namespace netft_viewer::hardware {

inline bool bias_authorized(const char *allow_bias,
                            const char *confirm_bias) noexcept {
  return allow_bias != nullptr && confirm_bias != nullptr &&
         std::string_view{allow_bias} == "1" &&
         std::string_view{confirm_bias} == "YES";
}

} // namespace netft_viewer::hardware
