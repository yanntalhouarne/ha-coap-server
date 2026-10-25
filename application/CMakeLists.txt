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

# Private settings (local.conf, not in git; see local.conf.example), merged after prj.conf
# and alongside any -DEXTRA_CONF_FILE.
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/local.conf)
    set(EXTRA_CONF_FILE ${CMAKE_CURRENT_SOURCE_DIR}/local.conf)
endif()

# Settings from the file named by $HACOAP_EXTRA_CONF (the fleet manager's build profiles),
# merged after local.conf.
if(DEFINED ENV{HACOAP_EXTRA_CONF})
    list(APPEND EXTRA_CONF_FILE $ENV{HACOAP_EXTRA_CONF})
endif()

# MCUboot signing key: $HACOAP_SIGNING_KEY if set, else keys/mcuboot-signing-key.pem
# (not in git; create it with scripts/keygen). MCUboot embeds the public half, and the
# application images are signed with it, so a board only accepts updates signed with the
# key its bootloader was built with. Without a key, the build falls back to MCUboot's
# public development key, which anyone can sign with.
if(NOT DEFINED mcuboot_CONFIG_BOOT_SIGNATURE_KEY_FILE)
    if(DEFINED ENV{HACOAP_SIGNING_KEY})
        get_filename_component(signing_key "$ENV{HACOAP_SIGNING_KEY}" ABSOLUTE)
        if(NOT EXISTS ${signing_key})
            message(FATAL_ERROR "HACOAP_SIGNING_KEY is set, but ${signing_key} does not exist.")
        endif()
    else()
        set(signing_key ${CMAKE_CURRENT_SOURCE_DIR}/keys/mcuboot-signing-key.pem)
    endif()
    if(EXISTS ${signing_key})
        file(TO_CMAKE_PATH "${signing_key}" signing_key)
        set(mcuboot_CONFIG_BOOT_SIGNATURE_KEY_FILE "\"${signing_key}\"")
        message(STATUS "MCUboot signing key: ${signing_key}")
    else()
        message(WARNING "No private signing key (application/keys/mcuboot-signing-key.pem or "
            "HACOAP_SIGNING_KEY). This build uses MCUboot's public development key: anyone can "
            "sign images that it accepts, and boards with a private-key bootloader reject it. "
            "Run scripts/keygen to create your key.")
    endif()
endif()

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

# Thread joiner PSKd: OpenThread silently refuses an invalid one, so check it here.
string(LENGTH "${CONFIG_OPENTHREAD_JOINER_PSKD}" pskd_length)
if(NOT CONFIG_OPENTHREAD_JOINER_PSKD MATCHES "^[0-9A-HJ-NPR-Y]+$" OR pskd_length LESS 6 OR pskd_length GREATER 32)
    message(FATAL_ERROR "CONFIG_OPENTHREAD_JOINER_PSKD (\"${CONFIG_OPENTHREAD_JOINER_PSKD}\") must be "
        "6 to 32 characters, A-Z and 0-9, without I, O, Q and Z. Set it in application/local.conf.")
endif()
if(CONFIG_OPENTHREAD_JOINER_PSKD STREQUAL "J01NU5")
    message(WARNING "The joiner PSKd is the public default J01NU5. Set your own in "
        "application/local.conf (see local.conf.example).")
endif()

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