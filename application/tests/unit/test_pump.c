/*
 * test_pump.c
 *
 * Timed pump runs, from CoAP or the S1 button (src/pump.c).
 */

#include "test.h"

#include "../../src/pump.c"

/* ---------------------------------------------------------------- fake collaborators */

static int sounds_played;
static enum buzzer_sound last_sound;
static int user_led;

bool buzzer_play(enum buzzer_sound sound)
{
	sounds_played++;
	last_sound = sound;
	return true;
}

void status_led_user(bool on)
{
	user_led = on ? 1 : 0;
}

/* ---------------------------------------------------------------- helpers */

static void reset_module(void)
{
	running = 0;
	duration_s = CONFIG_HACOAP_PUMP_DEFAULT_DURATION;
	pump_timer.running = false;
	pump_timer.starts = 0;
	usr_button_work.pending = false;
	sounds_played = 0;
	user_led = 0;
	CHECK_EQ(pump_init(), 0);
}

static void check_pump(bool on)
{
	CHECK_EQ(pump_is_running(), on);
	CHECK_EQ(fake_gpio_value[FAKE_PIN_pump1], on);
	CHECK_EQ(user_led, on);
}

/* ---------------------------------------------------------------- tests */

static void test_init_configures_the_pump_off_and_the_button(void)
{
	reset_module();
	CHECK_EQ(fake_gpio_flags[FAKE_PIN_pump1], GPIO_OUTPUT_INACTIVE);
	CHECK_EQ(fake_gpio_flags[FAKE_PIN_usrbutton], GPIO_INPUT);
	CHECK_EQ(fake_gpio_int_flags[FAKE_PIN_usrbutton], GPIO_INT_EDGE_TO_ACTIVE);
	CHECK(fake_gpio_callback != NULL);
	CHECK_EQ(fake_gpio_callback->pin_mask, BIT(FAKE_PIN_usrbutton));
	check_pump(false);
}

static void test_init_fails_without_gpio(void)
{
	fake_gpio_dev.ready = false;
	CHECK_EQ(pump_init(), -ENODEV);
}

static void test_start_runs_for_the_run_time_then_stops(void)
{
	reset_module();
	pump_start();
	check_pump(true);
	CHECK(pump_timer.running);
	CHECK_EQ(pump_timer.duration_ms, CONFIG_HACOAP_PUMP_DEFAULT_DURATION * 1000);
	CHECK_EQ(pump_timer.period_ms, 0);
	CHECK_EQ(sounds_played, 1);
	CHECK_EQ(last_sound, BUZZER_PUMP);

	fake_timer_fire(&pump_timer);
	check_pump(false);
}

static void test_stop_ends_the_run_early(void)
{
	reset_module();
	pump_start();
	pump_stop();
	check_pump(false);
	CHECK(!pump_timer.running);
}

static void test_start_while_running_restarts_the_run(void)
{
	reset_module();
	pump_start();
	pump_start();
	check_pump(true);
	CHECK_EQ(pump_timer.starts, 2);
	CHECK(pump_timer.running);
}

static void test_run_time_range(void)
{
	reset_module();
	CHECK(!pump_set_duration(0));
	CHECK_EQ(pump_get_duration(), CONFIG_HACOAP_PUMP_DEFAULT_DURATION);
	CHECK(pump_set_duration(1));
	CHECK_EQ(pump_get_duration(), 1);
	CHECK(pump_set_duration(CONFIG_HACOAP_PUMP_MAX_DURATION));
	CHECK_EQ(pump_get_duration(), CONFIG_HACOAP_PUMP_MAX_DURATION);
	CHECK(!pump_set_duration(CONFIG_HACOAP_PUMP_MAX_DURATION + 1));
	CHECK(!pump_set_duration(255));
	CHECK_EQ(pump_get_duration(), CONFIG_HACOAP_PUMP_MAX_DURATION);
}

static void test_start_uses_the_new_run_time(void)
{
	reset_module();
	CHECK(pump_set_duration(4));
	pump_start();
	CHECK_EQ(pump_timer.duration_ms, 4000);
}

static void test_button_starts_the_pump_from_the_work_queue(void)
{
	reset_module();
	fake_gpio_callback->handler(&fake_gpio_dev, fake_gpio_callback, BIT(FAKE_PIN_usrbutton));

	/* Not in the interrupt: the work item starts it. */
	check_pump(false);
	CHECK(usr_button_work.pending);
	fake_work_run(&usr_button_work);
	check_pump(true);
}

int main(void)
{
	RUN_TEST(test_init_configures_the_pump_off_and_the_button);
	RUN_TEST(test_init_fails_without_gpio);
	RUN_TEST(test_start_runs_for_the_run_time_then_stops);
	RUN_TEST(test_stop_ends_the_run_early);
	RUN_TEST(test_start_while_running_restarts_the_run);
	RUN_TEST(test_run_time_range);
	RUN_TEST(test_start_uses_the_new_run_time);
	RUN_TEST(test_button_starts_the_pump_from_the_work_queue);
	return TEST_RESULT();
}
