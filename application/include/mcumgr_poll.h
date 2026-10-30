/*
 * Yann T.
 *
 * mcumgr_poll.h
 */

#ifndef MCUMGR_POLL_H_
#define MCUMGR_POLL_H_

#include <stdint.h>

/* From the first mcumgr request (USB or UDP), polls the Thread parent every
 * HACOAP_MCUMGR_POLL_PERIOD_MS instead of CONFIG_OPENTHREAD_POLL_PERIOD, until
 * HACOAP_MCUMGR_POLL_TIMEOUT_S after the last request. */
void mcumgr_poll_init(void);

/* Polls fast now, and until HACOAP_MCUMGR_POLL_TIMEOUT_S from now, as for an mcumgr request.
 * For other requests that come in a series ('log' reads). Callable from any thread. */
void mcumgr_poll_hold(void);

/* Sets the poll period used when not polling fast (the 'poll_ms' setting), and applies it
 * unless polling fast now. Callable from any thread. */
void mcumgr_poll_set_normal_period(uint32_t period_ms);

#endif // MCUMGR_POLL_H_
