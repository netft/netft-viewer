cmake_minimum_required(VERSION 3.21)
project(netft_viewer_cmake_baseline NONE)

if(NOT NETFT_VIEWER_SOURCE_DIR)
  message(FATAL_ERROR "NETFT_VIEWER_SOURCE_DIR is required")
endif()

set(BUILD_SHARED_LIBS ON CACHE BOOL "")
set(BUILD_TESTING ON CACHE BOOL "")

include("${NETFT_VIEWER_SOURCE_DIR}/cmake/Dependencies.cmake")

if(NOT BUILD_SHARED_LIBS)
  message(FATAL_ERROR "BUILD_SHARED_LIBS was not restored")
endif()
if(NOT BUILD_TESTING)
  message(FATAL_ERROR "BUILD_TESTING was not restored")
endif()
