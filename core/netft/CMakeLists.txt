add_library(netft_viewer_netft STATIC
  src/types.cpp
  src/status.cpp
  src/discovery.cpp
  src/client.cpp
  src/detail/client_impl.cpp
  src/detail/fault_latch.cpp
  src/detail/protocol.cpp
  src/detail/sequence.cpp
  src/detail/xml_config.cpp
)
if(WIN32)
  target_sources(netft_viewer_netft PRIVATE src/detail/udp_transport_windows.cpp)
  target_link_libraries(netft_viewer_netft PRIVATE ws2_32)
else()
  target_sources(netft_viewer_netft PRIVATE src/detail/udp_transport_posix.cpp)
endif()
target_compile_definitions(netft_viewer_netft PRIVATE NETFT_BUILDING_LIBRARY)
target_compile_features(netft_viewer_netft PUBLIC cxx_std_17)
target_include_directories(netft_viewer_netft PUBLIC include PRIVATE src)
target_link_libraries(netft_viewer_netft PUBLIC Threads::Threads CURL::libcurl)

if(BUILD_TESTING)
  FetchContent_MakeAvailable(googletest)
  if(TARGET GTest::gtest_main)
    set(NETFT_GTEST_MAIN_TARGET GTest::gtest_main)
  elseif(TARGET GTest::Main)
    set(NETFT_GTEST_MAIN_TARGET GTest::Main)
  else()
    message(FATAL_ERROR "GoogleTest does not provide a main target")
  endif()
  add_subdirectory(test)
endif()
