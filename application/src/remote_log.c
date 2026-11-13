/*
 * Yann T.
 *
 * remote_log.c
 *
 * A log backend that formats each log message into log_buffer, where the 'log' CoAP
 * resource reads it (CONFIG_HACOAP_REMOTE_LOG). It runs in the logging thread, alongside
 * any other backend (USB or UART console).
 */

#include <zephyr/logging/log_backend.h>
#include <zephyr/logging/log_backend_std.h>
#include <zephyr/logging/log_output.h>

#include "log_buffer.h"

#define OUTPUT_FLAGS (LOG_OUTPUT_FLAG_LEVEL | LOG_OUTPUT_FLAG_TIMESTAMP | LOG_OUTPUT_FLAG_FORMAT_TIMESTAMP | \
		      LOG_OUTPUT_FLAG_CRLF_LFONLY)

static uint8_t output_buf[64];

static int write_output(uint8_t *data, size_t length, void *ctx)
{
	ARG_UNUSED(ctx);

	log_buffer_write(data, length);
	return (int)length;
}

LOG_OUTPUT_DEFINE(remote_log_output, write_output, output_buf, sizeof(output_buf));

static void process(const struct log_backend *const backend, union log_msg_generic *msg)
{
	ARG_UNUSED(backend);

	log_output_msg_process(&remote_log_output, &msg->log, OUTPUT_FLAGS);
}

static void panic(const struct log_backend *const backend)
{
	ARG_UNUSED(backend);

	log_backend_std_panic(&remote_log_output);
}

static void dropped(const struct log_backend *const backend, uint32_t cnt)
{
	ARG_UNUSED(backend);

	log_backend_std_dropped(&remote_log_output, cnt);
}

static const struct log_backend_api remote_log_api = {
	.process = process,
	.panic = panic,
	.dropped = dropped,
};

LOG_BACKEND_DEFINE(remote_log, remote_log_api, true);
