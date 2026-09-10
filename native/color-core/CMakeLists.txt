cmake_minimum_required(VERSION 3.20)

project(autocut_color_core LANGUAGES CXX)

# Keep options local to this project when embedded with add_subdirectory().
if(CMAKE_SOURCE_DIR STREQUAL PROJECT_SOURCE_DIR)
    set(AUTOCUT_COLOR_CORE_TOP_LEVEL ON)
else()
    set(AUTOCUT_COLOR_CORE_TOP_LEVEL OFF)
endif()

option(
    AUTOCUT_COLOR_CORE_BUILD_TESTS
    "Build the AutoCut color core tests"
    ${AUTOCUT_COLOR_CORE_TOP_LEVEL}
)

option(
    AUTOCUT_COLOR_CORE_WARNINGS_AS_ERRORS
    "Treat compiler warnings as errors for AutoCut color core targets"
    OFF
)

option(
    AUTOCUT_COLOR_CORE_ENABLE_SANITIZERS
    "Enable AddressSanitizer and UndefinedBehaviorSanitizer"
    OFF
)

# Explicitly static: the core is intended for linking into the native plugin.
# PIC allows linking this library into shared libraries on supported platforms.
add_library(autocut_color_core STATIC
    color_engine.cpp
    color_engine.h
)

add_library(
    AutoCutStudio::color_core
    ALIAS autocut_color_core
)

target_compile_features(autocut_color_core PUBLIC cxx_std_17)

target_include_directories(autocut_color_core
    PUBLIC
        "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>"
)

set_target_properties(autocut_color_core PROPERTIES
    CXX_EXTENSIONS OFF
    POSITION_INDEPENDENT_CODE ON
)

# PRIVATE warning flags do not affect downstream plugin or application sources.
function(autocut_color_core_configure_target target)
    set_target_properties(${target} PROPERTIES
        CXX_EXTENSIONS OFF
    )

    if(MSVC)
        target_compile_options(${target} PRIVATE
            /W4
            /permissive-
            /utf-8
            /EHsc
            /fp:precise
        )

        target_compile_definitions(${target} PRIVATE
            NOMINMAX
            WIN32_LEAN_AND_MEAN
        )

        if(AUTOCUT_COLOR_CORE_WARNINGS_AS_ERRORS)
            target_compile_options(${target} PRIVATE /WX)
        endif()
    elseif(CMAKE_CXX_COMPILER_ID MATCHES "^(GNU|Clang|AppleClang)$")
        target_compile_options(${target} PRIVATE
            -Wall
            -Wextra
            -Wpedantic
            -Wconversion
            -Wsign-conversion
            -Wshadow

            # Analysis relies on meaningful NaN/Infinity checks.
            -fno-fast-math
        )

        if(AUTOCUT_COLOR_CORE_WARNINGS_AS_ERRORS)
            target_compile_options(${target} PRIVATE -Werror)
        endif()
    endif()
endfunction()

autocut_color_core_configure_target(autocut_color_core)

if(AUTOCUT_COLOR_CORE_ENABLE_SANITIZERS)
    if(
        NOT MSVC
        AND CMAKE_CXX_COMPILER_ID MATCHES "^(GNU|Clang|AppleClang)$"
    )
        include(CheckCXXSourceCompiles)
        include(CMakePushCheckState)

        cmake_push_check_state(RESET)
        set(
            CMAKE_REQUIRED_FLAGS
            "-fsanitize=address,undefined -fno-omit-frame-pointer"
        )
        set(
            CMAKE_REQUIRED_LINK_OPTIONS
            "-fsanitize=address,undefined"
        )

        check_cxx_source_compiles(
            "int main() { return 0; }"
            AUTOCUT_COLOR_CORE_SANITIZERS_SUPPORTED
        )
        cmake_pop_check_state()

        if(NOT AUTOCUT_COLOR_CORE_SANITIZERS_SUPPORTED)
            message(FATAL_ERROR
                "The selected compiler/toolchain cannot compile and link "
                "with AddressSanitizer and UndefinedBehaviorSanitizer."
            )
        endif()

        add_library(autocut_color_core_sanitizers INTERFACE)

        target_compile_options(autocut_color_core_sanitizers INTERFACE
            -fsanitize=address,undefined
            -fno-omit-frame-pointer
        )

        target_link_options(autocut_color_core_sanitizers INTERFACE
            -fsanitize=address,undefined
        )

        # Static libraries need their final consumers to link sanitizer runtimes.
        # PUBLIC also instruments test and application consumers when enabled.
        target_link_libraries(autocut_color_core
            PUBLIC autocut_color_core_sanitizers
        )
    else()
        message(FATAL_ERROR
            "AUTOCUT_COLOR_CORE_ENABLE_SANITIZERS requires a supported "
            "GCC or Clang toolchain using the GNU-style command-line interface."
        )
    endif()
endif()

if(AUTOCUT_COLOR_CORE_BUILD_TESTS)
    # For subdirectory builds, the parent must also enable testing at its root
    # for these tests to appear in a root-level CTest invocation.
    enable_testing()

    add_executable(autocut_color_core_tests
        tests/test_color_engine.cpp
    )

    target_link_libraries(autocut_color_core_tests
        PRIVATE AutoCutStudio::color_core
    )

    autocut_color_core_configure_target(autocut_color_core_tests)

    # Preserve assert-based checks in Release and RelWithDebInfo builds.
    if(MSVC)
        target_compile_options(autocut_color_core_tests PRIVATE /UNDEBUG)
    elseif(CMAKE_CXX_COMPILER_ID MATCHES "^(GNU|Clang|AppleClang)$")
        target_compile_options(autocut_color_core_tests PRIVATE -UNDEBUG)
    endif()

    add_test(
        NAME color_core
        COMMAND autocut_color_core_tests
    )

    set_tests_properties(color_core PROPERTIES
        LABELS "unit;color-core"
        TIMEOUT 120
        WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
    )
endif()