/*
 * test_joining.c
 *
 * Joining the Thread network again until the device has one, and forgetting it (src/joining.c).
 */

#include "test.h"

#include "../../src/joining.c"

/* ---------------------------------------------------------------- fake SRP */

static bool fake_registered; // srp_unregister() has something to remove
static int unregisters;

bool srp_unregister(otInstance *instance)
{
	(void)instance;
	unregisters++;
	return fake_registered;
}

static void reset_module(void)
{
	attempts = 0;
	unregistering = false;
	fake_registered = false;
	unregisters = 0;
	retry_work.scheduled = false;
	retry_work.schedules = 0;
	forget_work.scheduled = false;
}

static void test_a_device_with_a_network_doesnt_join(void)
{
	reset_module();
	fake_commissioned = true;
	joining_start();
	CHECK(!retry_work.scheduled);
	CHECK(joining_has_network());
	CHECK_EQ(fake_ot_api_lock_depth, 0);
}

static void test_it_tries_again_until_it_joins(void)
{
	reset_module();
	joining_start();
	CHECK(!joining_has_network());
	/* The SDK's joiner tries at boot: the next try after the retry period */
	CHECK(retry_work.scheduled);
	CHECK_EQ(retry_work.delay_ms, (int64_t)CONFIG_HACOAP_JOIN_RETRY_S * 1000);
	CHECK_EQ(fake_joiner_starts, 0);

	fake_dwork_run(&retry_work);
	CHECK_EQ(fake_joiner_starts, 1);
	CHECK_STR(fake_joiner_pskd, CONFIG_OPENTHREAD_JOINER_PSKD);
	CHECK(retry_work.scheduled); // and again, until it has a network
	CHECK_EQ(fake_ot_api_lock_depth, 0);

	/* Still trying: not started twice */
	fake_dwork_run(&retry_work);
	CHECK_EQ(fake_joiner_starts, 1);

	/* That try failed: the next one starts */
	fake_joiner_state = OT_JOINER_STATE_IDLE;
	fake_joiner_callback(OT_ERROR_FAILED, fake_joiner_context);
	CHECK_EQ(fake_thread_enables, 0);
	fake_dwork_run(&retry_work);
	CHECK_EQ(fake_joiner_starts, 2);

	/* It joins: Thread starts, and the tries stop */
	fake_joiner_callback(OT_ERROR_NONE, fake_joiner_context);
	CHECK_EQ(fake_thread_enables, 1);
	fake_commissioned = true;
	fake_dwork_run(&retry_work);
	CHECK(!retry_work.scheduled);
	CHECK_EQ(fake_joiner_starts, 2);
}

static void test_tries_slow_down_after_a_while(void)
{
	reset_module();
	joining_start();
	fake_uptime_ms = (int64_t)CONFIG_HACOAP_JOIN_RETRY_FAST_FOR_S * 1000 + 1;
	fake_dwork_run(&retry_work);
	CHECK_EQ(retry_work.delay_ms, (int64_t)CONFIG_HACOAP_JOIN_RETRY_SLOW_S * 1000);
}

static void test_a_joiner_that_cant_start_is_tried_again(void)
{
	reset_module();
	joining_start();
	fake_joiner_start_error = OT_ERROR_INVALID_ARGS;
	fake_dwork_run(&retry_work);
	CHECK_EQ(fake_joiner_starts, 1);
	CHECK(retry_work.scheduled);
	CHECK_EQ(fake_ot_api_lock_depth, 0);
}

static void test_forgetting_erases_the_network_but_not_the_srp_key(void)
{
	static const uint16_t expected[] = {OT_SETTINGS_KEY_ACTIVE_DATASET, OT_SETTINGS_KEY_PENDING_DATASET,
					    OT_SETTINGS_KEY_NETWORK_INFO,   OT_SETTINGS_KEY_PARENT_INFO,
					    OT_SETTINGS_KEY_CHILD_INFO,     OT_SETTINGS_KEY_DAD_INFO,
					    OT_SETTINGS_KEY_SRP_CLIENT_INFO};

	reset_module();
	joining_forget(1000);
	CHECK(forget_work.scheduled);
	CHECK_EQ(forget_work.delay_ms, 1000);
	CHECK_EQ(fake_reboots, 0); // not before the answer went out

	fake_dwork_run(&forget_work); // not registered (S1 at boot): at once
	CHECK(!fake_thread_enabled && !fake_ip6_enabled); // stopped first
	CHECK_EQ(fake_ot_deleted_key_count, ARRAY_SIZE(expected));
	CHECK(memcmp(fake_ot_deleted_keys, expected, sizeof(expected)) == 0);
	for (int i = 0; i < fake_ot_deleted_key_count; i++)
	{
		CHECK(fake_ot_deleted_keys[i] != OT_SETTINGS_KEY_SRP_ECDSA_KEY);
	}
	CHECK_EQ(fake_factory_resets, 0);
	CHECK_EQ(fake_reboots, 1);
	CHECK_EQ(fake_ot_api_lock_depth, 0);
}

static void test_a_registered_board_unregisters_first(void)
{
	reset_module();
	fake_registered = true;
	joining_forget(1000);
	fake_dwork_run(&forget_work);
	CHECK_EQ(unregisters, 1);
	CHECK_EQ(fake_reboots, 0); // the removal goes out first
	CHECK(forget_work.scheduled);
	CHECK_EQ(forget_work.delay_ms, UNREGISTER_WAIT_MS);
	CHECK_EQ(fake_ot_api_lock_depth, 0);

	fake_dwork_run(&forget_work);
	CHECK_EQ(unregisters, 1); // once
	CHECK_EQ(fake_ot_deleted_key_count, 7);
	CHECK_EQ(fake_reboots, 1);
}

int main(void)
{
	RUN_TEST(test_a_device_with_a_network_doesnt_join);
	RUN_TEST(test_it_tries_again_until_it_joins);
	RUN_TEST(test_tries_slow_down_after_a_while);
	RUN_TEST(test_a_joiner_that_cant_start_is_tried_again);
	RUN_TEST(test_forgetting_erases_the_network_but_not_the_srp_key);
	RUN_TEST(test_a_registered_board_unregisters_first);
	return TEST_RESULT();
}
