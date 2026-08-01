cmake_minimum_required(VERSION 3.21)
project(netft_viewer VERSION 0.1.0 LANGUAGES CXX)
set(
  NETFT_VIEWER_CORE_SNAPSHOT
  "95f0e721b885a2fc88e028f41987607747a42085"
  CACHE STRING
  "netft-cpp snapshot identity embedded in the companion"
)
string(LENGTH "${NETFT_VIEWER_CORE_SNAPSHOT}" NETFT_VIEWER_CORE_SNAPSHOT_LENGTH)
if(
  NOT NETFT_VIEWER_CORE_SNAPSHOT_LENGTH EQUAL 40
  OR NOT NETFT_VIEWER_CORE_SNAPSHOT MATCHES "^[0-9a-f]+$"
)
  message(FATAL_ERROR "NETFT_VIEWER_CORE_SNAPSHOT must be a 40-character commit ID")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
include(CTest)
add_subdirectory(core)

option(
  NETFT_VIEWER_BUILD_HARDWARE_TEST
  "Build the opt-in physical sensor verification executable"
  OFF
)
if(NETFT_VIEWER_BUILD_HARDWARE_TEST)
  add_subdirectory(test/hardware)
endif()
