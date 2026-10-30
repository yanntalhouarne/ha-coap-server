/*
 * test_device_settings.c
 *
 * The settings that change without a new firmware (src/device_settings.c): defaults, what's
 * stored, checks, and applying a change.
 */

#include "test.h"

#include "../../src/device_settings.c"

static int changes[SETTING_COUNT];
static int32_t changed_to[SETTING_COUNT];

static void on_change(enum device_setting id, int32_t value)
{
	changes[id]++;
	changed_to[id] = value;
}

static void reset_module(void)
{
	memset(changes, 0, sizeof(changes));
	memset(changed_to, 0, sizeof(changed_to));
	boots = 0U;
	dirty = 0U;
	store_work.pending = false;
	fake_settings_handler = fake_settings_set_hacoap;
}

static void store_int(const char *name, int32_t value)
{
	fake_setting_store(name, &value, sizeof(value));
}

static int set_one(enum device_setting id, int32_t value)
{
	return device_settings_set(&id, &value, 1);
}

static void test_defaults_are_the_kconfig_values(void)
{
	reset_module();
	CHECK_EQ(device_settings_init(on_change), 0);
	CHECK_EQ(device_setting_get(SETTING_SAMPLE_S), CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S);
	CHECK_EQ(device_setting_get(SETTING_SOIL_DRY_MV), CONFIG_HACOAP_SOIL_DRY_MV);
	CHECK_EQ(device_setting_get(SETTING_SOIL_WET_MV), CONFIG_HACOAP_SOIL_WET_MV);
	CHECK_EQ(device_setting_get(SETTING_PUMP_S), CONFIG_HACOAP_PUMP_DEFAULT_DURATION);
	CHECK_EQ(device_setting_get(SETTING_POLL_MS), CONFIG_OPENTHREAD_POLL_PERIOD);
	for (int i = 0; i < SETTING_COUNT; i++)
	{
		CHECK_EQ(changes[i], 0); // nothing to apply
		CHECK(device_settings_info[i].default_value >= device_settings_info[i].min);
		CHECK(device_settings_info[i].default_value <= device_settings_info[i].max);
	}
}

static void test_stored_values_are_loaded_and_applied(void)
{
	reset_module();
	store_int("hacoap/sample_s", 600);
	store_int("hacoap/pump_s", 4);
	store_int("hacoap/poll_ms", 5); // out of range: the default stays
	store_int("hacoap/retired", 1); // unknown: ignored
	CHECK_EQ(device_settings_init(on_change), 0);
	CHECK_EQ(device_setting_get(SETTING_SAMPLE_S), 600);
	CHECK_EQ(device_setting_get(SETTING_PUMP_S), 4);
	CHECK_EQ(device_setting_get(SETTING_POLL_MS), CONFIG_OPENTHREAD_POLL_PERIOD);
	CHECK_EQ(changes[SETTING_SAMPLE_S], 1);
	CHECK_EQ(changed_to[SETTING_PUMP_S], 4);
	CHECK_EQ(changes[SETTING_POLL_MS], 0);
}

static void test_a_reversed_calibration_falls_back_to_the_defaults(void)
{
	reset_module();
	store_int("hacoap/soil_dry_mv", 900);
	store_int("hacoap/soil_wet_mv", 1200);
	device_settings_init(on_change);
	CHECK_EQ(device_setting_get(SETTING_SOIL_DRY_MV), CONFIG_HACOAP_SOIL_DRY_MV);
	CHECK_EQ(device_setting_get(SETTING_SOIL_WET_MV), CONFIG_HACOAP_SOIL_WET_MV);
}

static void test_a_load_failure_keeps_the_defaults(void)
{
	reset_module();
	store_int("hacoap/sample_s", 600);
	fake_settings_load_err = -EIO;
	CHECK_EQ(device_settings_init(on_change), -EIO);
	CHECK_EQ(device_setting_get(SETTING_SAMPLE_S), CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S);
}

