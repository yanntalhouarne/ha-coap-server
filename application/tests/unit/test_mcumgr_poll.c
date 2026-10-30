/*
 * test_mcumgr_poll.c
 *
 * Fast Thread polling while mcumgr is in use (src/mcumgr_poll.c).
 */

#include "test.h"

#include "../../src/mcumgr_poll.c"

static void reset_module(void)
{
	fast_polling = false;
	fast_poll_work.pending = false;
	normal_poll_work.scheduled = false;
	normal_poll_work.schedules = 0;
	mcumgr_poll_init();
}

static void test_registers_for_mcumgr_requests(void)
{
	reset_module();
	CHECK(fake_mgmt_callback != NULL);
	CHECK_EQ(fake_mgmt_callback->event_id, MGMT_EVT_OP_CMD_RECV);
}

static void test_a_request_switches_to_fast_polling(void)
{
	reset_module();
	CHECK_EQ(fake_mgmt_notify(MGMT_EVT_OP_CMD_RECV), MGMT_ERR_EOK);

	/* The callback only queues work: OpenThread is called from the work queue. */
	CHECK_EQ(fake_poll_period_sets, 0);
	CHECK(fast_poll_work.pending);
	CHECK(normal_poll_work.scheduled);
	CHECK_EQ(normal_poll_work.delay_ms, (int64_t)CONFIG_HACOAP_MCUMGR_POLL_TIMEOUT_S * 1000);

	fake_work_run(&fast_poll_work);
	CHECK_EQ(fake_poll_period_ms, CONFIG_HACOAP_MCUMGR_POLL_PERIOD_MS);
	CHECK_EQ(fake_ot_api_lock_depth, 0);
	CHECK_EQ(fake_ot_api_locks, 1);
}

static void test_polling_goes_back_to_normal_after_the_timeout(void)
{
	reset_module();
	fake_mgmt_notify(MGMT_EVT_OP_CMD_RECV);
	fake_work_run(&fast_poll_work);

	fake_dwork_run(&normal_poll_work);
	CHECK_EQ(fake_poll_period_ms, CONFIG_OPENTHREAD_POLL_PERIOD);
	CHECK(!fast_polling);
	CHECK_EQ(fake_ot_api_lock_depth, 0);
}

static void test_each_request_restarts_the_timeout(void)
{
	reset_module();
	fake_mgmt_notify(MGMT_EVT_OP_CMD_RECV);
	fake_work_run(&fast_poll_work);
	fake_mgmt_notify(MGMT_EVT_OP_CMD_RECV);
	fake_mgmt_notify(MGMT_EVT_OP_CMD_RECV);

	CHECK_EQ(normal_poll_work.schedules, 3);
	CHECK(normal_poll_work.scheduled);
}

static void test_poll_period_is_set_once_per_session(void)
{
	reset_module();
	for (int i = 0; i < 5; i++)
	{
		fake_mgmt_notify(MGMT_EVT_OP_CMD_RECV);
		fake_work_run(&fast_poll_work);
	}
	CHECK_EQ(fake_poll_period_sets, 1);

	fake_dwork_run(&normal_poll_work);
	CHECK_EQ(fake_poll_period_sets, 2);

	/* A new session switches to fast polling again. */
	fake_mgmt_notify(MGMT_EVT_OP_CMD_RECV);
	fake_work_run(&fast_poll_work);
	CHECK_EQ(fake_poll_period_ms, CONFIG_HACOAP_MCUMGR_POLL_PERIOD_MS);
	CHECK_EQ(fake_poll_period_sets, 3);
}

static void test_hold_polls_fast_like_an_mcumgr_request(void)
{
	reset_module();
	mcumgr_poll_hold();
	CHECK(fast_poll_work.pending);
	CHECK(normal_poll_work.scheduled);
	CHECK_EQ(normal_poll_work.delay_ms, (int64_t)CONFIG_HACOAP_MCUMGR_POLL_TIMEOUT_S * 1000);

	fake_work_run(&fast_poll_work);
	CHECK_EQ(fake_poll_period_ms, CONFIG_HACOAP_MCUMGR_POLL_PERIOD_MS);

	/* Log reads and mcumgr requests share one session. */
	fake_mgmt_notify(MGMT_EVT_OP_CMD_RECV);
	mcumgr_poll_hold();
	fake_work_run(&fast_poll_work);
	CHECK_EQ(fake_poll_period_sets, 1);
	CHECK_EQ(normal_poll_work.schedules, 3);
}

int main(void)
{
	RUN_TEST(test_registers_for_mcumgr_requests);
	RUN_TEST(test_a_request_switches_to_fast_polling);
	RUN_TEST(test_polling_goes_back_to_normal_after_the_timeout);
	RUN_TEST(test_each_request_restarts_the_timeout);
	RUN_TEST(test_poll_period_is_set_once_per_session);
	RUN_TEST(test_hold_polls_fast_like_an_mcumgr_request);
	return TEST_RESULT();
}
