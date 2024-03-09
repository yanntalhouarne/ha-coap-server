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
struct server_context srv_context = {
	.ot = NULL,
	.pump_active = false,
	.on_pump_request = NULL,
	.on_data_request = NULL,
};

/*
 ██████  ██████   █████  ██████      ██████  ███████ ███████  ██████  ██    ██ ██████   ██████ ███████ ███████
██      ██    ██ ██   ██ ██   ██     ██   ██ ██      ██      ██    ██ ██    ██ ██   ██ ██      ██      ██
██      ██    ██ ███████ ██████      ██████  █████   ███████ ██    ██ ██    ██ ██████  ██      █████   ███████
██      ██    ██ ██   ██ ██          ██   ██ ██           ██ ██    ██ ██    ██ ██   ██ ██      ██           ██
 ██████  ██████  ██   ██ ██          ██   ██ ███████ ███████  ██████   ██████  ██   ██  ██████ ███████ ███████
*/

/*
  _ __  _   _ _ __ ___  _ __
 | '_ \| | | | '_ ` _ \| '_ \
 | |_) | |_| | | | | | | |_) |
 | .__/ \__,_|_| |_| |_| .__/
 | |                   | |
 |_|                   |_|
*/
/**@brief Definition of CoAP resources for light. */
otCoapResource pump_resource = {
	.mUriPath = PUMP_URI_PATH,
	.mHandler = NULL,
	.mContext = NULL,
	.mNext = NULL,
};

/*
  _____        _
 |  __ \      | |
 | |  | | __ _| |_ __ _
 | |  | |/ _` | __/ _` |
 | |__| | (_| | || (_| |
 |_____/ \__,_|\__\__,_|
*/
/**@brief Definition of CoAP resources for temperature. */
otCoapResource data_resource = {
	.mUriPath = DATA_URI_PATH,
	.mHandler = NULL,
	.mContext = NULL,
	.mNext = NULL,
};

/*
  _        __
 (_)      / _|
  _ _ __ | |_ ___
 | | '_ \|  _/ _ \
 | | | | | || (_) |
 |_|_| |_|_| \___/
*/
/**@brief Definition of CoAP resources for temperature. */
otCoapResource info_resource = {
	.mUriPath = INFO_URI_PATH,
	.mHandler = NULL,
	.mContext = NULL,
	.mNext = NULL,
};

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
	otMessageInfo msg_info;

	uint8_t isTypePut = 0;

	ARG_UNUSED(context);
	if ((otCoapMessageGetType(message) == OT_COAP_TYPE_CONFIRMABLE) && (otCoapMessageGetCode(message) == OT_COAP_CODE_PUT))
	{
		isTypePut = 1;
	}
	else if ((otCoapMessageGetType(message) == OT_COAP_TYPE_NON_CONFIRMABLE) && (otCoapMessageGetCode(message) == OT_COAP_CODE_GET))
	{
		isTypePut = 0;
	}
	else
	{
		LOG_INF("Bad light request type/code.");
		goto end;
	}

	msg_info = *message_info;
	memset(&msg_info.mSockAddr, 0, sizeof(msg_info.mSockAddr));

	if (isTypePut)
	{
		if (otMessageRead(message, otMessageGetOffset(message), &command, 1) != 1)
		{
			LOG_ERR("Light handler - Missing light command");
			goto end;
		}
		srv_context.on_pump_request(command); // update light in coap_server.c
		LOG_INF("Received light PUT request: %c", command);
		pump_put_response_send(message, &msg_info);
	}
	else
	{
		LOG_INF("Received light GET request");
		pump_get_response_send(message, &msg_info);
	}

end:
	return;
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
	otError error;
	otMessageInfo msg_info;

	ARG_UNUSED(context);

	LOG_INF("Received temperature request");

	if ((otCoapMessageGetType(message) == OT_COAP_TYPE_NON_CONFIRMABLE) &&
		(otCoapMessageGetCode(message) == OT_COAP_CODE_GET))
	{
		msg_info = *message_info;
		memset(&msg_info.mSockAddr, 0, sizeof(msg_info.mSockAddr));

		data_response_send(message, &msg_info);
	}
	else
	{
		LOG_INF("Bad temperature request type or code.");
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
	otError error;
	otMessageInfo msg_info;

	ARG_UNUSED(context);

	LOG_DBG("Received info request");

	if ((otCoapMessageGetType(message) == OT_COAP_TYPE_CONFIRMABLE) &&
		(otCoapMessageGetCode(message) == OT_COAP_CODE_GET))
	{
		msg_info = *message_info;
		memset(&msg_info.mSockAddr, 0, sizeof(msg_info.mSockAddr));

		info_response_send(message, &msg_info);
	}
	else
	{
		LOG_INF("Bad info request type or code.");
	}
}

