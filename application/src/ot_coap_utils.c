/*
 * Yann T.
 *
 * cot_coap_util.c
 *
 * Headers fonts:
 *     - major: ANSI Regular (dafault): https://patorjk.com/software/taag/#p=display&f=ANSI%20Regular&t=LOCALS%20%20%20%20%20INIT
 * 	   - minor: Big          (default): https://patorjk.com/software/taag/#p=display&f=Big&t=LEDS%20%20%20%20%20INIT
 */

/*
██ ███    ██  ██████ ██      ██    ██ ██████  ███████ ███████
██ ████   ██ ██      ██      ██    ██ ██   ██ ██      ██
██ ██ ██  ██ ██      ██      ██    ██ ██   ██ █████   ███████
██ ██  ██ ██ ██      ██      ██    ██ ██   ██ ██           ██
██ ██   ████  ██████ ███████  ██████  ██████  ███████ ███████
*/
/* OPENTHREAD */
#include <openthread/coap.h>
#include <openthread/ip6.h>
#include <openthread/message.h>
#include <openthread/thread.h>
/* ZEPHYR */
#include <zephyr/logging/log.h>
#include <zephyr/net/net_pkt.h>
#include <zephyr/net/net_l2.h>
#include <zephyr/net/openthread.h>
/* APPLICATION */
#include "../include/ot_coap_utils.h"
/* OTHERS */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/*
███    ███  █████   ██████ ██████   ██████  ███████
████  ████ ██   ██ ██      ██   ██ ██    ██ ██
██ ████ ██ ███████ ██      ██████  ██    ██ ███████
██  ██  ██ ██   ██ ██      ██   ██ ██    ██      ██
██      ██ ██   ██  ██████ ██   ██  ██████  ███████
*/
/* *@brief Enable logging for ot_coap_util.c.c */
LOG_MODULE_REGISTER(ot_coap_utils, CONFIG_OT_COAP_UTILS_LOG_LEVEL);

/*
 ██████  ██       ██████  ██████   █████  ██          ███████ ████████ ██████  ██    ██  ██████ ████████ ███████
██       ██      ██    ██ ██   ██ ██   ██ ██          ██         ██    ██   ██ ██    ██ ██         ██    ██
██   ███ ██      ██    ██ ██████  ███████ ██          ███████    ██    ██████  ██    ██ ██         ██    ███████
██    ██ ██      ██    ██ ██   ██ ██   ██ ██               ██    ██    ██   ██ ██    ██ ██         ██         ██
 ██████  ███████  ██████  ██████  ██   ██ ███████     ███████    ██    ██   ██  ██████   ██████    ██    ███████
*/

/* *@brief Server instance struct */
static struct server_context srv_context = {
	.ot = NULL,
	.pump_dc = 1,
	.pump_active = false,
	.on_pumpdc_request = NULL,
	.on_pump_request = NULL,
	.on_data_request = NULL,
	.on_info_request = NULL,
	.on_ping_request = NULL,
};

/*
 ██████  ██████   █████  ██████      ██████  ███████ ███████  ██████  ██    ██ ██████   ██████ ███████ ███████
██      ██    ██ ██   ██ ██   ██     ██   ██ ██      ██      ██    ██ ██    ██ ██   ██ ██      ██      ██
██      ██    ██ ███████ ██████      ██████  █████   ███████ ██    ██ ██    ██ ██████  ██      █████   ███████
██      ██    ██ ██   ██ ██          ██   ██ ██           ██ ██    ██ ██    ██ ██   ██ ██      ██           ██
 ██████  ██████  ██   ██ ██          ██   ██ ███████ ███████  ██████   ██████  ██   ██  ██████ ███████ ███████
*/
/**@brief Definition of CoAP resources for 'pumpdc'. */
static otCoapResource pumpdc_resource = {
	.mUriPath = PUMPDC_URI_PATH,
	.mHandler = NULL,
	.mContext = NULL,
	.mNext = NULL,
};

/**@brief Definition of CoAP resources for 'pump'. */
static otCoapResource pump_resource = {
	.mUriPath = PUMP_URI_PATH,
	.mHandler = NULL,
	.mContext = NULL,
	.mNext = NULL,
};

