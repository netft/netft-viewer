add_library(netft_viewer_core STATIC
  src/plot_aggregator.cpp
  src/recorder.cpp
  src/session.cpp
)
target_compile_features(netft_viewer_core PUBLIC cxx_std_17)
target_include_directories(netft_viewer_core PUBLIC include)
target_link_libraries(netft_viewer_core PUBLIC netft_viewer_netft Threads::Threads)

option(NETFT_VIEWER_SANITIZERS "Enable native address and undefined behavior sanitizers" OFF)
if(NETFT_VIEWER_SANITIZERS)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU" AND NOT WIN32)
    add_library(netft_viewer_sanitizers INTERFACE)
    target_compile_options(netft_viewer_sanitizers INTERFACE
      -fno-omit-frame-pointer
      -fsanitize=address,undefined
    )
    target_link_options(netft_viewer_sanitizers INTERFACE
      -fno-omit-frame-pointer
      -fsanitize=address,undefined
    )
    target_link_libraries(netft_viewer_core PUBLIC netft_viewer_sanitizers)
  else()
    message(WARNING
      "NETFT_VIEWER_SANITIZERS is not supported by this compiler/platform combination"
    )
  endif()
endif()

if(BUILD_TESTING)
  FetchContent_MakeAvailable(googletest)
  if(TARGET GTest::gtest_main)
    set(_netft_viewer_gtest_main GTest::gtest_main)
  elseif(TARGET GTest::Main)
    set(_netft_viewer_gtest_main GTest::Main)
  else()
    message(FATAL_ERROR "GoogleTest does not provide a main target")
  endif()

  add_executable(netft_viewer_recording_queue
    ${PROJECT_SOURCE_DIR}/test/core/test_recording_queue.cpp
  )
  target_link_libraries(netft_viewer_recording_queue PRIVATE
    netft_viewer_core
    ${_netft_viewer_gtest_main}
  )
  add_test(NAME RecordingQueue COMMAND netft_viewer_recording_queue)

  add_executable(netft_viewer_recorder
    ${PROJECT_SOURCE_DIR}/test/core/test_recorder.cpp
  )
  target_include_directories(netft_viewer_recorder PRIVATE ${PROJECT_SOURCE_DIR}/test)
  target_link_libraries(netft_viewer_recorder PRIVATE
    netft_viewer_core
    ${_netft_viewer_gtest_main}
  )
  add_test(NAME Recorder COMMAND netft_viewer_recorder)

  add_executable(netft_viewer_plot_aggregator
    ${PROJECT_SOURCE_DIR}/test/core/test_plot_aggregator.cpp
  )
  target_include_directories(netft_viewer_plot_aggregator PRIVATE
    ${PROJECT_SOURCE_DIR}/test
  )
  target_link_libraries(netft_viewer_plot_aggregator PRIVATE
    netft_viewer_core
    ${_netft_viewer_gtest_main}
  )
  add_test(NAME PlotAggregator COMMAND netft_viewer_plot_aggregator)

  add_library(netft_viewer_test_socket INTERFACE)
  target_include_directories(netft_viewer_test_socket INTERFACE
    ${PROJECT_SOURCE_DIR}/core/netft/test
  )
  if(WIN32)
    target_link_libraries(netft_viewer_test_socket INTERFACE ws2_32)
  endif()

  add_executable(netft_viewer_session
    ${PROJECT_SOURCE_DIR}/test/core/test_session.cpp
    ${PROJECT_SOURCE_DIR}/core/netft/test/support/fake_http_server.cpp
    ${PROJECT_SOURCE_DIR}/core/netft/test/support/fake_sensor.cpp
  )
  target_include_directories(netft_viewer_session PRIVATE
    ${PROJECT_SOURCE_DIR}/test
    ${PROJECT_SOURCE_DIR}/core/netft/test
    ${PROJECT_SOURCE_DIR}/core/netft/src
  )
  target_link_libraries(netft_viewer_session PRIVATE
    netft_viewer_core
    netft_viewer_test_socket
    ${_netft_viewer_gtest_main}
  )
  add_test(NAME ViewerSession COMMAND netft_viewer_session)

  add_executable(netft_viewer_hardware_authorization
    ${PROJECT_SOURCE_DIR}/test/core/test_hardware_authorization.cpp
  )
  target_include_directories(netft_viewer_hardware_authorization PRIVATE
    ${PROJECT_SOURCE_DIR}/test/hardware
  )
  target_link_libraries(netft_viewer_hardware_authorization PRIVATE
    ${_netft_viewer_gtest_main}
  )
  add_test(NAME HardwareAuthorization COMMAND netft_viewer_hardware_authorization)
endif()
