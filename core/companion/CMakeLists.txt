FetchContent_MakeAvailable(nlohmann_json)

add_library(netft_viewer_companion_protocol STATIC src/protocol.cpp)
target_compile_features(netft_viewer_companion_protocol PUBLIC cxx_std_17)
target_include_directories(netft_viewer_companion_protocol PUBLIC include)
target_link_libraries(netft_viewer_companion_protocol
  PUBLIC netft_viewer_core
  PRIVATE
  nlohmann_json::nlohmann_json
)

add_library(netft_viewer_companion_runtime STATIC src/companion.cpp)
target_compile_features(netft_viewer_companion_runtime PUBLIC cxx_std_17)
target_include_directories(netft_viewer_companion_runtime PUBLIC include)
target_compile_definitions(netft_viewer_companion_runtime PRIVATE
  NETFT_VIEWER_APP_VERSION="${PROJECT_VERSION}"
  NETFT_VIEWER_CORE_SNAPSHOT="${NETFT_VIEWER_CORE_SNAPSHOT}"
)
target_link_libraries(netft_viewer_companion_runtime
  PUBLIC netft_viewer_companion_protocol
)

add_executable(netft-viewer-companion src/main.cpp)
target_compile_features(netft-viewer-companion PRIVATE cxx_std_17)
target_link_libraries(netft-viewer-companion
  PRIVATE netft_viewer_companion_runtime
)

if(BUILD_TESTING)
  if(TARGET GTest::gtest_main)
    set(_netft_viewer_protocol_gtest_main GTest::gtest_main)
  elseif(TARGET GTest::Main)
    set(_netft_viewer_protocol_gtest_main GTest::Main)
  else()
    message(FATAL_ERROR "GoogleTest does not provide a main target")
  endif()

  add_executable(netft_viewer_protocol
    ${PROJECT_SOURCE_DIR}/test/companion/test_protocol.cpp
  )
  target_compile_definitions(netft_viewer_protocol PRIVATE
    NETFT_VIEWER_SOURCE_DIR="${PROJECT_SOURCE_DIR}"
  )
  target_link_libraries(netft_viewer_protocol PRIVATE
    netft_viewer_companion_protocol
    nlohmann_json::nlohmann_json
    ${_netft_viewer_protocol_gtest_main}
  )
  add_test(NAME Protocol COMMAND netft_viewer_protocol)

  add_executable(netft_viewer_companion
    ${PROJECT_SOURCE_DIR}/test/companion/test_companion.cpp
  )
  target_link_libraries(netft_viewer_companion PRIVATE
    netft_viewer_companion_runtime
    nlohmann_json::nlohmann_json
    ${_netft_viewer_protocol_gtest_main}
  )
  add_test(NAME Companion COMMAND netft_viewer_companion)
endif()
