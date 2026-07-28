add_executable(netft-viewer-hardware-test hardware_test.cpp)
target_compile_features(netft-viewer-hardware-test PRIVATE cxx_std_17)
target_link_libraries(netft-viewer-hardware-test PRIVATE
  netft_viewer_core
  nlohmann_json::nlohmann_json
)
