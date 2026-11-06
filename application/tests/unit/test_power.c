/*
 * test_power.c
 *
 * USB power and charging (src/power.c).
 */

#include "test.h"

#include "../../src/power.c"

static int changes;
static enum power_source last_change;

static void on_changed(enum power_source source)
{
	changes++;
	last_change = source;
}

static void reset_module(void)
{
	changes = 0;
	last_change = POWER_BATTERY;
	fake_gpio_input[FAKE_PIN_charging] = 0;
	check_work.scheduled = false;
	check_work.schedules = 0;
}

static void test_on_the_battery(void)
{
	reset_module();
	CHECK_EQ(power_init(on_changed), 0);
	CHECK_EQ(power_source(), POWER_BATTERY);
	CHECK_EQ(changes, 0); // the battery is the default: nothing to say
	CHECK_STR(power_name(power_source()), "battery");
	CHECK(fake_gpio_flags[FAKE_PIN_charging] & GPIO_INPUT);
	/* Checked again later, from the work queue */
	CHECK(check_work.scheduled);
	CHECK_EQ(check_work.delay_ms, (int64_t)CONFIG_HACOAP_POWER_CHECK_S * 1000);
}

static void test_charging_then_charged_then_unplugged(void)
{
	reset_module();
	fake_vbus = true;
	fake_gpio_input[FAKE_PIN_charging] = 1; // CHRG low: charging
	power_init(on_changed);
	CHECK_EQ(power_source(), POWER_CHARGING);
	CHECK_EQ(changes, 1);
	CHECK_EQ(last_change, POWER_CHARGING);

	fake_dwork_run(&check_work); // no change: no call
	CHECK_EQ(changes, 1);

	fake_gpio_input[FAKE_PIN_charging] = 0; // the charger is done
	fake_dwork_run(&check_work);
	CHECK_EQ(power_source(), POWER_CHARGED);
	CHECK_STR(power_name(power_source()), "charged");
	CHECK_EQ(changes, 2);

	fake_vbus = false; // unplugged
	fake_dwork_run(&check_work);
	CHECK_EQ(power_source(), POWER_BATTERY);
	CHECK_EQ(last_change, POWER_BATTERY);
	CHECK_EQ(changes, 3);
	CHECK(check_work.scheduled); // and it keeps checking
}

static void test_without_the_charge_pin_usb_is_still_known(void)
{
	reset_module();
	fake_gpio_dev.ready = false;
	fake_vbus = true;
	CHECK(power_init(on_changed) != 0);
	CHECK_EQ(power_source(), POWER_USB);
	CHECK_STR(power_name(power_source()), "usb");
	CHECK(power_on_usb(power_source()));
	CHECK(!power_on_usb(POWER_BATTERY));
}

static void test_names(void)
{
	CHECK_STR(power_name(POWER_CHARGING), "charging");
	CHECK_STR(power_name((enum power_source)42), "unknown");
}

int main(void)
{
	RUN_TEST(test_on_the_battery);
	RUN_TEST(test_charging_then_charged_then_unplugged);
	RUN_TEST(test_without_the_charge_pin_usb_is_still_known);
	RUN_TEST(test_names);
	return TEST_RESULT();
}
