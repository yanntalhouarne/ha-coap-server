/*
 * Yann T.
 *
 * srp.h
 *
 * Registers the CoAP service with the border router's SRP server, so Home Assistant
 * can discover the device. Names are set with the HACOAP_SRP_* Kconfig options.
 */

#ifndef SRP_H_
#define SRP_H_

#include <stdbool.h>
#include <openthread/instance.h>

/* Called from the OpenThread thread after each successful SRP registration or update. */
typedef void (*srp_registered_cb_t)(void);

/* Builds the host and instance names (using 'device_id' if HACOAP_SRP_SUFFIX_DEVICE_ID),
 * adds the CoAP service and starts the SRP client in auto-start mode. Call once,
 * from the OpenThread thread, after the device first attaches. */
void srp_start(otInstance *instance, const char *device_id, srp_registered_cb_t on_registered);

/* The registration's state, for 'diag': "off" (not started: not attached yet), "registered",
 * "failed" (the server refused or didn't answer the last try: it tries again) or "pending".
 * Call from the OpenThread thread. */
const char *srp_state(otInstance *instance);

/* Removes the host and its service from the SRP server (the name vanishes from the LAN at
 * once), keeping the key, so the device can take the name back later. Returns true if a
 * removal was sent. Call from the OpenThread thread, or with its lock held. */
bool srp_unregister(otInstance *instance);

#endif // SRP_H_
