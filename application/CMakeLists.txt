#
# Copyright (c) 2020 Nordic Semiconductor ASA
#
# SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
#

cmake_minimum_required(VERSION 3.20.0)

# The hacoap board lives in this application (boards/arm/hacoap), so no -DBOARD_ROOT is needed,
# and it is the default board, so '-b hacoap' is optional.
list(APPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})
if(NOT DEFINED BOARD AND NOT DEFINED ENV{BOARD})
    set(BOARD hacoap)
endif()

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(openthread_coap_server)

FILE(GLOB app_sources src/*.c)
# NORDIC SDK APP START
target_sources(app PRIVATE ${app_sources})
target_include_directories(app PRIVATE include)
# NORDIC SDK APP END

# Generate include/version.h (the git commit, reported in the 'info' resource) at every build
add_custom_target(
    generate_version_header
    COMMAND ${CMAKE_COMMAND}
        -DSOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR}
        -DHEADER_FILE=${CMAKE_BINARY_DIR}/include/version.h
        -P ${CMAKE_CURRENT_SOURCE_DIR}/scripts/generate_version.cmake
    COMMENT "Generating version header file"
)

# Ensure the version header is generated before the build starts
add_dependencies(app generate_version_header)

# Include the directory where version.h will be generated
include_directories(${CMAKE_BINARY_DIR}/include)