/*
 * Yann T.
 *
 * joining.c
 *
 * Retries the Thread joiner until the device has a network, and forgets the network on
 * request (see joining.h). Runs from the system work queue; the joiner's callback runs in
 * the OpenThread thread.
 *
 * Forgetting erases only the network: the datasets and the network, parent and child info.
 * Not the SRP key: the SRP server keeps a name for the key that registered it (14 days after
 * its last registration), so with a new key, the device couldn't take back "ha-coap-<ID>"
 * on the same border router. Attached, it first removes its registration, so its name
 * vanishes from the LAN at once.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/openthread.h>
#include <openthread/dataset.h>
#include <openthread/instance.h>
#include <openthread/ip6.h>
#include <openthread/joiner.h>
#include <openthread/platform/settings.h>
#include <openthread/thread.h>
#include <zephyr/sys/reboot.h>
#include <version.h>

#include "joining.h"
#include "srp.h"

LOG_MODULE_DECLARE(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

BUILD_ASSERT(CONFIG_HACOAP_JOIN_RETRY_S <= CONFIG_HACOAP_JOIN_RETRY_SLOW_S,
	     "Joining retries can only slow down");

#define UNREGISTER_WAIT_MS 3000 // for the SRP removal to reach the server, before the reset

static int attempts;       // since boot, after the SDK's own first one
static bool unregistering; // forgetting: the SRP removal was sent

/* The joiner's result, in the OpenThread thread (its lock is held) */
static void on_join_result(otError error, void *context)
{
	struct openthread_context *ot_context = context;

	if (error == OT_ERROR_NONE)
	{
		LOG_INF("Joined the Thread network");
		otThreadSetEnabled(ot_context->instance, true);
	}
	else
	{
		LOG_INF("Joining failed (error %d): no commissioner accepted it, trying again later", error);
	}
}

static k_timeout_t next_try(void)
{
	bool early = k_uptime_get() < (int64_t)CONFIG_HACOAP_JOIN_RETRY_FAST_FOR_S * MSEC_PER_SEC;

	return K_SECONDS(early ? CONFIG_HACOAP_JOIN_RETRY_S : CONFIG_HACOAP_JOIN_RETRY_SLOW_S);
}

static void on_retry_work(struct k_work *work)
{
	struct openthread_context *context = openthread_get_default_context();
	otError error = OT_ERROR_NONE;
	bool joined;

	openthread_api_mutex_lock(context);
	joined = otDatasetIsCommissioned(context->instance);
	/* Not while an attempt is still running (one takes up to a minute) */
	if (!joined && (otJoinerGetState(context->instance) == OT_JOINER_STATE_IDLE))
	{
		attempts++;
		LOG_INF("Joining the Thread network (try %d)", attempts + 1);
		error = otJoinerStart(context->instance, CONFIG_OPENTHREAD_JOINER_PSKD, NULL, "ha-coap",
				      CONFIG_HACOAP_HW_VERSION, GIT_COMMIT_HASH, NULL, on_join_result, context);
	}
	openthread_api_mutex_unlock(context);

	if (error != OT_ERROR_NONE)
	{
		LOG_ERR("Could not start the joiner (error %d)", error);
	}
	if (!joined)
	{
		k_work_schedule(k_work_delayable_from_work(work), next_try());
	}
}

static K_WORK_DELAYABLE_DEFINE(retry_work, on_retry_work);

/* Erases what makes the device part of its network, OpenThread stopped first (it saves its
 * network info as it stops). */
static void forget_network_data(otInstance *instance)
{
	static const uint16_t keys[] = {
		OT_SETTINGS_KEY_ACTIVE_DATASET, OT_SETTINGS_KEY_PENDING_DATASET, OT_SETTINGS_KEY_NETWORK_INFO,
		OT_SETTINGS_KEY_PARENT_INFO,    OT_SETTINGS_KEY_CHILD_INFO,      OT_SETTINGS_KEY_DAD_INFO,
		OT_SETTINGS_KEY_SRP_CLIENT_INFO, // the old network's SRP server
	};

	(void)otThreadSetEnabled(instance, false);
	(void)otIp6SetEnabled(instance, false);
	for (size_t i = 0U; i < ARRAY_SIZE(keys); i++)
	{
		(void)otPlatSettingsDelete(instance, keys[i], -1); // -1: every index; a missing one is fine
	}
}

static void on_forget_work(struct k_work *work)
{
	struct openthread_context *context = openthread_get_default_context();

	openthread_api_mutex_lock(context);
	if (!unregistering && srp_unregister(context->instance))
	{
		openthread_api_mutex_unlock(context);
		unregistering = true;
		LOG_INF("Forgetting the Thread network: removing the SRP registration first");
		k_work_schedule(k_work_delayable_from_work(work), K_MSEC(UNREGISTER_WAIT_MS));
		return;
	}
	LOG_WRN("Forgetting the Thread network, then resetting");
	forget_network_data(context->instance);
	openthread_api_mutex_unlock(context);

	sys_reboot(SYS_REBOOT_COLD);
}

static K_WORK_DELAYABLE_DEFINE(forget_work, on_forget_work);

bool joining_has_network(void)
{
	struct openthread_context *context = openthread_get_default_context();
	bool joined;

	openthread_api_mutex_lock(context);
	joined = otDatasetIsCommissioned(context->instance);
	openthread_api_mutex_unlock(context);

	return joined;
}

void joining_start(void)
{
	if (!joining_has_network())
	{
		/* The SDK's joiner is trying now: the next try after the retry period. */
		k_work_schedule(&retry_work, next_try());
	}
}

void joining_forget(int delay_ms)
{
	k_work_schedule(&forget_work, K_MSEC(delay_ms));
}
