add_executable(netft_types test_types.cpp)
target_link_libraries(netft_types PRIVATE netft_viewer_netft ${NETFT_GTEST_MAIN_TARGET})

add_test(NAME netft_types COMMAND netft_types)

add_executable(netft_protocol
  test_protocol.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../src/detail/protocol.cpp
)
target_include_directories(netft_protocol PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../src)
target_link_libraries(netft_protocol PRIVATE netft_viewer_netft ${NETFT_GTEST_MAIN_TARGET})

add_test(NAME netft_protocol COMMAND netft_protocol)

add_executable(netft_status test_status.cpp)
target_link_libraries(netft_status PRIVATE netft_viewer_netft ${NETFT_GTEST_MAIN_TARGET})

add_test(NAME netft_status COMMAND netft_status)

add_executable(netft_sequence
  test_sequence.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../src/detail/sequence.cpp
)
target_include_directories(netft_sequence PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../src)
target_link_libraries(netft_sequence PRIVATE netft_viewer_netft ${NETFT_GTEST_MAIN_TARGET})

add_test(NAME netft_sequence COMMAND netft_sequence)

add_executable(netft_fault_latch
  test_fault_latch.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../src/detail/fault_latch.cpp
)
target_include_directories(netft_fault_latch PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../src
)
target_link_libraries(netft_fault_latch PRIVATE netft_viewer_netft ${NETFT_GTEST_MAIN_TARGET})

add_test(NAME netft_fault_latch COMMAND netft_fault_latch)

add_library(netft_test_socket INTERFACE)
target_include_directories(netft_test_socket INTERFACE
  ${CMAKE_CURRENT_SOURCE_DIR}
)
if(WIN32)
  target_link_libraries(netft_test_socket INTERFACE ws2_32)
endif()

add_executable(netft_socket_runtime test_socket_runtime.cpp)
target_link_libraries(netft_socket_runtime PRIVATE
  netft_test_socket
  ${NETFT_GTEST_MAIN_TARGET}
)

add_test(NAME netft_socket_runtime COMMAND netft_socket_runtime)

if(NOT WIN32)
  add_executable(netft_posix_transport
    test_posix_transport.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../src/detail/udp_transport_posix.cpp
  )
  target_compile_features(netft_posix_transport PRIVATE cxx_std_17)
  target_include_directories(netft_posix_transport PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../src
  )
  target_link_options(netft_posix_transport PRIVATE
    "-Wl,--wrap=poll"
    "-Wl,--wrap=recv"
    "-Wl,--wrap=send"
  )
  target_link_libraries(netft_posix_transport PRIVATE ${NETFT_GTEST_MAIN_TARGET})

  add_test(NAME netft_posix_transport COMMAND netft_posix_transport)
endif()

add_executable(netft_udp_transport test_udp_transport.cpp)
target_include_directories(netft_udp_transport PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../src
)
target_link_libraries(netft_udp_transport PRIVATE
  netft_viewer_netft
  netft_test_socket
  ${NETFT_GTEST_MAIN_TARGET}
)

add_test(NAME netft_udp_transport COMMAND netft_udp_transport)

add_executable(netft_discovery
  test_discovery.cpp
  support/fake_http_server.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../src/detail/xml_config.cpp
)
target_include_directories(netft_discovery PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../src
)
target_link_libraries(netft_discovery PRIVATE
  netft_viewer_netft
  netft_test_socket
  ${NETFT_GTEST_MAIN_TARGET}
)

add_test(NAME netft_discovery COMMAND netft_discovery)

add_executable(netft_client_stream
  test_client_stream.cpp
  support/fake_http_server.cpp
  support/fake_sensor.cpp
)
target_include_directories(netft_client_stream PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../src
)
target_link_libraries(netft_client_stream PRIVATE
  netft_viewer_netft
  netft_test_socket
  ${NETFT_GTEST_MAIN_TARGET}
)

add_test(NAME netft_client_stream COMMAND netft_client_stream)

add_executable(netft_client_recovery
  test_client_recovery.cpp
  support/fake_http_server.cpp
  support/fake_sensor.cpp
)
target_include_directories(netft_client_recovery PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../src
)
target_link_libraries(netft_client_recovery PRIVATE
  netft_viewer_netft
  netft_test_socket
  ${NETFT_GTEST_MAIN_TARGET}
)

add_test(NAME netft_client_recovery COMMAND netft_client_recovery)

add_library(netft_client_impl_test STATIC
  ${CMAKE_CURRENT_SOURCE_DIR}/../src/detail/client_impl.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../src/detail/fault_latch.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../src/detail/protocol.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../src/detail/sequence.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../src/detail/xml_config.cpp
)
target_include_directories(netft_client_impl_test PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../src
)
target_link_libraries(netft_client_impl_test PUBLIC netft_viewer_netft)

add_executable(netft_client_lifecycle
  test_client_lifecycle.cpp
  support/fake_http_server.cpp
  support/fake_sensor.cpp
)
target_include_directories(netft_client_lifecycle PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../src
)
target_link_libraries(netft_client_lifecycle PRIVATE
  netft_client_impl_test
  netft_test_socket
  ${NETFT_GTEST_MAIN_TARGET}
)

add_test(NAME netft_client_lifecycle COMMAND netft_client_lifecycle)
