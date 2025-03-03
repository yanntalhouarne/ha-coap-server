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
	.pump_dc = 1,
	.pump_active = false,
	.on_pumpdc_request = NULL,
	.on_pump_request = NULL,
	.on_data_request = NULL,
	.on_ping_request = NULL,
};

/*
 ██████  ██████   █████  ██████      ██████  ███████ ███████  ██████  ██    ██ ██████   ██████ ███████ ███████
██      ██    ██ ██   ██ ██   ██     ██   ██ ██      ██      ██    ██ ██    ██ ██   ██ ██      ██      ██
██      ██    ██ ███████ ██████      ██████  █████   ███████ ██    ██ ██    ██ ██████  ██      █████   ███████
██      ██    ██ ██   ██ ██          ██   ██ ██           ██ ██    ██ ██    ██ ██   ██ ██      ██           ██
 ██████  ██████  ██   ██ ██          ██   ██ ███████ ███████  ██████   ██████  ██   ██  ██████ ███████ ███████
*/

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
/**@brief Definition of CoAP resources for 'pumpdc'. */
otCoapResource pumpdc_resource = {
	.mUriPath = PUMPDC_URI_PATH,
	.mHandler = NULL,
	.mContext = NULL,
	.mNext = NULL,
};

/*
  _ __  _   _ _ __ ___  _ __
 | '_ \| | | | '_ ` _ \| '_ \
 | |_) | |_| | | | | | | |_) |
 | .__/ \__,_|_| |_| |_| .__/
 | |                   | |
 |_|                   |_|
*/
/**@brief Definition of CoAP resources for 'pump'. */
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
/**@brief Definition of CoAP resource 'data'. */
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
/**@brief Definition of CoAP resource 'info'. */
otCoapResource info_resource = {
	.mUriPath = INFO_URI_PATH,
	.mHandler = NULL,
	.mContext = NULL,
	.mNext = NULL,
};

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
/**@brief Definition of CoAP resource 'ping'. */
otCoapResource ping_resource = {
	.mUriPath = PING_URI_PATH,
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
	otMessageInfo msg_info;

	uint8_t isTypePut = 0;
	uint8_t new_pumdc = 0;

	ARG_UNUSED(context);
	if ((otCoapMessageGetType(message) == OT_COAP_TYPE_CONFIRMABLE) && (otCoapMessageGetCode(message) == OT_COAP_CODE_PUT))
	{
		isTypePut = 1;
	}
	else if (((otCoapMessageGetType(message) == OT_COAP_TYPE_NON_CONFIRMABLE) || (otCoapMessageGetType(message) == OT_COAP_TYPE_CONFIRMABLE)) && (otCoapMessageGetCode(message) == OT_COAP_CODE_GET))
	{
		isTypePut = 0;
	}
	else
	{
		LOG_INF("Bad 'pumpdc' request type/code.");
		goto end;
	}

	msg_info = *message_info;
	memset(&msg_info.mSockAddr, 0, sizeof(msg_info.mSockAddr));

	if (isTypePut)
	{
		if (otMessageRead(message, otMessageGetOffset(message), &data, 1) != 1)
		{
			LOG_ERR("'pumpdc' handler - Missing 'pumpdc' data");
			goto end;
		}
		new_pumdc = srv_context.on_pumpdc_request(data); // update 'pump' in coap_server.c
		LOG_INF("Received 'pumpdc' PUT request: %c seconds", data);
		pumpdc_put_response_send(message, &msg_info, new_pumdc);
	}
	else
	{
		LOG_INF("Received 'pumpdc' GET request");
		pumpdc_get_response_send(message, &msg_info);
	}

end:
	return;
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
	else if (((otCoapMessageGetType(message) == OT_COAP_TYPE_NON_CONFIRMABLE) || (otCoapMessageGetType(message) == OT_COAP_TYPE_CONFIRMABLE)) && (otCoapMessageGetCode(message) == OT_COAP_CODE_GET))
	{
		isTypePut = 0;
	}
	else
	{
		LOG_INF("Bad 'pump' request type/code.");
		goto end;
	}

	msg_info = *message_info;
	memset(&msg_info.mSockAddr, 0, sizeof(msg_info.mSockAddr));

	if (isTypePut)
	{
		if (otMessageRead(message, otMessageGetOffset(message), &command, 1) != 1)
		{
			LOG_ERR("'pump' handler - Missing 'pump' command");
			goto end;
		}
		srv_context.on_pump_request(command); // update 'pump' in coap_server.c
		LOG_INF("Received 'pump' PUT request: %c", command);
		pump_put_response_send(message, &msg_info);
	}
	else
	{
		LOG_INF("Received 'pump' GET request");
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

	LOG_INF("Received 'data' request");

	if (((otCoapMessageGetType(message) == OT_COAP_TYPE_NON_CONFIRMABLE) || (otCoapMessageGetType(message) == OT_COAP_TYPE_CONFIRMABLE)) && (otCoapMessageGetCode(message) == OT_COAP_CODE_GET))
	{
		msg_info = *message_info;
		memset(&msg_info.mSockAddr, 0, sizeof(msg_info.mSockAddr));

		data_response_send(message, &msg_info);
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
	otError error;
	otMessageInfo msg_info;

	ARG_UNUSED(context);

	LOG_DBG("Received 'info' request");

	if (((otCoapMessageGetType(message) == OT_COAP_TYPE_CONFIRMABLE) || (otCoapMessageGetType(message) == OT_COAP_TYPE_CONFIRMABLE)) && (otCoapMessageGetCode(message) == OT_COAP_CODE_GET))
	{
		msg_info = *message_info;
		memset(&msg_info.mSockAddr, 0, sizeof(msg_info.mSockAddr));

		info_response_send(message, &msg_info);
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
/**@brief Ping request handler (GET) */
void ping_request_handler(void *context, otMessage *message, const otMessageInfo *message_info)
{
	otError error;
	otMessageInfo msg_info;

	uint8_t command;

	ARG_UNUSED(context);

	LOG_INF("Received 'ping' request");

	if (((otCoapMessageGetType(message) == OT_COAP_TYPE_CONFIRMABLE) || (otCoapMessageGetType(message) == OT_COAP_TYPE_NON_CONFIRMABLE)) && (otCoapMessageGetCode(message) == OT_COAP_CODE_PUT))
	{
		msg_info = *message_info;
		memset(&msg_info.mSockAddr, 0, sizeof(msg_info.mSockAddr));

		if (otMessageRead(message, otMessageGetOffset(message), &command, 1) != 1)
		{
			LOG_ERR("'ping' handler - Missing 'ping' command");
			goto end;
		}

		srv_context.on_ping_request(command); // update 'pump' in coap_server.c

		ping_response_send(message, &msg_info);
	}
	else
	{
		LOG_INF("Bad 'ping' request type or code.");
	}
	end:
		return;
}

/*
██████  ███████ ███████ ██████   ██████  ███    ██ ███████ ███████     ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
██   ██ ██      ██      ██   ██ ██    ██ ████   ██ ██      ██          ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
██████  █████   ███████ ██████  ██    ██ ██ ██  ██ ███████ █████       ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
██   ██ ██           ██ ██      ██    ██ ██  ██ ██      ██ ██          ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
██   ██ ███████ ███████ ██       ██████  ██   ████ ███████ ███████     ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████
*/
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
/**@brief Pumpdc PUT response with pump duty-cycle value in seconds. */
otError pumpdc_put_response_send(otMessage *request_message, const otMessageInfo *message_info, uint8_t pumpc_dc)
{
	otError error = OT_ERROR_NO_BUFS;
	otMessage *response;
	const void *payload;
	uint16_t payload_size;
	uint8_t pump_dutycycle = pumpc_dc;

	// create response message
	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		LOG_INF("Error in otCoapNewMessage()");
		goto end;
	}

	// init response message
	otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_ACKNOWLEDGMENT,
							  OT_COAP_CODE_CONTENT);

	// set message payload marker
	error = otCoapMessageSetPayloadMarker(response);
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otCoapMessageSetPayloadMarker()");
		goto end;
	}

	payload = &pump_dutycycle;
	payload_size = sizeof(pump_dutycycle);

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

	LOG_DBG("'pumpdc' PUT response sent: %d", pump_dutycycle);

end:
	if (error != OT_ERROR_NONE && response != NULL)
	{
		LOG_INF("Couldn't send 'pumpdc' response");
		otMessageFree(response);
	}
	return error;
}
/**@brief Pump GET response with pump state date. */
otError pumpdc_get_response_send(otMessage *request_message, const otMessageInfo *message_info)
{
	otError error = OT_ERROR_NO_BUFS;
	otMessage *response;
	const void *payload;
	uint16_t payload_size;
	uint8_t val = coap_get_pumpdc();

	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		goto end;
	}

	if (otCoapMessageGetType(request_message) == OT_COAP_TYPE_CONFIRMABLE)
		otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_ACKNOWLEDGMENT, OT_COAP_CODE_CONTENT);
	else
		otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_NON_CONFIRMABLE, OT_COAP_CODE_CONTENT);

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

	LOG_INF("'pumpdc' GET response sent: %d", val);

