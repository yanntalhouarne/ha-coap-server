/*
 * Yann T.
 *
 * log_buffer.h
 *
 * The latest log output, kept in RAM for the 'log' CoAP resource (CONFIG_HACOAP_REMOTE_LOG).
 * The remote_log backend writes the formatted lines here, and a reader asks for them by
 * offset: the number of bytes written since boot. A reader that keeps the end offset of
 * each answer and asks from there gets every byte once, as long as it reads faster than
 * the buffer (CONFIG_HACOAP_REMOTE_LOG_BUFFER_SIZE) fills.
 */

#ifndef LOG_BUFFER_H_
#define LOG_BUFFER_H_

#include <stddef.h>
#include <stdint.h>

/* Appends log output. Bytes older than the buffer's size are overwritten. */
void log_buffer_write(const uint8_t *data, size_t length);

/* Writes the 'log' payload for a reader that has everything before offset 'from':
 *
 *     "<boot id> <start>\n<text>"
 *
 * The boot id (8 hex digits) is new at every boot: a reader that sees it change starts
 * again from 0. 'start' (decimal) is the offset of the first byte of 'text', which is later
 * than 'from' when the bytes in between were overwritten, and the oldest kept byte when
 * 'from' is ahead of the log (a reader from before a restart). 'text' fills the rest of
 * 'size' at most. Returns the payload's length (no NUL terminator). */
size_t log_buffer_read(uint32_t from, char *payload, size_t size);

#endif // LOG_BUFFER_H_
