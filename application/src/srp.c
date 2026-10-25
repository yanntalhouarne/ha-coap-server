/*
 * Yann T.
 *
 * srp.c
 *
 * SRP client: advertises the CoAP service as "<instance>._ot._udp" on host "<hostname>".
 */

#include <openthread/srp_client.h>
#include <openthread/srp_client_buffers.h>
#include <openthread/thread.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/random/rand32.h>
#include <stdio.h>

#include "coap_resources.h"
#include "srp.h"

LOG_MODULE_DECLARE(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

#define SRP_NAME_MAX_SIZE 64 // OpenThread's default SRP client buffer size for host names

/* The SRP client keeps pointers to these, so they must stay valid. */
static char host_name[SRP_NAME_MAX_SIZE];
static char instance_name[SRP_NAME_MAX_SIZE];

static srp_registered_cb_t registered_cb;

/* Builds "<prefix>-<suffix>" (or just "<prefix>" without a suffix) into 'buf'. */
static void name_build(char *buf, size_t size, const char *prefix, const char *suffix)
{
	int len;

	if (suffix != NULL)
	{
		len = snprintf(buf, size, "%s-%s", prefix, suffix);
	}
	else
	{
		len = snprintf(buf, size, "%s", prefix);
	}
	if ((len < 0) || ((size_t)len >= size))
	{
		LOG_WRN("SRP name truncated to '%s'", buf);
	}
}

/* Generates the host and service instance names. They must be unique on the network. */
static void names_init(const char *device_id)
{
	const char *suffix = NULL;
	char random_id[9];

	if (IS_ENABLED(CONFIG_HACOAP_SRP_SUFFIX_DEVICE_ID))
	{
		LOG_INF("Appending device ID to hostname");
		suffix = device_id;
	}
	else if (IS_ENABLED(CONFIG_HACOAP_SRP_SUFFIX_RANDOM))
	{
		LOG_INF("Appending random number to hostname");
		snprintf(random_id, sizeof(random_id), "%x", (unsigned int)sys_rand32_get()); // true random, hw based
		suffix = random_id;
	}
#if defined(CONFIG_HACOAP_SRP_SUFFIX_MANUAL)
	else
	{
		LOG_INF("Appending manual ID to hostname");
		suffix = CONFIG_HACOAP_SRP_MANUAL_ID;
	}
#endif

	name_build(host_name, sizeof(host_name), CONFIG_HACOAP_SRP_HOSTNAME, suffix);
	name_build(instance_name, sizeof(instance_name), CONFIG_HACOAP_SRP_SERVICE_INSTANCE, suffix);
	LOG_INF("hostname is: %s", host_name);
	LOG_INF("service instance is: %s", instance_name);
}

/* SRP client callback */
static void on_srp_client_updated(otError aError, const otSrpClientHostInfo *aHostInfo, const otSrpClientService *aServices, const otSrpClientService *aRemovedServices, void *aContext)
{
	ARG_UNUSED(aHostInfo);
	ARG_UNUSED(aServices);
	ARG_UNUSED(aRemovedServices);
	ARG_UNUSED(aContext);

	LOG_INF("SRP callback: %s", otThreadErrorToString(aError));

	if ((aError == OT_ERROR_NONE) && (registered_cb != NULL))
	{
		registered_cb();
	}
}

void srp_start(otInstance *instance, const char *device_id, srp_registered_cb_t on_registered)
{
	otSrpClientBuffersServiceEntry *entry;
	uint16_t size;
	char *string;

	registered_cb = on_registered;
	names_init(device_id);
	otSrpClientSetCallback(instance, on_srp_client_updated, NULL);

	if (otSrpClientSetHostName(instance, host_name) != OT_ERROR_NONE)
	{
		LOG_INF("Cannot set SRP host name");
	}
	if (otSrpClientEnableAutoHostAddress(instance) != OT_ERROR_NONE)
	{
		LOG_INF("Cannot set SRP host address to auto");
	}

	/* The service strings live in buffers allocated by the OpenThread SRP API. */
	entry = otSrpClientBuffersAllocateService(instance);
	if (entry == NULL)
	{
		LOG_ERR("Cannot allocate SRP service buffers");
		return;
	}
	string = otSrpClientBuffersGetServiceEntryInstanceNameString(entry, &size);
	snprintf(string, size, "%s", instance_name);
	string = otSrpClientBuffersGetServiceEntryServiceNameString(entry, &size);
	snprintf(string, size, "%s", CONFIG_HACOAP_SRP_SERVICE_NAME);
	entry->mService.mNumTxtEntries = 0;
	entry->mService.mPort = COAP_PORT;

	if (otSrpClientAddService(instance, &entry->mService) != OT_ERROR_NONE)
	{
		LOG_INF("Cannot add service to SRP client");
	}
	else
	{
		LOG_INF("Adding SRP client service...");
	}

	/* The client then (re)registers on its own whenever a server is available. */
	otSrpClientEnableAutoStartMode(instance, NULL, NULL);
}