/**@brief Definition of CoAP resource 'data'. */
static otCoapResource data_resource = {
	.mUriPath = DATA_URI_PATH,
	.mHandler = NULL,
	.mContext = NULL,
	.mNext = NULL,
};

/**@brief Definition of CoAP resource 'info'. */
static otCoapResource info_resource = {
	.mUriPath = INFO_URI_PATH,
	.mHandler = NULL,
	.mContext = NULL,
	.mNext = NULL,
};

/**@brief Definition of CoAP resource 'ping'. */
static otCoapResource ping_resource = {
	.mUriPath = PING_URI_PATH,
	.mHandler = NULL,
	.mContext = NULL,
	.mNext = NULL,
};

/*
██████  ███████ ███████ ██████   ██████  ███    ██ ███████ ███████
██   ██ ██      ██      ██   ██ ██    ██ ████   ██ ██      ██
██████  █████   ███████ ██████  ██    ██ ██ ██  ██ ███████ █████
██   ██ ██           ██ ██      ██    ██ ██  ██ ██      ██ ██
██   ██ ███████ ███████ ██       ██████  ██   ████ ███████ ███████
*/
/**@brief Sends a response to 'request_message', with an optional payload.
 *
 * A confirmable request gets a piggybacked ACK, any other request a NON response.
 * otCoapMessageInitResponse() already copies the request's message ID and token,
 * so the token must not be set again (doing so grows the header a second time and
 * leaves uninitialized bytes in front of the payload).
 */
static otError coap_response_send(otMessage *request_message, const otMessageInfo *message_info,
				  otCoapCode code, const void *payload, uint16_t payload_size)
{
	otError error = OT_ERROR_NO_BUFS;
	otMessage *response;
	otCoapType type = (otCoapMessageGetType(request_message) == OT_COAP_TYPE_CONFIRMABLE)
				  ? OT_COAP_TYPE_ACKNOWLEDGMENT
				  : OT_COAP_TYPE_NON_CONFIRMABLE;

	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		LOG_INF("Error in otCoapNewMessage()");
		goto end;
	}

	error = otCoapMessageInitResponse(response, request_message, type, code);
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otCoapMessageInitResponse()");
		goto end;
	}

	if (payload_size > 0)
	{
		error = otCoapMessageSetPayloadMarker(response);
		if (error != OT_ERROR_NONE)
		{
			LOG_INF("Error in otCoapMessageSetPayloadMarker()");
			goto end;
		}

		error = otMessageAppend(response, payload, payload_size);
		if (error != OT_ERROR_NONE)
		{
			LOG_INF("Error in otMessageAppend()");
			goto end;
		}
	}

	error = otCoapSendResponse(srv_context.ot, response, message_info);
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otCoapSendResponse()");
	}

end:
	if (error != OT_ERROR_NONE && response != NULL)
	{
		otMessageFree(response);
	}

	return error;
}

/**@brief Returns true for a GET request (confirmable or not). */
static bool is_get_request(otMessage *message)
{
	otCoapType type = otCoapMessageGetType(message);

	return ((type == OT_COAP_TYPE_CONFIRMABLE) || (type == OT_COAP_TYPE_NON_CONFIRMABLE)) &&
	       (otCoapMessageGetCode(message) == OT_COAP_CODE_GET);
}

/**@brief Returns true for a confirmable PUT request. */
static bool is_con_put_request(otMessage *message)
{
	return (otCoapMessageGetType(message) == OT_COAP_TYPE_CONFIRMABLE) &&
	       (otCoapMessageGetCode(message) == OT_COAP_CODE_PUT);
}

/**@brief Copies the message info and clears the socket address, so that the response
 * is sent from the address the request was received on. */
static void response_info_init(otMessageInfo *msg_info, const otMessageInfo *message_info)
{
	*msg_info = *message_info;
	memset(&msg_info->mSockAddr, 0, sizeof(msg_info->mSockAddr));
}

