/*
 * test_status_led.c
 *
 * The RGB LED's flash patterns and their timeout (src/status_led.c).
 */

#include "test.h"

#include "../../src/status_led.c"

#define TIMEOUT_MS ((int64_t)CONFIG_HACOAP_STATUS_LED_TIMEOUT_S * 1000)

static void reset_module(void)
{
	shown_state = STATUS_LED_OFF;
	error_shown = false;
	flash_until_ms = 0;
	flash_timer.running = false;
	flash_off_timer.running = false;
	(void)status_led_init();
}

static void check_rgb(int red, int green, int blue)
{
	CHECK_EQ(fake_leds[RED_LED], red);
	CHECK_EQ(fake_leds[GREEN_LED], green);
	CHECK_EQ(fake_leds[BLUE_LED], blue);
}

/* Fires the flash timer, checks the colors, then ends the flash. */
static void check_flash(int red, int green, int blue)
{
	CHECK(flash_timer.running);
	fake_timer_fire(&flash_timer);
	check_rgb(red, green, blue);
	CHECK(flash_off_timer.running);
	CHECK_EQ(flash_off_timer.duration_ms, FLASH_ON_MS);
	fake_timer_fire(&flash_off_timer);
	check_rgb(0, 0, 0);
}

static void test_init_turns_everything_off(void)
{
	fake_leds[RED_LED] = 1;
	reset_module();
	check_rgb(0, 0, 0);
	CHECK(!flash_timer.running);
}

static void test_no_network_flashes_red_and_green(void)
{
	reset_module();
	status_led_show(STATUS_LED_NO_NETWORK);

	/* Nothing stays lit: the first flash comes from the timer, right away, then every period. */
	check_rgb(0, 0, 0);
	CHECK_EQ(flash_timer.duration_ms, 0);
	CHECK_EQ(flash_timer.period_ms, FLASH_PERIOD_MS);
	check_flash(1, 1, 0);
	check_flash(1, 1, 0);
}

static void test_srp_pending_flashes_blue(void)
{
	reset_module();
	status_led_show(STATUS_LED_SRP_PENDING);
	check_flash(0, 0, 1);
}

static void test_fault_flashes_red(void)
{
	reset_module();
	status_led_show(STATUS_LED_FAULT);
	check_flash(1, 0, 0);
}

static void test_off_stops_flashing(void)
{
	reset_module();
	status_led_show(STATUS_LED_SRP_PENDING);
	fake_timer_fire(&flash_timer); // in the middle of a flash
	status_led_show(STATUS_LED_OFF);

	check_rgb(0, 0, 0);
	CHECK(!flash_timer.running);
	CHECK(!flash_off_timer.running);
}

static void test_flashing_stops_after_the_timeout(void)
{
	if (CONFIG_HACOAP_STATUS_LED_TIMEOUT_S == 0)
	{
		return; // never times out
	}
	reset_module();
	fake_uptime_ms = 1000;
	status_led_show(STATUS_LED_NO_NETWORK);

	fake_uptime_ms = 1000 + TIMEOUT_MS - 1;
	check_flash(1, 1, 0);

	fake_uptime_ms = 1000 + TIMEOUT_MS;
	fake_timer_fire(&flash_timer);
	check_rgb(0, 0, 0);
	CHECK(!flash_timer.running);
	CHECK(!flash_off_timer.running);
}

static void test_a_new_state_restarts_the_timeout(void)
{
	if (CONFIG_HACOAP_STATUS_LED_TIMEOUT_S == 0)
	{
		return;
	}
	reset_module();
	status_led_show(STATUS_LED_NO_NETWORK);
	fake_uptime_ms = TIMEOUT_MS - 1;
	status_led_show(STATUS_LED_SRP_PENDING);

	fake_uptime_ms = TIMEOUT_MS + 1;
	check_flash(0, 0, 1);
}

static void test_error_adds_red_until_the_next_state(void)
{
	reset_module();
	status_led_show(STATUS_LED_SRP_PENDING);
	status_led_error();
	check_flash(1, 0, 1);

	status_led_show(STATUS_LED_NO_NETWORK);
	check_flash(1, 1, 0);
	status_led_show(STATUS_LED_SRP_PENDING);
	check_flash(0, 0, 1);
}

static void test_error_alone_flashes_red(void)
{
	reset_module();
	status_led_error();
	check_flash(1, 0, 0);
}

static void test_error_blink_blinks_then_flashes_red(void)
{
	reset_module();
	status_led_error_blink(3);

	CHECK_EQ(fake_slept_ms, 3 * 2 * ERROR_BLINK_PERIOD_MS);
	CHECK_EQ(fake_led_changes, 3 * 2);
	check_rgb(0, 0, 0);
	check_flash(1, 0, 0);
}

static void test_user_and_boot_leds(void)
{
	reset_module();
	status_led_user(true);
	CHECK_EQ(fake_leds[USER_LED], 1);
	status_led_user(false);
	CHECK_EQ(fake_leds[USER_LED], 0);

	status_led_boot(true);
	CHECK_EQ(fake_leds[GREEN_LED], 1);
	status_led_boot(false);
	CHECK_EQ(fake_leds[GREEN_LED], 0);
}

static void test_lock_is_released(void)
{
	reset_module();
	status_led_show(STATUS_LED_NO_NETWORK);
	status_led_error();
	fake_timer_fire(&flash_timer);
	CHECK_EQ(lock.locked, 0);
}

int main(void)
{
	RUN_TEST(test_init_turns_everything_off);
	RUN_TEST(test_no_network_flashes_red_and_green);
	RUN_TEST(test_srp_pending_flashes_blue);
	RUN_TEST(test_fault_flashes_red);
	RUN_TEST(test_off_stops_flashing);
	RUN_TEST(test_flashing_stops_after_the_timeout);
	RUN_TEST(test_a_new_state_restarts_the_timeout);
	RUN_TEST(test_error_adds_red_until_the_next_state);
	RUN_TEST(test_error_alone_flashes_red);
	RUN_TEST(test_error_blink_blinks_then_flashes_red);
	RUN_TEST(test_user_and_boot_leds);
	RUN_TEST(test_lock_is_released);
	return TEST_RESULT();
}
