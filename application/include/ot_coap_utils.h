/*
 * Yann T.
 *
 * cot_coap_util.h
 *
 * Headers fonts:
 *     - major: ANSI Regular (dafault): https://patorjk.com/software/taag/#p=display&f=ANSI%20Regular&t=LOCALS%20%20%20%20%20INIT
 * 	   - minor: Big          (default): https://patorjk.com/software/taag/#p=display&f=Big&t=LEDS%20%20%20%20%20INIT
 */

#ifndef __OT_COAP_UTILS_H__
#define __OT_COAP_UTILS_H__

#include <version.h>

/*
███    ███  █████   ██████ ██████   ██████  ███████
████  ████ ██   ██ ██      ██   ██ ██    ██ ██
██ ████ ██ ███████ ██      ██████  ██    ██ ███████
██  ██  ██ ██   ██ ██      ██   ██ ██    ██      ██
██      ██ ██   ██  ██████ ██   ██  ██████  ███████
*/
/* Firmare version */
#define FW_VERSION GIT_COMMIT_HASH
/* Hardware version */
#define HW_VERSION "v2.0"
/* CoAp port */
#define COAP_PORT 5683
/* CoAp resources*/
#define PUMPDC_URI_PATH "pumpdc"
#define PUMP_URI_PATH "pump"
#define DATA_URI_PATH "data"
#define INFO_URI_PATH "info"
#define PING_URI_PATH "ping"
/* 'data' payload: soil moisture (%), battery state of charge (%), air humidity (%), temperature (degC, int8) */
#define DATA_PAYLOAD_SIZE 4
/* Maximum size of the 'info' payload ("<fw>,<hw>,<device id>" plus NUL terminator) */
#define INFO_PAYLOAD_MAX_SIZE 64
/* Enumeration describing PUMP commands. */
enum pump_command
{
    THREAD_COAP_UTILS_PUMP_CMD_OFF = '0',
    THREAD_COAP_UTILS_PUMP_CMD_ON = '1'
};
/* Enumeration describing PING commands. */
enum ping_command
{
    THREAD_COAP_UTILS_PING_CMD_QUIET = '0',
    THREAD_COAP_UTILS_PING_CMD_BUZZER = '1'
};

/*
██████  ███████ ███████  ██████  ██    ██ ██████   ██████ ███████      ██████ ██████      ██████  ███████ ███████ ██ ███    ██ ██ ████████ ██  ██████  ███    ██ ███████
██   ██ ██      ██      ██    ██ ██    ██ ██   ██ ██      ██          ██      ██   ██     ██   ██ ██      ██      ██ ████   ██ ██    ██    ██ ██    ██ ████   ██ ██
██████  █████   ███████ ██    ██ ██    ██ ██████  ██      █████       ██      ██████      ██   ██ █████   █████   ██ ██ ██  ██ ██    ██    ██ ██    ██ ██ ██  ██ ███████
██   ██ ██           ██ ██    ██ ██    ██ ██   ██ ██      ██          ██      ██   ██     ██   ██ ██      ██      ██ ██  ██ ██ ██    ██    ██ ██    ██ ██  ██ ██      ██
██   ██ ███████ ███████  ██████   ██████  ██   ██  ██████ ███████      ██████ ██████      ██████  ███████ ██      ██ ██   ████ ██    ██    ██  ██████  ██   ████ ███████
*/
typedef uint8_t (*pumpdc_request_callback_t)(uint8_t data);
typedef void (*pump_request_callback_t)(uint8_t cmd);
typedef const uint8_t *(*data_request_callback_t)(void); // returns DATA_PAYLOAD_SIZE bytes
typedef struct info_data (*info_request_callback_t)(void);
typedef void (*ping_request_callback_t)(uint8_t cmd);

/*
███████ ████████ ██████  ██    ██  ██████ ████████ ███████
██         ██    ██   ██ ██    ██ ██         ██    ██
███████    ██    ██████  ██    ██ ██         ██    ███████
     ██    ██    ██   ██ ██    ██ ██         ██         ██
███████    ██    ██   ██  ██████   ██████    ██    ███████
*/
/* CoAp server struct */
struct server_context
{
    struct otInstance *ot;
    uint8_t pump_dc;
    bool pump_active;
    pumpdc_request_callback_t on_pumpdc_request;
    pump_request_callback_t on_pump_request;
    data_request_callback_t on_data_request;
    info_request_callback_t on_info_request;
    ping_request_callback_t on_ping_request;
};