static void test_a_change_applies_at_once_and_is_stored_later(void)
{
	reset_module();
	device_settings_init(on_change);
	CHECK_EQ(set_one(SETTING_SAMPLE_S, 300), 0);
	CHECK_EQ(device_setting_get(SETTING_SAMPLE_S), 300);
	CHECK_EQ(changes[SETTING_SAMPLE_S], 1);
	CHECK_EQ(fake_settings_saves, 0); // not from the caller's thread
	CHECK(store_work.pending);

	fake_work_run(&store_work);
	CHECK_EQ(fake_setting_int("hacoap/sample_s", 0), 300);
	CHECK_EQ(fake_settings_saves, 1);

	/* The same value again: nothing to apply or store */
	CHECK_EQ(set_one(SETTING_SAMPLE_S, 300), 0);
	fake_work_run(&store_work);
	CHECK_EQ(changes[SETTING_SAMPLE_S], 1);
	CHECK_EQ(fake_settings_saves, 1);
	CHECK_EQ(lock.locked, 0);
}

static void test_out_of_range_changes_nothing(void)
{
	static const enum device_setting ids[] = {SETTING_SAMPLE_S, SETTING_PUMP_S};
	static const int32_t values[] = {600, CONFIG_HACOAP_PUMP_MAX_DURATION + 1};

	reset_module();
	device_settings_init(on_change);
	CHECK_EQ(device_settings_set(ids, values, 2), -EINVAL);
	CHECK_EQ(device_setting_get(SETTING_SAMPLE_S), CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S); // all or none
	CHECK_EQ(set_one(SETTING_SAMPLE_S, 5), -EINVAL);
	CHECK_EQ(set_one(SETTING_POLL_MS, CONFIG_HACOAP_MCUMGR_POLL_PERIOD_MS), -EINVAL); // not slower than fast polling
	CHECK_EQ(set_one(SETTING_COUNT, 1), -EINVAL);
	CHECK_EQ(changes[SETTING_SAMPLE_S], 0);
	CHECK(!store_work.pending);
}

static void test_the_calibration_is_checked_as_a_whole(void)
{
	static const enum device_setting both[] = {SETTING_SOIL_DRY_MV, SETTING_SOIL_WET_MV};
	static const int32_t swapped_order[] = {800, 500};

	reset_module();
	device_settings_init(on_change);
	/* Dry under the current wet: refused alone, fine with the new wet */
	CHECK_EQ(set_one(SETTING_SOIL_DRY_MV, 800), -EINVAL);
	CHECK_EQ(device_settings_set(both, swapped_order, 2), 0);
	CHECK_EQ(device_setting_get(SETTING_SOIL_DRY_MV), 800);
	CHECK_EQ(device_setting_get(SETTING_SOIL_WET_MV), 500);
	CHECK_EQ(set_one(SETTING_SOIL_WET_MV, 800), -EINVAL); // equal
}

static void test_find_by_name(void)
{
	CHECK_EQ(device_setting_find("pump_s", 6), SETTING_PUMP_S);
	CHECK_EQ(device_setting_find("pump_sx", 6), SETTING_PUMP_S); // only the given length
	CHECK_EQ(device_setting_find("pump", 4), -1);
	CHECK_EQ(device_setting_find("nope", 4), -1);
}

static void test_boots_are_counted_and_kept(void)
{
	uint32_t stored = 41;

	reset_module();
	fake_setting_store("hacoap/boots", &stored, sizeof(stored));
	device_settings_init(on_change);
	CHECK_EQ(device_settings_boots(), 41);
	CHECK_EQ(device_settings_count_boot(), 0);
	CHECK_EQ(device_settings_boots(), 42);
	CHECK_EQ(fake_setting_int("hacoap/boots", 0), 42);
}

int main(void)
{
	RUN_TEST(test_defaults_are_the_kconfig_values);
	RUN_TEST(test_stored_values_are_loaded_and_applied);
	RUN_TEST(test_a_reversed_calibration_falls_back_to_the_defaults);
	RUN_TEST(test_a_load_failure_keeps_the_defaults);
	RUN_TEST(test_a_change_applies_at_once_and_is_stored_later);
	RUN_TEST(test_out_of_range_changes_nothing);
	RUN_TEST(test_the_calibration_is_checked_as_a_whole);
	RUN_TEST(test_find_by_name);
	RUN_TEST(test_boots_are_counted_and_kept);
	return TEST_RESULT();
}
