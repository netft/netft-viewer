include(FetchContent)

# CMake 3.21--3.29 does not reliably diagnose missing disconnected sources.
if(FETCHCONTENT_FULLY_DISCONNECTED)
  set(_offline_dependencies curl nlohmann_json)
  if(BUILD_TESTING)
    list(APPEND _offline_dependencies googletest)
  endif()
  foreach(_dependency IN LISTS _offline_dependencies)
    string(TOUPPER "${_dependency}" _dependency_upper)
    set(_source "${FETCHCONTENT_BASE_DIR}/${_dependency}-src")
    if(FETCHCONTENT_SOURCE_DIR_${_dependency_upper})
      set(_source "${FETCHCONTENT_SOURCE_DIR_${_dependency_upper}}")
    endif()
    if(NOT EXISTS "${_source}/CMakeLists.txt")
      message(FATAL_ERROR "Offline dependency ${_dependency} is missing at ${_source}. Populate the pinned FetchContent cache online or set FETCHCONTENT_SOURCE_DIR_${_dependency_upper} to verified sources; see CONTRIBUTING.md.")
    endif()
  endforeach()
endif()

set(_netft_viewer_build_shared_libs_defined FALSE)
if(DEFINED BUILD_SHARED_LIBS)
  set(_netft_viewer_build_shared_libs_defined TRUE)
  set(_netft_viewer_build_shared_libs "${BUILD_SHARED_LIBS}")
endif()
get_property(
  _netft_viewer_build_shared_libs_cached
  CACHE BUILD_SHARED_LIBS
  PROPERTY TYPE
  SET
)

set(_netft_viewer_build_testing_defined FALSE)
if(DEFINED BUILD_TESTING)
  set(_netft_viewer_build_testing_defined TRUE)
  set(_netft_viewer_build_testing "${BUILD_TESTING}")
endif()
get_property(
  _netft_viewer_build_testing_cached
  CACHE BUILD_TESTING
  PROPERTY TYPE
  SET
)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_CURL_EXE OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(BUILD_LIBCURL_DOCS OFF CACHE BOOL "" FORCE)
set(BUILD_MISC_DOCS OFF CACHE BOOL "" FORCE)
set(HTTP_ONLY ON CACHE BOOL "" FORCE)
set(CURL_BROTLI OFF CACHE STRING "" FORCE)
set(CURL_ENABLE_SSL OFF CACHE BOOL "" FORCE)
set(CURL_USE_LIBSSH2 OFF CACHE BOOL "" FORCE)
set(CURL_USE_LIBPSL OFF CACHE BOOL "" FORCE)
set(CURL_USE_PKGCONFIG OFF CACHE BOOL "" FORCE)
set(CURL_ZLIB OFF CACHE BOOL "" FORCE)
set(CURL_ZSTD OFF CACHE STRING "" FORCE)
set(USE_LIBIDN2 OFF CACHE BOOL "" FORCE)
set(USE_NGHTTP2 OFF CACHE BOOL "" FORCE)
if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW)
endif()
FetchContent_Declare(curl
  URL https://curl.se/download/curl-8.21.0.tar.xz
  URL_HASH SHA256=aa1b66a70eace83dc624508745646c08ae561de512ab403adffb93ac87fc72e6
)
FetchContent_MakeAvailable(curl)

if(_netft_viewer_build_shared_libs_cached)
  set(BUILD_SHARED_LIBS "${_netft_viewer_build_shared_libs}" CACHE BOOL "" FORCE)
else()
  unset(BUILD_SHARED_LIBS CACHE)
  if(_netft_viewer_build_shared_libs_defined)
    set(BUILD_SHARED_LIBS "${_netft_viewer_build_shared_libs}")
  else()
    unset(BUILD_SHARED_LIBS)
  endif()
endif()

if(_netft_viewer_build_testing_cached)
  set(BUILD_TESTING "${_netft_viewer_build_testing}" CACHE BOOL "" FORCE)
else()
  unset(BUILD_TESTING CACHE)
  if(_netft_viewer_build_testing_defined)
    set(BUILD_TESTING "${_netft_viewer_build_testing}")
  else()
    unset(BUILD_TESTING)
  endif()
endif()

FetchContent_Declare(googletest
  GIT_REPOSITORY https://github.com/google/googletest.git
  GIT_TAG 52eb8108c5bdec04579160ae17225d66034bd723 # v1.17.0
)

FetchContent_Declare(nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG 55f93686c01528224f448c19128836e7df245f72
)
