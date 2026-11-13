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
	button_seconds = 0;
	run_ms = 0;
	started_ms = 0;
	fake_uptime_ms = 0;
	duration_s = CONFIG_HACOAP_PUMP_DEFAULT_DURATION;
	run_end_callback = NULL;
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

static void test_the_buttons_runs_are_counted(void)
{
	reset_module();
	CHECK(pump_set_duration(3));
	pump_start();                              // over CoAP: the app counts those itself
	CHECK_EQ(pump_button_seconds(), 0);
	fake_gpio_callback->handler(&fake_gpio_dev, fake_gpio_callback, BIT(FAKE_PIN_usrbutton));
	fake_work_run(&usr_button_work);
	fake_gpio_callback->handler(&fake_gpio_dev, fake_gpio_callback, BIT(FAKE_PIN_usrbutton));
	fake_work_run(&usr_button_work);
	CHECK_EQ(pump_button_seconds(), 6);        // two presses of 3 s
}

static void test_its_run_time_is_counted(void)
{
	reset_module();
	CHECK(pump_set_duration(3));
	fake_uptime_ms = 1000;
	pump_start();
	fake_uptime_ms = 4000;
	on_pump_timer_expiry(&pump_timer);         // its run time is over
	CHECK_EQ(pump_run_ms(), 3000);
	fake_uptime_ms = 10000;
	pump_start();
	fake_uptime_ms = 11000;
	pump_start();                              // started again while running: one run
	fake_uptime_ms = 11500;
	CHECK_EQ(pump_run_ms(), 4500);             // the run going on counts so far
	fake_uptime_ms = 12000;
	pump_stop();                               // stopped early: the time it really ran
	CHECK_EQ(pump_run_ms(), 5000);
	fake_uptime_ms = 20000;
	pump_stop();                               // stopping a stopped pump adds nothing
	CHECK_EQ(pump_run_ms(), 5000);
}

static int run_ends;

static void on_run_end(void)
{
	CHECK_EQ(pump_run_ms(), 2000);             // told after the run is counted
	run_ends++;
}

static void test_the_end_of_each_run_is_told(void)
{
	reset_module();
	run_ends = 0;
	pump_start();                              // no one to tell: fine
	pump_stop();
	run_ms = 0;
	pump_on_run_end(on_run_end);
	CHECK(pump_set_duration(2));
	fake_uptime_ms = 1000;
	pump_start();
	pump_start();                              // started again while running: not an end
	CHECK_EQ(run_ends, 0);
	fake_uptime_ms = 3000;
	on_pump_timer_expiry(&pump_timer);         // its run time is over
	CHECK_EQ(run_ends, 1);
	pump_stop();                               // already stopped: no other end
	CHECK_EQ(run_ends, 1);
}

static void test_s1_can_be_read(void)
{
	CHECK(!pump_button_pressed());
	fake_gpio_input[FAKE_PIN_usrbutton] = 1;
	CHECK(pump_button_pressed());
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
	RUN_TEST(test_the_buttons_runs_are_counted);
	RUN_TEST(test_its_run_time_is_counted);
	RUN_TEST(test_the_end_of_each_run_is_told);
	RUN_TEST(test_s1_can_be_read);
	return TEST_RESULT();
}
