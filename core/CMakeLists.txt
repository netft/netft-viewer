include("${PROJECT_SOURCE_DIR}/cmake/Dependencies.cmake")

find_package(Threads REQUIRED)

add_subdirectory(netft)
add_subdirectory(viewer)
add_subdirectory(companion)
