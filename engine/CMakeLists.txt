cmake_minimum_required(VERSION 3.20)
project(frameflow_film LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(FFE_NATIVE "Tune for the build machine's CPU (-march=native); not portable" OFF)

find_package(Threads REQUIRED)

add_library(ffe_core STATIC
  src/json.cpp
  src/protocol.cpp)
target_include_directories(ffe_core PUBLIC src)
target_link_libraries(ffe_core PUBLIC Threads::Threads)
if(MSVC)
  target_compile_options(ffe_core PRIVATE /W4)
else()
  target_compile_options(ffe_core PRIVATE -Wall -Wextra -Wpedantic -fno-math-errno)
  if(FFE_NATIVE)
    target_compile_options(ffe_core PRIVATE -march=native)
  endif()
endif()

enable_testing()
foreach(t json protocol)
  add_executable(test_${t} tests/test_${t}.cpp)
  target_link_libraries(test_${t} PRIVATE ffe_core)
  add_test(NAME ${t} COMMAND test_${t})
endforeach()
