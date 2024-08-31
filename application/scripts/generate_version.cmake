# scripts/generate_version.cmake

# Get the latest Git commit hash
execute_process(
    COMMAND git rev-parse --short HEAD
    OUTPUT_VARIABLE GIT_COMMIT_HASH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
    RESULT_VARIABLE GIT_RESULT
)

if(GIT_RESULT)
    message(FATAL_ERROR "Failed to get Git commit hash. Ensure you are in a Git repository and Git is installed.")
endif()

# Define the output file
set(HEADER_FILE "${CMAKE_BINARY_DIR}/include/version.h")

# Ensure the directory exists
file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/include")

# Create the version header file
file(WRITE "${HEADER_FILE}" "#ifndef VERSION_H\n")
file(APPEND "${HEADER_FILE}" "#define VERSION_H\n")
file(APPEND "${HEADER_FILE}" "\n")
file(APPEND "${HEADER_FILE}" "#define GIT_COMMIT_HASH \"${GIT_COMMIT_HASH}\"\n")
file(APPEND "${HEADER_FILE}" "\n")
file(APPEND "${HEADER_FILE}" "#endif // VERSION_H\n")

message(STATUS "Generated version header file at: ${HEADER_FILE}")