/*
██████  ███████  ██████  ██    ██ ███████ ███████ ████████     ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
██   ██ ██      ██    ██ ██    ██ ██      ██         ██        ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
██████  █████   ██    ██ ██    ██ █████   ███████    ██        ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
██   ██ ██      ██ ▄▄ ██ ██    ██ ██           ██    ██        ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
██   ██ ███████  ██████   ██████  ███████ ███████    ██        ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████
*/
/*
	  _       __            _ _
	 | |     / _|          | | |
   __| | ___| |_ __ _ _   _| | |_
  / _` |/ _ \  _/ _` | | | | | __|
 | (_| |  __/ || (_| | |_| | | |_
  \__,_|\___|_| \__,_|\__,_|_|\__|
*/
/**@brief Default request handler (GET/PUT) */
void coap_default_handler(void *context, otMessage *message,
						  const otMessageInfo *message_info)
{
	ARG_UNUSED(context);
	ARG_UNUSED(message);
	ARG_UNUSED(message_info);

	LOG_INF("Received CoAP message that does not match any request "
			"or resource");
}
/*
                                  _
                                 | |
  _ __  _   _ _ __ ___  _ __   __| | ___
 | '_ \| | | | '_ ` _ \| '_ \ / _` |/ __|
 | |_) | |_| | | | | | | |_) | (_| | (__
 | .__/ \__,_|_| |_| |_| .__/ \__,_|\___|
 | |                   | |
 |_|                   |_|
*/
/**@brief Pumpdc request handler (GET/PUT) */
void pumpdc_request_handler(void *context, otMessage *message, const otMessageInfo *message_info)
{
	uint8_t data;
	uint8_t pump_dutycycle;
	otMessageInfo msg_info;

	ARG_UNUSED(context);

	if (is_con_put_request(message))
	{
		response_info_init(&msg_info, message_info);

		if (otMessageRead(message, otMessageGetOffset(message), &data, 1) != 1)
		{
			LOG_ERR("'pumpdc' handler - Missing 'pumpdc' data");
			return;
		}
		pump_dutycycle = srv_context.on_pumpdc_request(data); // update 'pumpdc' in coap_server.c
		LOG_INF("Received 'pumpdc' PUT request: %c seconds", data);
		coap_response_send(message, &msg_info, OT_COAP_CODE_CONTENT, &pump_dutycycle, sizeof(pump_dutycycle));
	}
	else if (is_get_request(message))
	{
		response_info_init(&msg_info, message_info);

		LOG_INF("Received 'pumpdc' GET request");
		pump_dutycycle = coap_get_pumpdc();
		if (coap_response_send(message, &msg_info, OT_COAP_CODE_CONTENT, &pump_dutycycle, sizeof(pump_dutycycle)) == OT_ERROR_NONE)
		{
			LOG_INF("'pumpdc' GET response sent: %d", pump_dutycycle);
		}
	}
	else
	{
		LOG_INF("Bad 'pumpdc' request type/code.");
	}
}
/*
  _ __  _   _ _ __ ___  _ __
 | '_ \| | | | '_ ` _ \| '_ \
 | |_) | |_| | | | | | | |_) |
 | .__/ \__,_|_| |_| |_| .__/
 | |                   | |
 |_|                   |_|
*/
/**@brief Pump request handler (GET/PUT) */
void pump_request_handler(void *context, otMessage *message, const otMessageInfo *message_info)
{
	uint8_t command;
	uint8_t pump_status;
	otMessageInfo msg_info;

	ARG_UNUSED(context);

	if (is_con_put_request(message))
	{
		response_info_init(&msg_info, message_info);

		if (otMessageRead(message, otMessageGetOffset(message), &command, 1) != 1)
		{
			LOG_ERR("'pump' handler - Missing 'pump' command");
			return;
		}
		srv_context.on_pump_request(command); // update 'pump' in coap_server.c
		LOG_INF("Received 'pump' PUT request: %c", command);
		pump_status = coap_is_pump_active() ? 1 : 0;
		coap_response_send(message, &msg_info, OT_COAP_CODE_CONTENT, &pump_status, sizeof(pump_status));
	}
	else if (is_get_request(message))
	{
		response_info_init(&msg_info, message_info);

		LOG_INF("Received 'pump' GET request");
		pump_status = coap_is_pump_active() ? 1 : 0;
		if (coap_response_send(message, &msg_info, OT_COAP_CODE_CONTENT, &pump_status, sizeof(pump_status)) == OT_ERROR_NONE)
		{
			LOG_INF("'pump' GET response sent: %d", pump_status);
		}
	}
	else
	{
		LOG_INF("Bad 'pump' request type/code.");
	}
}

