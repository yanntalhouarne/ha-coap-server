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
#define PUMP_URI_PATH "light"
#define DATA_URI_PATH "temperature"
#define INFO_URI_PATH "info"
#define PING_URI_PATH "ping"
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
typedef void (*pump_request_callback_t)(uint8_t cmd);
typedef int8_t *(*data_request_callback_t)();
typedef struct info_data (*info_request_callback_t)();
typedef void (*ping_request_callback_t)();

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
    bool pump_active;
    pump_request_callback_t on_pump_request;
    data_request_callback_t on_data_request;
    info_request_callback_t on_info_request;
    ping_request_callback_t on_ping_request;
};

/* FW version data struct */
struct info_data
{
    // FW version
    const char *fw_version_buf;
    uint8_t fw_version_size;

    // HW version
    const char *hw_version_buf;
    uint8_t hw_version_size;

    // Total string length
    uint8_t total_size;
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
/**@brief Pump request handler (GET/PUT) */
void pump_request_handler(void *context, otMessage *message, const otMessageInfo *message_info);
/**@brief Data request handler (GET) */
void data_request_handler(void *context, otMessage *message, const otMessageInfo *message_info);
/**@brief Info request handler (GET) */
void info_request_handler(void *context, otMessage *message, const otMessageInfo *message_info);
/**@brief Ping request handler (GET) */
void ping_request_handler(void *context, otMessage *message, const otMessageInfo *message_info);

/*
██████  ███████ ███████ ██████   ██████  ███    ██ ███████ ███████     ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
██   ██ ██      ██      ██   ██ ██    ██ ████   ██ ██      ██          ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
██████  █████   ███████ ██████  ██    ██ ██ ██  ██ ███████ █████       ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
██   ██ ██           ██ ██      ██    ██ ██  ██ ██      ██ ██          ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
██   ██ ███████ ███████ ██       ██████  ██   ████ ███████ ███████     ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████
*/
/**@brief Pump PUT response with pump state date. */
otError pump_put_response_send(otMessage *request_message, const otMessageInfo *message_info);
/**@brief Pump GET response with pump state date. */
otError pump_get_response_send(otMessage *request_message, const otMessageInfo *message_info);
/**@brief CoAp response with all sensors' data. */
otError data_response_send(otMessage *request_message, const otMessageInfo *message_info);
/**@brief CoAp response with device info data. */
otError info_response_send(otMessage *request_message, const otMessageInfo *message_info);
/**@brief CoAp response for a ping request */
otError ping_response_send(otMessage *request_message, const otMessageInfo *message_info);

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

/*
 ██████  ██████   █████  ██████      ███████ ███████ ██████  ██    ██ ███████ ██████      ██ ███    ██ ██ ████████
██      ██    ██ ██   ██ ██   ██     ██      ██      ██   ██ ██    ██ ██      ██   ██     ██ ████   ██ ██    ██
██      ██    ██ ███████ ██████      ███████ █████   ██████  ██    ██ █████   ██████      ██ ██ ██  ██ ██    ██
██      ██    ██ ██   ██ ██               ██ ██      ██   ██  ██  ██  ██      ██   ██     ██ ██  ██ ██ ██    ██
 ██████  ██████  ██   ██ ██          ███████ ███████ ██   ██   ████   ███████ ██   ██     ██ ██   ████ ██    ██
*/
/**@brief CoAp server initialization. */
int ot_coap_init(pump_request_callback_t on_pump_request, data_request_callback_t on_data_request, info_request_callback_t on_info_request, ping_request_callback_t on_ping_request);


#endif // __OT_COAP_UTILS_H__