end:
	if (error != OT_ERROR_NONE && response != NULL)
	{
		otMessageFree(response);
		LOG_INF("Couldn't send 'pumpdc'' GET response");
	}

	return error;
}
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
	uint8_t pump_status = 0;

	// create response message
	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		LOG_INF("Error in otCoapNewMessage()");
		goto end;
	}

	// init response message
	otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_ACKNOWLEDGMENT,
							  OT_COAP_CODE_CONTENT);

	// set message payload marker
	error = otCoapMessageSetPayloadMarker(response);
	if (error != OT_ERROR_NONE)
	{
		LOG_INF("Error in otCoapMessageSetPayloadMarker()");
		goto end;
	}

	// update payload
	if (coap_is_pump_active())
		pump_status = 1;

	payload = &pump_status;
	payload_size = sizeof(pump_status);

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

	LOG_DBG("'pump' PUT response sent: %d", pump_status);

end:
	if (error != OT_ERROR_NONE && response != NULL)
	{
		LOG_INF("Couldn't send 'pump' response");
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

	if (otCoapMessageGetType(request_message) == OT_COAP_TYPE_CONFIRMABLE)
		otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_ACKNOWLEDGMENT, OT_COAP_CODE_CONTENT);
	else
		otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_NON_CONFIRMABLE, OT_COAP_CODE_CONTENT);

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

	LOG_INF("'pump' GET response sent: %d", val);