/*
	  _       _
	 | |     | |
   __| | __ _| |_ __ _
  / _` |/ _` | __/ _` |
 | (_| | (_| | || (_| |
  \__,_|\__,_|\__\__,_|
*/
/**@brief Data request handler (GET) */
void data_request_handler(void *context, otMessage *message, const otMessageInfo *message_info)
{
	otMessageInfo msg_info;
	const int8_t *data_buf;

	ARG_UNUSED(context);

	LOG_INF("Received 'data' request");

	if (is_get_request(message))
	{
		response_info_init(&msg_info, message_info);

		data_buf = srv_context.on_data_request(); // get 'data' buffer from coap_server.c
		if (coap_response_send(message, &msg_info, OT_COAP_CODE_CONTENT, data_buf, DATA_PAYLOAD_SIZE) == OT_ERROR_NONE)
		{
			LOG_DBG("'data' response sent.");
		}
	}
	else
	{
		LOG_INF("Bad 'data' request type or code.");
	}
}

/*
  _        __
 (_)      / _|
  _ _ __ | |_ ___
 | | '_ \|  _/ _ \
 | | | | | || (_) |
 |_|_| |_|_| \___/
 */
/**@brief Info request handler (GET) */
void info_request_handler(void *context, otMessage *message, const otMessageInfo *message_info)
{
	otMessageInfo msg_info;
	struct info_data info;
	char info_output[INFO_PAYLOAD_MAX_SIZE];
	int len;

	ARG_UNUSED(context);

	LOG_DBG("Received 'info' request");

	if (is_get_request(message))
	{
		response_info_init(&msg_info, message_info);

		info = srv_context.on_info_request(); // get 'info' strings from coap_server.c
		len = snprintf(info_output, sizeof(info_output), "%s,%s,%s",
			       info.fw_version_buf, info.hw_version_buf, info.device_id_buf);
		if (len < 0)
		{
			return;
		}
		if (len >= (int)sizeof(info_output))
		{
			len = sizeof(info_output) - 1;
		}

		/* The payload includes the string's NUL terminator, as it always has. */
		if (coap_response_send(message, &msg_info, OT_COAP_CODE_CONTENT, info_output, len + 1) == OT_ERROR_NONE)
		{
			LOG_INF("Device info is: %s", info_output);
		}
	}
	else
	{
		LOG_INF("Bad 'info' request type or code.");
	}
}

/*
        _
       (_)
  _ __  _ _ __   __ _
 | '_ \| | '_ \ / _` |
 | |_) | | | | | (_| |
 | .__/|_|_| |_|\__, |
 | |             __/ |
 |_|            |___/
*/
/**@brief Ping request handler (PUT). The payload selects quiet ('0') or buzzer ('1'). */
void ping_request_handler(void *context, otMessage *message, const otMessageInfo *message_info)
{
	otMessageInfo msg_info;
	otCoapType type = otCoapMessageGetType(message);
	uint8_t command;

	ARG_UNUSED(context);

	LOG_INF("Received 'ping' request");

	if (((type == OT_COAP_TYPE_CONFIRMABLE) || (type == OT_COAP_TYPE_NON_CONFIRMABLE)) && (otCoapMessageGetCode(message) == OT_COAP_CODE_PUT))
	{
		response_info_init(&msg_info, message_info);

		if (otMessageRead(message, otMessageGetOffset(message), &command, 1) != 1)
		{
			LOG_ERR("'ping' handler - Missing 'ping' command");
			return;
		}

		srv_context.on_ping_request(command); // buzz (or not) in coap_server.c

		coap_response_send(message, &msg_info, OT_COAP_CODE_CHANGED, NULL, 0);
	}
	else
	{
		LOG_INF("Bad 'ping' request type or code.");
	}
}

