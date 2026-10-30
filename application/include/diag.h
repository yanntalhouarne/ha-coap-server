/*
 * Yann T.
 *
 * diag.h
 *
 * Why the device last restarted, a record of the last crash, the number of boots, and its
 * link to its parent: the 'diag' CoAP resource, which the fleet manager reads at each refresh.
 */

#ifndef DIAG_H_
#define DIAG_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <openthread/instance.h>

enum diag_reset
{
	DIAG_RESET_POWER,    // power-on or brownout (also: no reason recorded)
	DIAG_RESET_PIN,      // the reset pin
	DIAG_RESET_SOFT,     // a software reset: after an update, or an mcumgr reset
	DIAG_RESET_WATCHDOG, // the watchdog: the system work queue stalled
	DIAG_RESET_LOCKUP,   // a CPU lockup
	DIAG_RESET_CRASH,    // a fatal error (see the crash record)
	DIAG_RESET_OTHER,
};

/* The device's link to its parent, read from OpenThread */
struct diag_link
{
	const char *role;       // "disabled", "detached", "child", "router" or "leader"
	bool attached;
	uint16_t rloc16;        // the device's own short address
	uint16_t parent_rloc16;
	int8_t parent_rssi;     // average (dBm)
	int8_t last_rssi;       // last frame (dBm)
	uint8_t link_quality;   // 0 to 3, incoming
};

/* Reads and clears the reset cause and the crash record, and counts the boot. Call once at
 * boot, after device_settings_init() (the count is stored with the settings). */
void diag_init(void);

enum diag_reset diag_reset_cause(void);
const char *diag_reset_name(enum diag_reset cause);

/* Reads the link to the parent. Call from the OpenThread thread (a CoAP handler). */
void diag_link_read(otInstance *instance, struct diag_link *link);

/* Writes the 'diag' payload, for example
 * "boots=12,up=3600,reset=crash,fault=3@0001a2b4,role=child,srp=registered,rloc=5c01,parent=5c00,rssi=-62,
 *  last_rssi=-60,lq=3,soil_mv=1696"
 * ('fault' only after a crash, the link only when attached; 'srp' is srp_state()). Returns its length. */
size_t diag_format(char *payload, size_t size, const struct diag_link *link, const char *srp, int32_t soil_mv);

#endif // DIAG_H_