/*
██████  ███████ ███████ ██████   ██████  ███    ██ ███████ ███████     ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
██   ██ ██      ██      ██   ██ ██    ██ ████   ██ ██      ██          ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
██████  █████   ███████ ██████  ██    ██ ██ ██  ██ ███████ █████       ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
██   ██ ██           ██ ██      ██    ██ ██  ██ ██      ██ ██          ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
██   ██ ███████ ███████ ██       ██████  ██   ████ ███████ ███████     ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████
*/
/*
  _ __  _   _ _ __ ___  _ __
 | '_ \| | | | '_ ` _ \| '_ \
 | |_) | |_| | | | | | | |_) |
 | .__/ \__,_|_| |_| |_| .__/
 | |                   | |
 |_|                   |_|
*/
/**@brief Pump PUT response with pump state date. */
otError pump_put_response_send(otMessage *request_message, const otMessageInfo *message_info)
{
	otError error = OT_ERROR_NO_BUFS;
	otMessage *response;
	const void *payload;
	uint16_t payload_size;
	uint8_t light_status = 0;

	// create response message
	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		LOG_INF("Error in otCoapNewMessage()");
		goto end;
	}

	// init response message
	otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_ACKNOWLEDGMENT,
							  OT_COAP_CODE_CHANGED);

	// set message payload marker
	error = otCoapMessageSetPayloadMarker(response);
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otCoapMessageSetPayloadMarker()");
		goto end;
	}

	// update payload
	if (coap_is_pump_active())
		light_status = 1;

	payload = &light_status;
	payload_size = sizeof(light_status);

	error = otMessageAppend(response, payload, payload_size);
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otMessageAppend()");
		goto end;
	}

	error = otCoapSendResponse(srv_context.ot, response, message_info);
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otCoapSendResponse()");
		goto end;
	}

	LOG_DBG("Light PUT response sent: %d", light_status);

end:
	if (error != OT_ERROR_NONE && response != NULL)
	{
		LOG_INF("Couldn't send Light response");
		otMessageFree(response);
	}

	return error;
}
/**@brief Pump GET response with pump state date. */
otError pump_get_response_send(otMessage *request_message, const otMessageInfo *message_info)
{
	otError error = OT_ERROR_NO_BUFS;
	otMessage *response;
	const void *payload;
	uint16_t payload_size;
	uint8_t val = coap_is_pump_active();

	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		goto end;
	}

	otCoapMessageInit(response, OT_COAP_TYPE_NON_CONFIRMABLE,
					  OT_COAP_CODE_CONTENT);

	error = otCoapMessageSetToken(
		response, otCoapMessageGetToken(request_message),
		otCoapMessageGetTokenLength(request_message));
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otCoapMessageSetToken()");
		goto end;
	}

	error = otCoapMessageSetPayloadMarker(response);
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otCoapMessageSetPayloadMarker()");
		goto end;
	}

	payload = &val;
	payload_size = sizeof(val);

	error = otMessageAppend(response, payload, payload_size);
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otMessageAppend()");
		goto end;
	}

	error = otCoapSendResponse(srv_context.ot, response, message_info);
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otCoapSendResponse()");
		goto end;
	}

	LOG_INF("Light GET response sent: %d", val);

end:
	if (error != OT_ERROR_NONE && response != NULL)
	{
		otMessageFree(response);
		LOG_INF("Couldn't send Light GET response");
	}

	return error;
}

