/*
 * Yann T.
 *
 * mcumgr_poll.c
 *
 * Polls the Thread parent faster while mcumgr is in use, or the 'log' resource is read. A
 * sleepy device only receives a message when it polls, so at the normal poll period each
 * request of an image upload would wait for up to a full period.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/mgmt/mcumgr/mgmt/callbacks.h>
#include <zephyr/mgmt/mcumgr/mgmt/mgmt.h>
#include <zephyr/net/openthread.h>
#include <openthread/link.h>

#include "mcumgr_poll.h"

LOG_MODULE_DECLARE(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

BUILD_ASSERT(CONFIG_HACOAP_MCUMGR_POLL_PERIOD_MS < CONFIG_OPENTHREAD_POLL_PERIOD,
	     "The mcumgr poll period must be shorter than the normal one");

/* Only used from the system work queue */
static bool fast_polling;

static void set_poll_period(uint32_t period_ms)
{
	struct openthread_context *context = openthread_get_default_context();
	otError error;

	openthread_api_mutex_lock(context);
	error = otLinkSetPollPeriod(context->instance, period_ms);
	openthread_api_mutex_unlock(context);

	if (error != OT_ERROR_NONE)
	{
		LOG_ERR("Could not set the poll period to %u ms (error: %d)", period_ms, error);
	}
}

static void on_fast_poll_work(struct k_work *work)
{
	ARG_UNUSED(work);

	if (!fast_polling)
	{
		fast_polling = true;
		set_poll_period(CONFIG_HACOAP_MCUMGR_POLL_PERIOD_MS);
		LOG_INF("mcumgr or log reader: poll period %d ms", CONFIG_HACOAP_MCUMGR_POLL_PERIOD_MS);
	}
}

static void on_normal_poll_work(struct k_work *work)
{
	ARG_UNUSED(work);

	fast_polling = false;
	set_poll_period(CONFIG_OPENTHREAD_POLL_PERIOD);
	LOG_INF("mcumgr and log idle: poll period %d ms", CONFIG_OPENTHREAD_POLL_PERIOD);
}

static K_WORK_DEFINE(fast_poll_work, on_fast_poll_work);
static K_WORK_DELAYABLE_DEFINE(normal_poll_work, on_normal_poll_work);

void mcumgr_poll_hold(void)
{
	k_work_submit(&fast_poll_work);
	k_work_reschedule(&normal_poll_work, K_SECONDS(CONFIG_HACOAP_MCUMGR_POLL_TIMEOUT_S));
}

/* Called for every mcumgr request (USB or UDP), from the mcumgr thread */
static int32_t on_mcumgr_request(uint32_t event, int32_t rc, bool *abort_more, void *data,
				 size_t data_size)
{
	ARG_UNUSED(event);
	ARG_UNUSED(rc);
	ARG_UNUSED(abort_more);
	ARG_UNUSED(data);
	ARG_UNUSED(data_size);

	mcumgr_poll_hold();

	return MGMT_ERR_EOK;
}

static struct mgmt_callback mcumgr_request_cb = {
	.callback = on_mcumgr_request,
	.event_id = MGMT_EVT_OP_CMD_RECV,
};

void mcumgr_poll_init(void)
{
	mgmt_callback_register(&mcumgr_request_cb);
}
