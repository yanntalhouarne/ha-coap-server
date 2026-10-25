/*
 * Yann T.
 *
 * watchdog.h
 */

#ifndef WATCHDOG_H_
#define WATCHDOG_H_

/* Starts the hardware watchdog (HACOAP_WDT_TIMEOUT_MS), fed every HACOAP_WDT_FEED_PERIOD_MS
 * from the system work queue. It keeps running in sleep and pauses while a debugger has
 * the CPU halted. */
int watchdog_init(void);

#endif // WATCHDOG_H_
