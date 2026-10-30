/*
 * Yann T.
 *
 * coap_resources.c
 *
 * CoAP resources served over OpenThread. Each resource is one entry in 'resources':
 * its URI, the requests it accepts and a handler. A shared dispatcher checks the
 * request type and code, so the handlers only deal with payloads.
 */

#include <openthread/coap.h>
#include <openthread/message.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/openthread.h>
#include <zephyr/sys/util.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "coap_resources.h"

LOG_MODULE_REGISTER(coap_resources, CONFIG_COAP_RESOURCES_LOG_LEVEL);

/* Requests a resource accepts */
#define ALLOW_GET BIT(0)     // confirmable or not
#define ALLOW_PUT_CON BIT(1) // confirmable PUT
#define ALLOW_PUT_NON BIT(2) // non-confirmable PUT
#define ALLOW_PUT (ALLOW_PUT_CON | ALLOW_PUT_NON)

struct coap_resource
{
	otCoapResource ot; // linked into OpenThread's resource list, so not const
	uint8_t allowed;
	void (*handle)(otMessage *request, const otMessageInfo *response_info, otCoapCode code);
};

static otInstance *ot_instance;
static const struct coap_resources_handlers *app;

/* Sends a response to 'request', with an optional payload.
 *
 * A confirmable request gets a piggybacked ACK, any other request a NON response.
 * otCoapMessageInitResponse() already copies the request's message ID and token,
 * so the token must not be set again (doing so grows the header a second time and
 * leaves uninitialized bytes in front of the payload).
 */
