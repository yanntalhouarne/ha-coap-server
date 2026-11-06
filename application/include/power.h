/*
 * Yann T.
 *
 * power.h
 *
 * Where the board's power comes from: the battery, or USB (charging, or charged), reported
 * in 'diag'. On USB the board polls its parent faster (see mcumgr_poll.h).
 */

#ifndef POWER_H_
#define POWER_H_

#include <stdbool.h>

enum power_source
{
	POWER_BATTERY,  // no USB power
	POWER_USB,      // USB power, charge state unknown (the charger's CHRG pin can't be read)
	POWER_CHARGING, // USB power, the charger is charging the battery
	POWER_CHARGED,  // USB power, the charger is done (or has no battery)
};

/* Called when the source changes: from the system work queue (from power_init() for the first one) */
typedef void (*power_changed_cb_t)(enum power_source source);

/* Reads the source, calls 'on_changed' if it isn't the battery, then checks it every
 * CONFIG_HACOAP_POWER_CHECK_S seconds. Returns 0, or an error if the CHRG pin can't be used
 * (the source is then the battery or USB). */
int power_init(power_changed_cb_t on_changed);

enum power_source power_source(void);

/* "battery", "usb", "charging" or "charged" */
const char *power_name(enum power_source source);

static inline bool power_on_usb(enum power_source source)
{
	return source != POWER_BATTERY;
}

#endif // POWER_H_
