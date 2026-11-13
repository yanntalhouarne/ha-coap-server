/*
 * Yann T.
 *
 * coap_resources.h
 *
 * The device's CoAP API: the resources Home Assistant talks to, and their payloads.
 * The application supplies the behavior through struct coap_resources_handlers.
 */

#ifndef COAP_RESOURCES_H_
#define COAP_RESOURCES_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <openthread/coap.h>

/* CoAP port, also advertised through SRP */
#define COAP_PORT OT_DEFAULT_COAP_PORT

/* 'data' payload: soil moisture (%), battery state of charge (%), air humidity (%), temperature (degC, int8) */
#define DATA_PAYLOAD_SIZE 4

/* Maximum size of the 'info' payload ("<fw>,<hw>,<device id>" plus NUL terminator) */
#define INFO_PAYLOAD_MAX_SIZE 64

/* Maximum size of the 'diag' payload (see diag.h): room for every field with large counters */
#define DIAG_PAYLOAD_MAX_SIZE 256

/* Maximum size of the 'log' payload (see log_buffer.h): about the most that fits in one
 * IPv6 packet of a few 6LoWPAN fragments */
#define LOG_PAYLOAD_MAX_SIZE 512

/* Maximum size of the 'hist' payload (see history.h): 54 samples */
#define HIST_PAYLOAD_MAX_SIZE 512

/* 'pump' PUT payloads */
enum pump_command
{
	PUMP_CMD_OFF = '0',
	PUMP_CMD_ON = '1',
};

/* 'ping' PUT payloads */
enum ping_command
{
	PING_CMD_QUIET = '0',
	PING_CMD_BUZZER = '1',
};

/* 'info' resource strings, sent as "<fw_version>,<hw_version>,<device_id>" */
struct coap_info
{
	const char *fw_version;
	const char *hw_version;
	const char *device_id;
};

/* Application callbacks, called from the OpenThread thread. They must not block. */
struct coap_resources_handlers
{
	uint8_t (*pumpdc_get)(void);                       // returns the pump run time (s)
	uint8_t (*pumpdc_put)(uint8_t value);              // 'value' is the raw payload byte; returns the run time now in use
	bool (*pump_get)(void);                            // returns true while the pump runs
	void (*pump_put)(uint8_t command);                 // 'command' is a pump_command
	void (*data_get)(uint8_t payload[DATA_PAYLOAD_SIZE]);
	struct coap_info (*info_get)(void);
	void (*ping_put)(uint8_t command);                 // 'command' is a ping_command
	size_t (*diag_get)(char *payload, size_t size);    // writes the 'diag' payload, returns its length
	/* Writes the 'log' payload for a reader that has the log up to offset 'from', and
	 * returns its length. NULL when the device keeps no log ('log' answers 4.04). */
	size_t (*log_get)(uint32_t from, char *payload, size_t size);
	/* Writes the 'hist' payload for a reader that has every sample before 'from'
	 * (history_read()), sets '*next' to the sample after the last one written, and returns its
	 * length. NULL: 'hist' answers 4.04. */
	size_t (*hist_get)(uint32_t from, uint8_t *payload, size_t size, uint32_t *next);
};

/* Registers the resources and starts the CoAP server on COAP_PORT. 'handlers' must stay valid. */
int coap_resources_init(const struct coap_resources_handlers *handlers);

/* 'hist' can be observed (RFC 7641, CONFIG_HACOAP_PUSH): a GET with Observe 0 registers its
 * sender, until CONFIG_HACOAP_PUSH_LEASE_S after it registered; a GET with Observe 1 from it ends
 * it. Up to CONFIG_HACOAP_PUSH_OBSERVERS at once (the fleet manager, Home Assistant...): one that
 * registers again keeps its place; when they're all taken, a new one replaces the one that
 * registered longest ago. Each one registers again before its lease ends. */

/* Whether observer 'index' (0 to CONFIG_HACOAP_PUSH_OBSERVERS - 1) observes 'hist': if so, sets
 * '*next' to the first sample it wasn't given. Call with the OpenThread API lock held. */
bool coap_resources_observed(size_t index, uint32_t *next);

/* Sends observer 'index' the samples it wasn't given, in a non-confirmable notification (the same
 * payload as a GET). Call with the OpenThread API lock held. Returns 0, -ENOTCONN when it doesn't
 * observe, or another negative error. */
int coap_resources_notify(size_t index);

#endif // COAP_RESOURCES_H_
