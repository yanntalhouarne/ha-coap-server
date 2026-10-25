/*
 * Yann T.
 *
 * sensors.c
 *
 * Samples the sensors on a timer and keeps the latest readings, so that CoAP requests
 * (handled in the OpenThread thread) never block on the soil sensor power-up or on I2C.
 */

#include <zephyr/devicetree.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/drivers/fuel_gauge.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/spinlock.h>

#include "sensors.h"

LOG_MODULE_DECLARE(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

BUILD_ASSERT(CONFIG_HACOAP_SOIL_DRY_MV > CONFIG_HACOAP_SOIL_WET_MV,
	     "The dry soil voltage must be above the wet one");

/* ADC (soil moisture sensor on J5) */
#if !DT_NODE_EXISTS(DT_PATH(zephyr_user)) || \
    !DT_NODE_HAS_PROP(DT_PATH(zephyr_user), io_channels)
#error "No suitable devicetree overlay specified for ADC."
#endif
static const struct adc_dt_spec adc_channel = ADC_DT_SPEC_GET_BY_IDX(DT_PATH(zephyr_user), 0);

/* Soil sensor power: FPF1320 load switch */
static const struct gpio_dt_spec sensor_en_gpio = GPIO_DT_SPEC_GET(DT_ALIAS(sensor_en), gpios);   // IO 0_28, FPF1320 EN (soil sensor power)
static const struct gpio_dt_spec sensor_pwr_gpio = GPIO_DT_SPEC_GET(DT_ALIAS(sensor_pwr), gpios); // IO 1_15, FPF1320 SEL: 0 = VCC, 1 = VCC_MCU

/* Temperature and humidity sensor */
static const struct device *const dev_hdc = DEVICE_DT_GET_ONE(ti_hdc);

/* Fuel gauge */
static const struct device *const dev_fuelgauge = DEVICE_DT_GET_ANY(maxim_max17048);

/* Sensors that are not available (SENSOR_* bits). They read 0. */
static uint32_t missing;

/* Latest readings, written by the sampling work and read from any thread */
static struct sensors_data latest;
static struct k_spinlock latest_lock;

enum
{
	FUEL_GAUGE_PROP_RUNTIME_TO_EMPTY,
	FUEL_GAUGE_PROP_RUNTIME_TO_FULL,
	FUEL_GAUGE_PROP_STATE_OF_CHARGE,
	FUEL_GAUGE_PROP_VOLTAGE,
};
static bool props_fuel_gauge_valid; // set once fuel_gauge_get_prop() has filled props_fuel_gauge
static struct fuel_gauge_get_property props_fuel_gauge[] = {
	[FUEL_GAUGE_PROP_RUNTIME_TO_EMPTY] = {.property_type = FUEL_GAUGE_RUNTIME_TO_EMPTY},
	[FUEL_GAUGE_PROP_RUNTIME_TO_FULL] = {.property_type = FUEL_GAUGE_RUNTIME_TO_FULL},
	[FUEL_GAUGE_PROP_STATE_OF_CHARGE] = {.property_type = FUEL_GAUGE_STATE_OF_CHARGE},
	[FUEL_GAUGE_PROP_VOLTAGE] = {.property_type = FUEL_GAUGE_VOLTAGE},
};

/* Converts the soil sensor voltage to a moisture percentage (0% = dry, 100% = wet). */
static uint8_t soil_mv_to_percent(int32_t val_mv)
{
	float moisture = (float)CLAMP(val_mv, CONFIG_HACOAP_SOIL_WET_MV, CONFIG_HACOAP_SOIL_DRY_MV);

	moisture -= CONFIG_HACOAP_SOIL_WET_MV;
	moisture /= (CONFIG_HACOAP_SOIL_DRY_MV - CONFIG_HACOAP_SOIL_WET_MV);
	moisture *= 100;
	moisture = 100 - moisture;

	return (uint8_t)moisture;
}

/* Powers the soil sensor, samples it and powers it down again. */
static int read_soil_moisture(uint8_t *moisture)
{
	int16_t sample = 0; // signed: the SAADC can return small negative values in single-ended mode
	int32_t val_mv;
	int err;
	struct adc_sequence sequence = {
		.buffer = &sample,
		/* buffer size in bytes, not number of samples */
		.buffer_size = sizeof(sample),
	};

	if (missing & SENSOR_SOIL)
	{
		return -ENODEV;
	}

	gpio_pin_set_dt(&sensor_en_gpio, 1);
	k_sleep(K_MSEC(CONFIG_HACOAP_SOIL_POWER_UP_MS));

	(void)adc_sequence_init_dt(&adc_channel, &sequence);
	err = adc_read(adc_channel.dev, &sequence);

	gpio_pin_set_dt(&sensor_en_gpio, 0);

	if (err < 0)
	{
		LOG_ERR("Could not read ADC (%d)", err);
		return err;
	}

	val_mv = sample;
	err = adc_raw_to_millivolts_dt(&adc_channel, &val_mv);
	if (err < 0)
	{
		LOG_ERR("ADC value in mV not available (%d)", err);
		return err;
	}

	*moisture = soil_mv_to_percent(val_mv);
	LOG_INF("soil_voltage = %d mV, soil_humidity = %d %%", (int)val_mv, *moisture);

	return 0;
}

/* Reads the battery state of charge from the fuel gauge (all props are refreshed). */
static int read_battery_soc(uint8_t *soc)
{
	int err;

	if (missing & SENSOR_FUEL_GAUGE)
	{
		return -ENODEV;
	}

	err = fuel_gauge_get_prop(dev_fuelgauge, props_fuel_gauge, ARRAY_SIZE(props_fuel_gauge));
	if (err < 0)
	{
		LOG_ERR("Cannot read fuel gauge properties (%d)", err);
		props_fuel_gauge_valid = false;
		return err;
	}
	props_fuel_gauge_valid = true;
	if (err != 0)
	{
		LOG_WRN("Some fuel gauge properties failed");
	}

	if (props_fuel_gauge[FUEL_GAUGE_PROP_STATE_OF_CHARGE].status != 0)
	{
		LOG_ERR("SOC error %d", props_fuel_gauge[FUEL_GAUGE_PROP_STATE_OF_CHARGE].status);
		return -EIO;
	}

	*soc = props_fuel_gauge[FUEL_GAUGE_PROP_STATE_OF_CHARGE].value.state_of_charge;

	return 0;
}

/* Reads air humidity (%) and temperature (degC). */
static int read_air(uint8_t *humidity, int8_t *temperature)
{
	struct sensor_value temp, rh;
	int err;

	if (missing & SENSOR_AIR)
	{
		return -ENODEV;
	}

	err = sensor_sample_fetch(dev_hdc);
	if (err == 0)
	{
		err = sensor_channel_get(dev_hdc, SENSOR_CHAN_AMBIENT_TEMP, &temp);
	}
	if (err == 0)
	{
		err = sensor_channel_get(dev_hdc, SENSOR_CHAN_HUMIDITY, &rh);
	}
	if (err != 0)
	{
		LOG_ERR("Cannot read HDC1080 (%d)", err);
		return err;
	}

	LOG_INF("Temp = %d.%06d C, RH = %d.%06d %%", temp.val1, temp.val2, rh.val1, rh.val2);

	*humidity = (uint8_t)CLAMP(rh.val1, 0, 100);
	*temperature = (int8_t)CLAMP(temp.val1, INT8_MIN, INT8_MAX);

	return 0;
}

/* Logs the fuel gauge properties fetched by the last read_battery_soc() call. */
static void log_fuel_gauge(void)
{
	if (!props_fuel_gauge_valid)
	{
		return;
	}
	if (props_fuel_gauge[FUEL_GAUGE_PROP_RUNTIME_TO_EMPTY].status == 0)
	{
		LOG_INF("Time to empty %u", (unsigned int)props_fuel_gauge[FUEL_GAUGE_PROP_RUNTIME_TO_EMPTY].value.runtime_to_empty);
	}
	if (props_fuel_gauge[FUEL_GAUGE_PROP_RUNTIME_TO_FULL].status == 0)
	{
		LOG_INF("Time to full %u", (unsigned int)props_fuel_gauge[FUEL_GAUGE_PROP_RUNTIME_TO_FULL].value.runtime_to_full);
	}
	if (props_fuel_gauge[FUEL_GAUGE_PROP_VOLTAGE].status == 0)
	{
		LOG_INF("Voltage %d", props_fuel_gauge[FUEL_GAUGE_PROP_VOLTAGE].value.voltage);
	}
}

/* Reads every sensor and publishes the results. A failed reading publishes 0. */
static void sample(void)
{
	struct sensors_data data = {0};
	k_spinlock_key_t key;

	if (read_soil_moisture(&data.soil_moisture) != 0)
	{
		data.soil_moisture = 0;
	}
	if (read_battery_soc(&data.battery_soc) != 0)
	{
		data.battery_soc = 0;
	}
	if (read_air(&data.air_humidity, &data.temperature) != 0)
	{
		data.air_humidity = 0;
		data.temperature = 0;
	}

	LOG_INF("soil_humidity = %d, battery = %d, air_humidity = %d, temperature = %d",
		data.soil_moisture, data.battery_soc, data.air_humidity, data.temperature);

	key = k_spin_lock(&latest_lock);
	latest = data;
	k_spin_unlock(&latest_lock, key);
}

static void on_sample_work(struct k_work *work)
{
	sample();
	k_work_schedule(k_work_delayable_from_work(work), K_SECONDS(CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S));
}

static K_WORK_DELAYABLE_DEFINE(sample_work, on_sample_work);

/* Configures the soil sensor ADC channel and power outputs. */
static int soil_init(void)
{
	const struct gpio_dt_spec *outputs[] = {&sensor_en_gpio, &sensor_pwr_gpio};
	int ret;

	/* Both off: sensor unpowered, and VS_SEL low selects VCC for the sensor rail. */
	for (size_t i = 0U; i < ARRAY_SIZE(outputs); i++)
	{
		if (!gpio_is_ready_dt(outputs[i]))
		{
			LOG_ERR("Soil sensor power outputs not ready");
			return -ENODEV;
		}
		ret = gpio_pin_configure_dt(outputs[i], GPIO_OUTPUT_INACTIVE);
		if (ret != 0)
		{
			LOG_ERR("Could not configure the soil sensor power outputs (%d)", ret);
			return ret;
		}
	}

	if (!device_is_ready(adc_channel.dev))
	{
		LOG_ERR("ADC controller device not ready");
		return -ENODEV;
	}
	ret = adc_channel_setup_dt(&adc_channel);
	if (ret < 0)
	{
		LOG_ERR("Could not setup ADC channel (%d)", ret);
		return ret;
	}

	return 0;
}

uint32_t sensors_init(void)
{
	missing = 0;

	if (!device_is_ready(dev_hdc))
	{
		LOG_ERR("Device %s is not ready", dev_hdc->name);
		missing |= SENSOR_AIR;
	}
	if (!device_is_ready(dev_fuelgauge))
	{
		LOG_ERR("Fuel gauge is not ready");
		missing |= SENSOR_FUEL_GAUGE;
	}
	if (soil_init() != 0)
	{
		missing |= SENSOR_SOIL;
	}

	return missing;
}

void sensors_start(void)
{
	sample();
	log_fuel_gauge();
	k_work_schedule(&sample_work, K_SECONDS(CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S));
}

struct sensors_data sensors_get(void)
{
	struct sensors_data data;
	k_spinlock_key_t key = k_spin_lock(&latest_lock);

	data = latest;
	k_spin_unlock(&latest_lock, key);

	return data;
}
