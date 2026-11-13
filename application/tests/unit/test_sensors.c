/*
 * test_sensors.c
 *
 * Sensor sampling, conversions and failure handling (src/sensors.c).
 */

#include "test.h"

#include "../../src/sensors.c"

#define DRY CONFIG_HACOAP_SOIL_DRY_MV
#define WET CONFIG_HACOAP_SOIL_WET_MV

/* ---------------------------------------------------------------- fake settings */

static int32_t fake_setting_values[SETTING_COUNT];

int32_t device_setting_get(enum device_setting id)
{
	return fake_setting_values[id];
}

/* ---------------------------------------------------------------- tests */

static void reset_module(void)
{
	fake_setting_values[SETTING_SAMPLE_S] = CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S;
	fake_setting_values[SETTING_SOIL_DRY_MV] = DRY;
	fake_setting_values[SETTING_SOIL_WET_MV] = WET;
	missing = 0;
	memset(&latest, 0, sizeof(latest));
	props_fuel_gauge_valid = false;
	sample_work.scheduled = false;
}

/* Sets readings that every test can start from. */
static void set_readings(int16_t soil_mv, uint8_t soc, int32_t humidity, int32_t temperature)
{
	fake_adc_raw = soil_mv;
	fake_battery_soc = soc;
	fake_humidity.val1 = humidity;
	fake_temperature.val1 = temperature;
}

static void test_soil_conversion(void)
{
	reset_module();
	CHECK_EQ(soil_mv_to_percent(DRY), 0);
	CHECK_EQ(soil_mv_to_percent(WET), 100);
	CHECK_EQ(soil_mv_to_percent((DRY + WET) / 2), 50);
	CHECK_EQ(soil_mv_to_percent(DRY + 500), 0);  // drier than calibrated
	CHECK_EQ(soil_mv_to_percent(WET - 500), 100); // wetter than calibrated
	CHECK_EQ(soil_mv_to_percent(-20), 100);       // the SAADC can read slightly negative
	for (int mv = WET; mv < DRY; mv += 10)
	{
		CHECK(soil_mv_to_percent(mv) >= soil_mv_to_percent(mv + 10));
	}
}

static void test_init_finds_every_sensor(void)
{
	reset_module();
	CHECK_EQ(sensors_init(), 0);
	CHECK_EQ(fake_gpio_flags[FAKE_PIN_sensor_en], GPIO_OUTPUT_INACTIVE);
	CHECK_EQ(fake_gpio_flags[FAKE_PIN_sensor_pwr], GPIO_OUTPUT_INACTIVE);
}

static void test_init_reports_missing_sensors(void)
{
	reset_module();
	fake_hdc_dev.ready = false;
	CHECK_EQ(sensors_init(), SENSOR_AIR);

	fake_hdc_dev.ready = true;
	fake_fuel_gauge_dev.ready = false;
	CHECK_EQ(sensors_init(), SENSOR_FUEL_GAUGE);

	fake_fuel_gauge_dev.ready = true;
	fake_adc_dev.ready = false;
	CHECK_EQ(sensors_init(), SENSOR_SOIL);
}

static void test_start_samples_now_and_then_every_period(void)
{
	struct sensors_data data;

	reset_module();
	CHECK_EQ(sensors_init(), 0);
	set_readings(WET, 87, 55, 21);
	sensors_start();

	data = sensors_get();
	CHECK_EQ(data.soil_moisture, 100);
	CHECK_EQ(data.battery_soc, 87);
	CHECK_EQ(data.air_humidity, 55);
	CHECK_EQ(data.temperature, 21);
	CHECK(sample_work.scheduled);
	CHECK_EQ(sample_work.delay_ms, (int64_t)CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S * 1000);

	set_readings(DRY, 86, 60, 22);
	fake_dwork_run(&sample_work);
	data = sensors_get();
	CHECK_EQ(data.soil_moisture, 0);
	CHECK_EQ(data.battery_soc, 86);
	CHECK(sample_work.scheduled); // rescheduled
}

static void test_soil_sensor_is_powered_only_while_sampling(void)
{
	reset_module();
	CHECK_EQ(sensors_init(), 0);
	sensors_start();
	CHECK_EQ(fake_adc_reads, 1);
	CHECK_EQ(fake_adc_power_at_read, 1);
	CHECK_EQ(fake_slept_ms, CONFIG_HACOAP_SOIL_POWER_UP_MS);
	CHECK_EQ(fake_gpio_value[FAKE_PIN_sensor_en], 0);
}

