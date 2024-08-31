#
# Copyright (c) 2020 Nordic Semiconductor ASA
#
# SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
#

cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(openthread_coap_server)

FILE(GLOB app_sources src/*.c)
# NORDIC SDK APP START
target_sources(app PRIVATE ${app_sources})

target_include_directories(app PRIVATE interface)
# NORDIC SDK APP END

# Add a custom target to generate the version header
add_custom_target(
    generate_version_header
    COMMAND ${CMAKE_COMMAND} -P ${CMAKE_SOURCE_DIR}/scripts/generate_version.cmake
    COMMENT "Generating version header file"
)

# Ensure the version header is generated before the build starts
add_dependencies(app generate_version_header)

# Include the directory where version.h will be generated
include_directories(${CMAKE_BINARY_DIR}/include)