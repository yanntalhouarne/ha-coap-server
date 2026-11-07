/*
 * Yann T.
 *
 * watchdog.h
 */

#ifndef WATCHDOG_H_
#define WATCHDOG_H_

#include <stdbool.h>

/* Whether the watchdog was already running when this image started (a soft reset, such as an
 * update's, while the previous image ran it) */
bool watchdog_was_running_at_boot(void);

/* Starts the hardware watchdog (HACOAP_WDT_TIMEOUT_MS), fed every HACOAP_WDT_FEED_PERIOD_MS
 * from the system work queue. It keeps running in sleep and pauses while a debugger has
 * the CPU halted. */
int watchdog_init(void);

#endif // WATCHDOG_H_