static void test_negative_temperatures_and_clamping(void)
{
	reset_module();
	CHECK_EQ(sensors_init(), 0);

	set_readings(WET, 50, 50, -5);
	sensors_start();
	CHECK_EQ(sensors_get().temperature, -5);

	set_readings(WET, 50, 120, 200);
	fake_dwork_run(&sample_work);
	CHECK_EQ(sensors_get().air_humidity, 100);
	CHECK_EQ(sensors_get().temperature, 127);

	set_readings(WET, 50, -3, -200);
	fake_dwork_run(&sample_work);
	CHECK_EQ(sensors_get().air_humidity, 0);
	CHECK_EQ(sensors_get().temperature, -128);
}

static void test_failed_readings_read_zero(void)
{
	struct sensors_data data;

	reset_module();
	CHECK_EQ(sensors_init(), 0);
	set_readings(WET, 87, 55, 21);
	fake_sensor_err = -EIO;
	fake_fuel_gauge_err = -EIO;
	fake_adc_read_err = -EIO;
	sensors_start();

	data = sensors_get();
	CHECK_EQ(data.soil_moisture, 0);
	CHECK_EQ(data.battery_soc, 0);
	CHECK_EQ(data.air_humidity, 0);
	CHECK_EQ(data.temperature, 0);
	CHECK_EQ(fake_gpio_value[FAKE_PIN_sensor_en], 0); // powered down after the failed read
}

static void test_missing_sensors_are_not_read(void)
{
	reset_module();
	fake_adc_dev.ready = false;
	fake_hdc_dev.ready = false;
	CHECK_EQ(sensors_init(), SENSOR_SOIL | SENSOR_AIR);
	set_readings(WET, 87, 55, 21);
	sensors_start();

	CHECK_EQ(fake_adc_reads, 0);
	CHECK_EQ(fake_slept_ms, 0); // soil sensor never powered
	CHECK_EQ(sensors_get().soil_moisture, 0);
	CHECK_EQ(sensors_get().air_humidity, 0);
	CHECK_EQ(sensors_get().battery_soc, 87);
}

static void test_the_calibration_comes_from_the_settings(void)
{
	reset_module();
	fake_setting_values[SETTING_SOIL_DRY_MV] = 2000;
	fake_setting_values[SETTING_SOIL_WET_MV] = 1000;
	CHECK_EQ(soil_mv_to_percent(2000), 0);
	CHECK_EQ(soil_mv_to_percent(1500), 50);
	CHECK_EQ(soil_mv_to_percent(1000), 100);
}

static void test_samples_report_the_soil_voltage_and_count(void)
{
	reset_module();
	CHECK_EQ(sensors_init(), 0);
	set_readings(1696, 87, 55, 21);
	sensors_start();
	CHECK_EQ(sensors_get().soil_mv, 1696);
	CHECK_EQ(sensors_get().samples, 1);

	fake_adc_read_err = -EIO;
	fake_dwork_run(&sample_work);
	CHECK_EQ(sensors_get().soil_mv, -1); // not read
	CHECK_EQ(sensors_get().samples, 2);
}

static void test_sampling_follows_the_period_setting(void)
{
	reset_module();
	CHECK_EQ(sensors_init(), 0);
	fake_setting_values[SETTING_SAMPLE_S] = 60;
	sensors_start();
	CHECK_EQ(sample_work.delay_ms, 60000);

	/* A new period counts from now */
	fake_setting_values[SETTING_SAMPLE_S] = 120;
	sensors_reschedule();
	CHECK_EQ(sample_work.delay_ms, 120000);
	fake_dwork_run(&sample_work);
	CHECK_EQ(sample_work.delay_ms, 120000);

	/* A sample now, then the period again */
	sensors_sample_now();
	CHECK_EQ(sample_work.delay_ms, 0);
	fake_dwork_run(&sample_work);
	CHECK_EQ(sensors_get().samples, 3);
	CHECK_EQ(sample_work.delay_ms, 120000);
}

static void test_lock_is_released(void)
{
	reset_module();
	CHECK_EQ(sensors_init(), 0);
	sensors_start();
	(void)sensors_get();
	CHECK_EQ(latest_lock.locked, 0);
}

int main(void)
{
	RUN_TEST(test_soil_conversion);
	RUN_TEST(test_init_finds_every_sensor);
	RUN_TEST(test_init_reports_missing_sensors);
	RUN_TEST(test_start_samples_now_and_then_every_period);
	RUN_TEST(test_soil_sensor_is_powered_only_while_sampling);
	RUN_TEST(test_negative_temperatures_and_clamping);
	RUN_TEST(test_failed_readings_read_zero);
	RUN_TEST(test_missing_sensors_are_not_read);
	RUN_TEST(test_the_calibration_comes_from_the_settings);
	RUN_TEST(test_samples_report_the_soil_voltage_and_count);
	RUN_TEST(test_sampling_follows_the_period_setting);
	RUN_TEST(test_lock_is_released);
	return TEST_RESULT();
}