/* 'info' resource strings, sent as "<fw_version>,<hw_version>,<device_id>" */
struct info_data
{
    const char *fw_version;
    const char *hw_version;
    const char *device_id;
};

/*
██████  ███████  ██████  ██    ██ ███████ ███████ ████████     ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
██   ██ ██      ██    ██ ██    ██ ██      ██         ██        ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
██████  █████   ██    ██ ██    ██ █████   ███████    ██        ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
██   ██ ██      ██ ▄▄ ██ ██    ██ ██           ██    ██        ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
██   ██ ███████  ██████   ██████  ███████ ███████    ██        ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████
*/
/**@brief Default request handler (GET/PUT) */
void coap_default_handler(void *context, otMessage *message, const otMessageInfo *message_info);
/**@brief Pumpdc request handler (GET/PUT) */
void pumpdc_request_handler(void *context, otMessage *message, const otMessageInfo *message_info);
/**@brief Pump request handler (GET/PUT) */
void pump_request_handler(void *context, otMessage *message, const otMessageInfo *message_info);
/**@brief Data request handler (GET) */
void data_request_handler(void *context, otMessage *message, const otMessageInfo *message_info);
/**@brief Info request handler (GET) */
void info_request_handler(void *context, otMessage *message, const otMessageInfo *message_info);
/**@brief Ping request handler (PUT) */
void ping_request_handler(void *context, otMessage *message, const otMessageInfo *message_info);

/*
███████ ██   ██ ████████ ███████ ██████  ███    ██  █████  ██          ███████ ██    ██ ███    ██  ██████ ████████ ██  ██████  ███    ██ ███████
██       ██ ██     ██    ██      ██   ██ ████   ██ ██   ██ ██          ██      ██    ██ ████   ██ ██         ██    ██ ██    ██ ████   ██ ██
█████     ███      ██    █████   ██████  ██ ██  ██ ███████ ██          █████   ██    ██ ██ ██  ██ ██         ██    ██ ██    ██ ██ ██  ██ ███████
██       ██ ██     ██    ██      ██   ██ ██  ██ ██ ██   ██ ██          ██      ██    ██ ██  ██ ██ ██         ██    ██ ██    ██ ██  ██ ██      ██
███████ ██   ██    ██    ███████ ██   ██ ██   ████ ██   ██ ███████     ██       ██████  ██   ████  ██████    ██    ██  ██████  ██   ████ ███████
*/
/**@brief Update CoAp server with pump state when it's sturned ON. */
void coap_activate_pump(void);
/**@brief Update CoAp server with pump state when it's turned OFF. */
void coap_diactivate_pump(void);
/**@brief Get the CoAp server pump state. */
bool coap_is_pump_active(void);
/**@brief Get the CoAp server pump duty-cycle value. */
uint8_t coap_get_pumpdc(void);
/**@brief Get the CoAp server pump duty-cycle value. */
void coap_set_pumpdc(uint8_t data);

/*
 ██████  ██████   █████  ██████      ███████ ███████ ██████  ██    ██ ███████ ██████      ██ ███    ██ ██ ████████
██      ██    ██ ██   ██ ██   ██     ██      ██      ██   ██ ██    ██ ██      ██   ██     ██ ████   ██ ██    ██
██      ██    ██ ███████ ██████      ███████ █████   ██████  ██    ██ █████   ██████      ██ ██ ██  ██ ██    ██
██      ██    ██ ██   ██ ██               ██ ██      ██   ██  ██  ██  ██      ██   ██     ██ ██  ██ ██ ██    ██
 ██████  ██████  ██   ██ ██          ███████ ███████ ██   ██   ████   ███████ ██   ██     ██ ██   ████ ██    ██
*/
/**@brief CoAp server initialization. */
int ot_coap_init(pumpdc_request_callback_t on_pumpdc_request, pump_request_callback_t on_pump_request, data_request_callback_t on_data_request, info_request_callback_t on_info_request, ping_request_callback_t on_ping_request);


#endif // __OT_COAP_UTILS_H__