static otError response_send(otMessage *request, const otMessageInfo *response_info,
			     otCoapCode code, const void *payload, uint16_t payload_size)
{
	otError error = OT_ERROR_NO_BUFS;
	otMessage *response;
	otCoapType type = (otCoapMessageGetType(request) == OT_COAP_TYPE_CONFIRMABLE)
				  ? OT_COAP_TYPE_ACKNOWLEDGMENT
				  : OT_COAP_TYPE_NON_CONFIRMABLE;

	response = otCoapNewMessage(ot_instance, NULL);
	if (response == NULL)
	{
		LOG_INF("Error in otCoapNewMessage()");
		goto end;
	}

	error = otCoapMessageInitResponse(response, request, type, code);
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

	error = otCoapSendResponse(ot_instance, response, response_info);
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

/* Reads the first payload byte of 'request'. Returns false if there is no payload. */
static bool payload_read_byte(otMessage *request, uint8_t *value)
{
	return otMessageRead(request, otMessageGetOffset(request), value, 1) == 1;
}

/* 'pumpdc' GET/PUT: the pump run time in seconds (PUT payload: one ASCII digit) */
static void handle_pumpdc(otMessage *request, const otMessageInfo *response_info, otCoapCode code)
{
	uint8_t value;
	uint8_t duration;

	if (code == OT_COAP_CODE_PUT)
	{
		if (!payload_read_byte(request, &value))
		{
			LOG_ERR("'pumpdc' PUT without payload");
			return;
		}
		LOG_INF("Received 'pumpdc' PUT request: %c seconds", value);
		duration = app->pumpdc_put(value);
	}
	else
	{
		LOG_INF("Received 'pumpdc' GET request");
		duration = app->pumpdc_get();
	}

	response_send(request, response_info, OT_COAP_CODE_CONTENT, &duration, sizeof(duration));
}

/* 'pump' GET/PUT: pump state, 1 while running (PUT payload: '0' or '1') */
static void handle_pump(otMessage *request, const otMessageInfo *response_info, otCoapCode code)
{
	uint8_t command;
	uint8_t running;

	if (code == OT_COAP_CODE_PUT)
	{
		if (!payload_read_byte(request, &command))
		{
			LOG_ERR("'pump' PUT without payload");
			return;
		}
		LOG_INF("Received 'pump' PUT request: %c", command);
		app->pump_put(command);
	}
	else
	{
		LOG_INF("Received 'pump' GET request");
	}

	running = app->pump_get() ? 1 : 0;
	response_send(request, response_info, OT_COAP_CODE_CONTENT, &running, sizeof(running));
}

/* 'data' GET: the latest sensor readings */
static void handle_data(otMessage *request, const otMessageInfo *response_info, otCoapCode code)
{
	uint8_t payload[DATA_PAYLOAD_SIZE];

	ARG_UNUSED(code);

	LOG_INF("Received 'data' GET request");
	app->data_get(payload);
	response_send(request, response_info, OT_COAP_CODE_CONTENT, payload, sizeof(payload));
}

/* 'info' GET: "<fw_version>,<hw_version>,<device_id>" */
static void handle_info(otMessage *request, const otMessageInfo *response_info, otCoapCode code)
{
	char payload[INFO_PAYLOAD_MAX_SIZE];
	struct coap_info info;
	int len;

	ARG_UNUSED(code);

	LOG_DBG("Received 'info' GET request");
	info = app->info_get();
	len = snprintf(payload, sizeof(payload), "%s,%s,%s", info.fw_version, info.hw_version, info.device_id);
	if (len < 0)
	{
		return;
	}
	len = MIN(len, (int)sizeof(payload) - 1);

	/* The payload includes the string's NUL terminator, as it always has. */
	if (response_send(request, response_info, OT_COAP_CODE_CONTENT, payload, len + 1) == OT_ERROR_NONE)
	{
		LOG_INF("Device info is: %s", payload);
	}
}

/* 'ping' PUT: answers with 2.04 Changed, and beeps if the payload is '1' */
static void handle_ping(otMessage *request, const otMessageInfo *response_info, otCoapCode code)
{
	uint8_t command;

	ARG_UNUSED(code);

	LOG_INF("Received 'ping' PUT request");
	if (!payload_read_byte(request, &command))
	{
		LOG_ERR("'ping' PUT without payload");
		return;
	}
	app->ping_put(command);
	response_send(request, response_info, OT_COAP_CODE_CHANGED, NULL, 0);
}

/* 'diag' GET: restarts, crashes and the link to the parent, as "key=value,..." (see diag.h) */
static void handle_diag(otMessage *request, const otMessageInfo *response_info, otCoapCode code)
{
	char payload[DIAG_PAYLOAD_MAX_SIZE];
	size_t length;

	ARG_UNUSED(code);

	LOG_DBG("Received 'diag' GET request");
	length = app->diag_get(payload, sizeof(payload));
	response_send(request, response_info, OT_COAP_CODE_CONTENT, payload, (uint16_t)length);
}

/* The number in the "from=<n>" Uri-Query option of 'request', or 0 without one. */
static uint32_t query_from(otMessage *request)
{
	static const char prefix[] = "from=";
	otCoapOptionIterator iterator;
	const otCoapOption *option;
	char value[24];

	if (otCoapOptionIteratorInit(&iterator, request) != OT_ERROR_NONE)
	{
		return 0U;
	}
	for (option = otCoapOptionIteratorGetFirstOptionMatching(&iterator, OT_COAP_OPTION_URI_QUERY); option != NULL;
	     option = otCoapOptionIteratorGetNextOptionMatching(&iterator, OT_COAP_OPTION_URI_QUERY))
	{
		if ((option->mLength >= sizeof(value)) ||
		    (otCoapOptionIteratorGetOptionValue(&iterator, value) != OT_ERROR_NONE))
		{
			continue;
		}
		value[option->mLength] = '\0';
		if (strncmp(value, prefix, sizeof(prefix) - 1) == 0)
		{
			return (uint32_t)strtoul(&value[sizeof(prefix) - 1], NULL, 10);
		}
	}

	return 0U;
}

/* 'log' GET: the latest log output, from the offset in its "from=<n>" query (see log_buffer.h).
 * Nothing is logged here, or every read would add to the log it reads. */
static void handle_log(otMessage *request, const otMessageInfo *response_info, otCoapCode code)
{
	static char payload[LOG_PAYLOAD_MAX_SIZE]; // only used from the OpenThread thread
	size_t length;

	ARG_UNUSED(code);

	if (app->log_get == NULL)
	{
		response_send(request, response_info, OT_COAP_CODE_NOT_FOUND, NULL, 0);
		return;
	}
	length = app->log_get(query_from(request), payload, sizeof(payload));
	response_send(request, response_info, OT_COAP_CODE_CONTENT, payload, (uint16_t)length);
}

static struct coap_resource resources[] = {
	{.ot = {.mUriPath = "pumpdc"}, .allowed = ALLOW_GET | ALLOW_PUT_CON, .handle = handle_pumpdc},
	{.ot = {.mUriPath = "pump"}, .allowed = ALLOW_GET | ALLOW_PUT_CON, .handle = handle_pump},
	{.ot = {.mUriPath = "data"}, .allowed = ALLOW_GET, .handle = handle_data},
	{.ot = {.mUriPath = "info"}, .allowed = ALLOW_GET, .handle = handle_info},
	{.ot = {.mUriPath = "ping"}, .allowed = ALLOW_PUT, .handle = handle_ping},
	{.ot = {.mUriPath = "diag"}, .allowed = ALLOW_GET, .handle = handle_diag},
	{.ot = {.mUriPath = "log"}, .allowed = ALLOW_GET, .handle = handle_log},
};

/* Returns true if 'resource' accepts a request of this type and code. */
static bool request_allowed(const struct coap_resource *resource, otCoapType type, otCoapCode code)
{
	bool confirmable = (type == OT_COAP_TYPE_CONFIRMABLE);

	if (!confirmable && (type != OT_COAP_TYPE_NON_CONFIRMABLE))
	{
		return false;
	}
	switch (code)
	{
	case OT_COAP_CODE_GET:
		return (resource->allowed & ALLOW_GET) != 0;
	case OT_COAP_CODE_PUT:
		return (resource->allowed & (confirmable ? ALLOW_PUT_CON : ALLOW_PUT_NON)) != 0;
	default:
		return false;
	}
}

/* OpenThread handler shared by all resources ('context' is the resource). */
static void on_request(void *context, otMessage *request, const otMessageInfo *message_info)
{
	const struct coap_resource *resource = context;
	otCoapType type = otCoapMessageGetType(request);
	otCoapCode code = otCoapMessageGetCode(request);
	otMessageInfo response_info;

	if (!request_allowed(resource, type, code))
	{
		LOG_INF("Bad '%s' request type or code (%d, %d)", resource->ot.mUriPath, type, code);
		return;
	}

	/* Reply from the address the request was received on. */
	response_info = *message_info;
	memset(&response_info.mSockAddr, 0, sizeof(response_info.mSockAddr));

	resource->handle(request, &response_info, code);
}

/* Handler for requests that match no resource */
static void on_unknown_request(void *context, otMessage *request, const otMessageInfo *message_info)
{
	ARG_UNUSED(context);
	ARG_UNUSED(request);
	ARG_UNUSED(message_info);

	LOG_INF("Received CoAP message that does not match any request or resource");
}

int coap_resources_init(const struct coap_resources_handlers *handlers)
{
	otError error;

	app = handlers;
	ot_instance = openthread_get_default_instance();
	if (ot_instance == NULL)
	{
		LOG_ERR("There is no valid OpenThread instance");
		return -ENODEV;
	}

	otCoapSetDefaultHandler(ot_instance, on_unknown_request, NULL);
	for (size_t i = 0U; i < ARRAY_SIZE(resources); i++)
	{
		resources[i].ot.mHandler = on_request;
		resources[i].ot.mContext = &resources[i];
		otCoapAddResource(ot_instance, &resources[i].ot);
	}

	error = otCoapStart(ot_instance, COAP_PORT);
	if (error != OT_ERROR_NONE)
	{
		LOG_ERR("Failed to start OT CoAP. Error: %d", error);
		return -EIO;
	}
	LOG_INF("CoAP server has started");

	return 0;
}
