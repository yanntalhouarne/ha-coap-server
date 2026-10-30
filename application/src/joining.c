/*
 * Yann T.
 *
 * joining.c
 *
 * Retries the Thread joiner until the device has a network, and forgets the network on
 * request (see joining.h). Runs from the system work queue; the joiner's callback runs in
 * the OpenThread thread.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/openthread.h>
#include <openthread/dataset.h>
#include <openthread/instance.h>
#include <openthread/joiner.h>
#include <openthread/thread.h>
#include <version.h>

#include "joining.h"

LOG_MODULE_DECLARE(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

BUILD_ASSERT(CONFIG_HACOAP_JOIN_RETRY_S <= CONFIG_HACOAP_JOIN_RETRY_SLOW_S,
	     "Joining retries can only slow down");

static int attempts; // since boot, after the SDK's own first one

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

static void on_forget_work(struct k_work *work)
{
	struct openthread_context *context = openthread_get_default_context();

	ARG_UNUSED(work);

	LOG_WRN("Forgetting the Thread network, then resetting");
	openthread_api_mutex_lock(context);
	otInstanceFactoryReset(context->instance); // wipes OpenThread's settings ("ot/...") and resets
	openthread_api_mutex_unlock(context);
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