/*
███████ ██   ██ ████████ ███████ ██████  ███    ██  █████  ██          ███████ ██    ██ ███    ██  ██████ ████████ ██  ██████  ███    ██ ███████
██       ██ ██     ██    ██      ██   ██ ████   ██ ██   ██ ██          ██      ██    ██ ████   ██ ██         ██    ██ ██    ██ ████   ██ ██
█████     ███      ██    █████   ██████  ██ ██  ██ ███████ ██          █████   ██    ██ ██ ██  ██ ██         ██    ██ ██    ██ ██ ██  ██ ███████
██       ██ ██     ██    ██      ██   ██ ██  ██ ██ ██   ██ ██          ██      ██    ██ ██  ██ ██ ██         ██    ██ ██    ██ ██  ██ ██      ██
███████ ██   ██    ██    ███████ ██   ██ ██   ████ ██   ██ ███████     ██       ██████  ██   ████  ██████    ██    ██  ██████  ██   ████ ███████
*/
void coap_activate_pump(void)
{
	srv_context.pump_active = true;
}

void coap_set_pumpdc(uint8_t data)
{
	srv_context.pump_dc = data;
}

uint8_t coap_get_pumpdc(void)
{
	return srv_context.pump_dc;
}

bool coap_is_pump_active(void)
{
	return srv_context.pump_active;
}

void coap_diactivate_pump(void)
{
	srv_context.pump_active = false;
}

/*
 ██████  ██████   █████  ██████      ███████ ███████ ██████  ██    ██ ███████ ██████      ██ ███    ██ ██ ████████
██      ██    ██ ██   ██ ██   ██     ██      ██      ██   ██ ██    ██ ██      ██   ██     ██ ████   ██ ██    ██
██      ██    ██ ███████ ██████      ███████ █████   ██████  ██    ██ █████   ██████      ██ ██ ██  ██ ██    ██
██      ██    ██ ██   ██ ██               ██ ██      ██   ██  ██  ██  ██      ██   ██     ██ ██  ██ ██ ██    ██
 ██████  ██████  ██   ██ ██          ███████ ███████ ██   ██   ████   ███████ ██   ██     ██ ██   ████ ██    ██
*/
/**@brief CoAp server initialization. */
int ot_coap_init(pumpdc_request_callback_t on_pumpdc_request, pump_request_callback_t on_pump_request, data_request_callback_t on_data_request, info_request_callback_t on_info_request, ping_request_callback_t on_ping_request)
{
	otError error;

	/* Attach CoAp resources to server context. */
	srv_context.on_pumpdc_request = on_pumpdc_request;
	srv_context.on_pump_request = on_pump_request;
	srv_context.on_data_request = on_data_request;
	srv_context.on_info_request = on_info_request;
	srv_context.on_ping_request = on_ping_request;

	/* Get OpenThread instance. */
	srv_context.ot = openthread_get_default_instance();
	if (!srv_context.ot)
	{
		LOG_ERR("There is no valid OpenThread instance");
		error = OT_ERROR_FAILED;
		goto end;
	}

	/* Initialize CoAp Resources */
	// 'pumpdc' resource
	pumpdc_resource.mContext = srv_context.ot;
	pumpdc_resource.mHandler = pumpdc_request_handler;
	// 'pump' resource
	pump_resource.mContext = srv_context.ot;
	pump_resource.mHandler = pump_request_handler;
	// 'data' resource
	data_resource.mContext = srv_context.ot;
	data_resource.mHandler = data_request_handler;
	// 'info' resource
	info_resource.mContext = srv_context.ot;
	info_resource.mHandler = info_request_handler;
	// 'ping' resource
	ping_resource.mContext = srv_context.ot;
	ping_resource.mHandler = ping_request_handler;

	/* Set CoAp default handler */
	otCoapSetDefaultHandler(srv_context.ot, coap_default_handler, NULL);

	/* Add resources to the CoAp server */
	otCoapAddResource(srv_context.ot, &pumpdc_resource);
	otCoapAddResource(srv_context.ot, &pump_resource);
	otCoapAddResource(srv_context.ot, &data_resource);
	otCoapAddResource(srv_context.ot, &info_resource);
	otCoapAddResource(srv_context.ot, &ping_resource);

	/* Start CoAp server */
	error = otCoapStart(srv_context.ot, COAP_PORT);
	if (error != OT_ERROR_NONE)
	{
		LOG_ERR("Failed to start OT CoAP. Error: %d", error);
		goto end;
	}
	LOG_INF("Coap Server has started");

end:
	return error == OT_ERROR_NONE ? 0 : 1;
}