/*
	  _       _
	 | |     | |
   __| | __ _| |_ __ _
  / _` |/ _` | __/ _` |
 | (_| | (_| | || (_| |
  \__,_|\__,_|\__\__,_|
*/
/**@brief CoAp response with all sensors' data. */
otError data_response_send(otMessage *request_message, const otMessageInfo *message_info)
{
	otError error = OT_ERROR_NO_BUFS;
	otMessage *response;
	const void *payload;
	uint16_t payload_size;
	int8_t *data_buf = {0};

	data_buf = srv_context.on_data_request(); // get temperature from coap_server.c

	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		goto end;
	}

	otCoapMessageInit(response, OT_COAP_TYPE_NON_CONFIRMABLE,
					  OT_COAP_CODE_CONTENT);

	error = otCoapMessageSetToken(
		response, otCoapMessageGetToken(request_message),
		otCoapMessageGetTokenLength(request_message));
	if (error != OT_ERROR_NONE)
	{
		goto end;
	}

	error = otCoapMessageSetPayloadMarker(response);
	if (error != OT_ERROR_NONE)
	{
		goto end;
	}

	payload = data_buf;
	payload_size = sizeof(data_buf);

	error = otMessageAppend(response, payload, payload_size);
	if (error != OT_ERROR_NONE)
	{
		goto end;
	}

	error = otCoapSendResponse(srv_context.ot, response, message_info);

	LOG_DBG("Temperature response sent: %d degC", data_buf);

end:
	if (error != OT_ERROR_NONE && response != NULL)
	{
		otMessageFree(response);
	}

	return error;
}

/*
  _        __
 (_)      / _|
  _ _ __ | |_ ___
 | | '_ \|  _/ _ \
 | | | | | || (_) |
 |_|_| |_|_| \___/
*/
/**@brief Info GET response with firmware and hardware date. */
otError info_response_send(otMessage *request_message, const otMessageInfo *message_info)
{
	otError error = OT_ERROR_NO_BUFS;
	otMessage *response;
	const void *payload;
	uint16_t payload_size;
	struct info_data _info;
	_info = srv_context.on_info_request(); // get temperature from coap_server.c

	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		goto end;
	}

	otCoapMessageInit(response, OT_COAP_TYPE_NON_CONFIRMABLE,
					  OT_COAP_CODE_CONTENT);

	error = otCoapMessageSetToken(
		response, otCoapMessageGetToken(request_message),
		otCoapMessageGetTokenLength(request_message));
	if (error != OT_ERROR_NONE)
	{
		goto end;
	}

	error = otCoapMessageSetPayloadMarker(response);
	if (error != OT_ERROR_NONE)
	{
		goto end;
	}


//    char * info_output = (char*)malloc(_info.total_size);
	char info_output[50] = {0};
	// if (info_output = NULL)
	// 	LOG_INF("Could not allocate memory for Info Data buffer.");
	// else
	// {
		snprintf(info_output, _info.total_size, "%s,%s", _info.fw_version_buf, _info.hw_version_buf);
		payload = &info_output;
		payload_size = _info.total_size;
	//}
	
	error = otMessageAppend(response, payload, payload_size);
	if (error != OT_ERROR_NONE)
	{
		goto end;
	}

	error = otCoapSendResponse(srv_context.ot, response, message_info);

	LOG_INF("Firmware version is: %s", info_output);

end:
	if (error != OT_ERROR_NONE && response != NULL)
	{
		otMessageFree(response);
	}

	return error;
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
int ot_coap_init(pump_request_callback_t on_pump_request, data_request_callback_t on_data_request, info_request_callback_t on_info_request)
{
	otError error;

	/* Attach CoAp resources to server context. */
	srv_context.on_pump_request = on_pump_request;
	srv_context.on_data_request = on_data_request;
	srv_context.on_info_request = on_info_request;

	/* Get OpenThread instance. */
	srv_context.ot = openthread_get_default_instance();
	if (!srv_context.ot)
	{
		LOG_ERR("There is no valid OpenThread instance");
		error = OT_ERROR_FAILED;
		goto end;
	}

	/* Initialize CoAp Resources */
	// pump resource
	pump_resource.mContext = srv_context.ot;
	pump_resource.mHandler = pump_request_handler;
	// data resource
	data_resource.mContext = srv_context.ot;
	data_resource.mHandler = data_request_handler;
	// info resource
	info_resource.mContext = srv_context.ot;
	info_resource.mHandler = info_request_handler;

	/* Set CoAp default handler */
	otCoapSetDefaultHandler(srv_context.ot, coap_default_handler, NULL);

	/* Add resources to the CoAp server */
	otCoapAddResource(srv_context.ot, &pump_resource);
	otCoapAddResource(srv_context.ot, &data_resource);
	otCoapAddResource(srv_context.ot, &info_resource);

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
