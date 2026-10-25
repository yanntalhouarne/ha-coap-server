# scripts/generate_version.cmake
#
# Writes HEADER_FILE with GIT_COMMIT_HASH, the short commit of the repository that holds
# SOURCE_DIR. Falls back to "unknown" without git (for example a ZIP download), and only
# rewrites the file when the hash changes, so unchanged builds don't recompile.
#
# Usage: cmake -DSOURCE_DIR=<dir> -DHEADER_FILE=<file> -P generate_version.cmake

execute_process(
    COMMAND git rev-parse --short HEAD
    WORKING_DIRECTORY "${SOURCE_DIR}"
    OUTPUT_VARIABLE GIT_COMMIT_HASH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
    RESULT_VARIABLE GIT_RESULT
)

if(GIT_RESULT OR NOT GIT_COMMIT_HASH)
    message(WARNING "Could not get the git commit hash; the firmware version will be \"unknown\".")
    set(GIT_COMMIT_HASH "unknown")
endif()

set(CONTENT "#ifndef VERSION_H\n#define VERSION_H\n\n#define GIT_COMMIT_HASH \"${GIT_COMMIT_HASH}\"\n\n#endif // VERSION_H\n")

if(EXISTS "${HEADER_FILE}")
    file(READ "${HEADER_FILE}" OLD_CONTENT)
endif()
if(NOT "${OLD_CONTENT}" STREQUAL "${CONTENT}")
    file(WRITE "${HEADER_FILE}" "${CONTENT}")
    message(STATUS "Firmware version: ${GIT_COMMIT_HASH}")
endif()
