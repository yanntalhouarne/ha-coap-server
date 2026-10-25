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

#include <openthread/instance.h>

/* Called from the OpenThread thread after each successful SRP registration or update. */
typedef void (*srp_registered_cb_t)(void);

/* Builds the host and instance names (using 'device_id' if HACOAP_SRP_SUFFIX_DEVICE_ID),
 * adds the CoAP service and starts the SRP client in auto-start mode. Call once,
 * from the OpenThread thread, after the device first attaches. */
void srp_start(otInstance *instance, const char *device_id, srp_registered_cb_t on_registered);

#endif // SRP_H_