end:
	if (error != OT_ERROR_NONE && response != NULL)
	{
		otMessageFree(response);
		LOG_INF("Couldn't send 'pump'' GET response");
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

	data_buf = srv_context.on_data_request(); // get 'data' buffer from coap_server.c

	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		goto end;
	}

	if (otCoapMessageGetType(request_message) == OT_COAP_TYPE_CONFIRMABLE)
		otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_ACKNOWLEDGMENT, OT_COAP_CODE_CONTENT);
	else
		otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_NON_CONFIRMABLE, OT_COAP_CODE_CONTENT);

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

	LOG_DBG("'data' response sent.");

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
	_info = srv_context.on_info_request(); // get 'info' buffer from coap_server.c

	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		goto end;
	}

	if (otCoapMessageGetType(request_message) == OT_COAP_TYPE_CONFIRMABLE)
		otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_ACKNOWLEDGMENT, OT_COAP_CODE_CONTENT);
	else
		otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_NON_CONFIRMABLE, OT_COAP_CODE_CONTENT);

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

	char info_output[50] = {0};
		snprintf(info_output, _info.total_size, "%s,%s", _info.fw_version_buf, _info.hw_version_buf);
		payload = &info_output;
		payload_size = _info.total_size;
	
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
        _             
       (_)            
  _ __  _ _ __   __ _ 
 | '_ \| | '_ \ / _` |
 | |_) | | | | | (_| |
 | .__/|_|_| |_|\__, |
 | |             __/ |
 |_|            |___/ 
*/
/**@brief Ping PUT response with no payload. */
otError ping_response_send(otMessage *request_message, const otMessageInfo *message_info)
{
	otError error = OT_ERROR_NO_BUFS;
	otMessage *response;
	const void *payload;
	uint16_t payload_size;
	struct info_data _info;
	_info = srv_context.on_info_request(); // get 'info' buffer from coap_server.c

	response = otCoapNewMessage(srv_context.ot, NULL);
	if (response == NULL)
	{
		goto end;
	}

	if (otCoapMessageGetType(request_message) == OT_COAP_TYPE_CONFIRMABLE)
		otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_ACKNOWLEDGMENT, OT_COAP_CODE_CHANGED);
	else
		otCoapMessageInitResponse(response, request_message, OT_COAP_TYPE_NON_CONFIRMABLE, OT_COAP_CODE_CHANGED);

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

	// char ping_data = '1';
	// payload = &ping_data;
	// payload_size = sizeof(ping_data);
	
	// error = otMessageAppend(response, payload, payload_size);
	// if (error != OT_ERROR_NONE)
	// {
	// 	goto end;
	// }

	error = otCoapSendResponse(srv_context.ot, response, message_info);

	//LOG_INF("Ping payload is: %s", ping_data);

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
