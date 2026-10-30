/*
 * Yann T.
 *
 * mcumgr_poll.h
 */

#ifndef MCUMGR_POLL_H_
#define MCUMGR_POLL_H_

/* From the first mcumgr request (USB or UDP), polls the Thread parent every
 * HACOAP_MCUMGR_POLL_PERIOD_MS instead of CONFIG_OPENTHREAD_POLL_PERIOD, until
 * HACOAP_MCUMGR_POLL_TIMEOUT_S after the last request. */
void mcumgr_poll_init(void);

/* Polls fast now, and until HACOAP_MCUMGR_POLL_TIMEOUT_S from now, as for an mcumgr request.
 * For other requests that come in a series ('log' reads). Callable from any thread. */
void mcumgr_poll_hold(void);

#endif // MCUMGR_POLL_H_
