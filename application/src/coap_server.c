/*
 * Yann T.
 *
 * coap_server.c
 *
 * Headers fonts:
 *     - major: ANSI Regular (dafault): https://patorjk.com/software/taag/#p=display&f=ANSI%20Regular&t=LOCALS%20%20%20%20%20INIT
 * 	   - minor: Big          (default): https://patorjk.com/software/taag/#p=display&f=Big&t=LEDS%20%20%20%20%20INIT
 */

/*
██ ███    ██  ██████ ██      ██    ██ ██████  ███████ ███████
██ ████   ██ ██      ██      ██    ██ ██   ██ ██      ██
██ ██ ██  ██ ██      ██      ██    ██ ██   ██ █████   ███████
██ ██  ██ ██ ██      ██      ██    ██ ██   ██ ██           ██
██ ██   ████  ██████ ███████  ██████  ██████  ███████ ███████
*/
/* APPLICATION */
#include "../include/coap_server.h"

/*
███    ███  █████   ██████ ██████   ██████  ███████
████  ████ ██   ██ ██      ██   ██ ██    ██ ██
██ ████ ██ ███████ ██      ██████  ██    ██ ███████
██  ██  ██ ██   ██ ██      ██   ██ ██    ██      ██
██      ██ ██   ██  ██████ ██   ██  ██████  ███████
*/
/* Enable logging for coap_server.c */
LOG_MODULE_REGISTER(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

/*
██████  ███████ ██    ██ ██  ██████ ███████     ███████ ████████ ██████  ██    ██  ██████ ████████ ███████
██   ██ ██      ██    ██ ██ ██      ██          ██         ██    ██   ██ ██    ██ ██         ██    ██
██   ██ █████   ██    ██ ██ ██      █████       ███████    ██    ██████  ██    ██ ██         ██    ███████
██   ██ ██       ██  ██  ██ ██      ██               ██    ██    ██   ██ ██    ██ ██         ██         ██
██████  ███████   ████   ██  ██████ ███████     ███████    ██    ██   ██  ██████   ██████    ██    ███████
*/
/* ADC (soil moisture sensor on J5) */
#if !DT_NODE_EXISTS(DT_PATH(zephyr_user)) || \
    !DT_NODE_HAS_PROP(DT_PATH(zephyr_user), io_channels)
#error "No suitable devicetree overlay specified for ADC."
#endif
static const struct adc_dt_spec adc_channel = ADC_DT_SPEC_GET_BY_IDX(DT_PATH(zephyr_user), 0);

/* Temperature and humidity sensor */
static const struct device *const dev_hdc = DEVICE_DT_GET_ONE(ti_hdc);

/* Fuel gauge */
static const struct device *const dev_fuelgauge = DEVICE_DT_GET_ANY(maxim_max17048);

/* BUZZER */
static const struct pwm_dt_spec pwm_buzzer = PWM_DT_SPEC_GET(DT_ALIAS(pwm_buzzer));

/* User button (S1). This is mandatory. */
#define USRBUTTON_NODE	DT_ALIAS(usrbutton)
#if !DT_NODE_HAS_STATUS(USRBUTTON_NODE, okay)
#error "Unsupported board: usrbutton devicetree alias is not defined"
#endif
static const struct gpio_dt_spec usr_button = GPIO_DT_SPEC_GET(USRBUTTON_NODE, gpios);
static struct gpio_callback usr_button_cb_data;

/* Outputs */
static const struct gpio_dt_spec pump_gpio = GPIO_DT_SPEC_GET(DT_ALIAS(pump1), gpios);             // IO 0_17, Q1 gate (pump on J2)
static const struct gpio_dt_spec sensor_en_gpio = GPIO_DT_SPEC_GET(DT_ALIAS(sensor_en), gpios);   // IO 0_28, FPF1320 EN (soil sensor power)
static const struct gpio_dt_spec sensor_pwr_gpio = GPIO_DT_SPEC_GET(DT_ALIAS(sensor_pwr), gpios); // IO 1_15, FPF1320 SEL: 0 = VCC, 1 = VCC_MCU

/*
████████ ██ ███    ███ ███████ ██████  ███████
   ██    ██ ████  ████ ██      ██   ██ ██
   ██    ██ ██ ████ ██ █████   ██████  ███████
   ██    ██ ██  ██  ██ ██      ██   ██      ██
   ██    ██ ██      ██ ███████ ██   ██ ███████
*/
static struct k_timer pump_timer;   // turns off the water pump 'pump_dc' seconds after it has been turned on.
static struct k_timer buzzer_timer; // steps through the buzzer pattern that is currently playing.

/*
 ██████  ██       ██████  ██████   █████  ██      ███████
██       ██      ██    ██ ██   ██ ██   ██ ██      ██
██   ███ ██      ██    ██ ██████  ███████ ██      ███████
██    ██ ██      ██    ██ ██   ██ ██   ██ ██           ██
 ██████  ███████  ██████  ██████  ██   ██ ███████ ███████
*/
/* 'data' resource payload: soil moisture (%), battery (%), air humidity (%), temperature (degC, int8) */
static uint8_t data_buf[DATA_PAYLOAD_SIZE];

/* Sensors that initialized correctly. A missing sensor reports 0 in 'data'. */
static bool hdc_ready;
static bool fuel_gauge_ready;
static bool adc_ready;

/* Pump active time, in seconds */
static uint8_t pump_dc = PUMP_DEFAULT_ACTIVE_TIME;

/* Buzzer patterns: 'beeps' beeps of 'period_ms', separated by pauses of 'period_ms'. */
struct buzzer_pattern
{
	uint32_t frequency_khz;
	uint32_t period_ms;
	uint8_t beeps;
};
static const struct buzzer_pattern pump_pattern = {PUMP_BUZZER_FREQUENCY, PUMP_BUZZER_PERIOD, 1};
static const struct buzzer_pattern ot_pattern = {OT_BUZZER_FREQUENCY, OT_BUZZER_PERIOD, OT_BUZZER_NBR_BEEPS};
static const struct buzzer_pattern ping_pattern = {PING_BUZZER_FREQUENCY, PING_BUZZER_PERIOD, PING_BUZZER_NBR_BEEPS};

/* Buzzer state */
static atomic_t buzzer_active = ATOMIC_INIT(0);    // set while a pattern is playing
static const struct buzzer_pattern *buzzer_current; // pattern that is playing
static uint8_t buzzer_step;                         // even steps beep, odd steps are silent

/* fuel gauge*/
enum
{
	FUEL_GAUGE_PROP_RUNTIME_TO_EMPTY,
	FUEL_GAUGE_PROP_RUNTIME_TO_FULL,
	FUEL_GAUGE_PROP_STATE_OF_CHARGE,
	FUEL_GAUGE_PROP_VOLTAGE,
};
static struct fuel_gauge_get_property props_fuel_gauge[] = {
	[FUEL_GAUGE_PROP_RUNTIME_TO_EMPTY] = {.property_type = FUEL_GAUGE_RUNTIME_TO_EMPTY},
	[FUEL_GAUGE_PROP_RUNTIME_TO_FULL] = {.property_type = FUEL_GAUGE_RUNTIME_TO_FULL},
	[FUEL_GAUGE_PROP_STATE_OF_CHARGE] = {.property_type = FUEL_GAUGE_STATE_OF_CHARGE},
	[FUEL_GAUGE_PROP_VOLTAGE] = {.property_type = FUEL_GAUGE_VOLTAGE},
};

/* Device ID (FICR DEVICEID[0] in hex), reported in 'info' and appended to the SRP hostname */
static char device_id_buf[SRP_CLIENT_UNIQUE_SIZE + 1];

/* SRP hostname */
static const char hostname[] = SRP_CLIENT_HOSTNAME;
static const char service_instance[] = SRP_CLIENT_SERVICE_INSTANCE;
#if defined SRP_CLIENT_RNG
static char realhostname[sizeof(hostname) + SRP_CLIENT_RAND_SIZE + 1];
static char realinstance[sizeof(service_instance) + SRP_CLIENT_RAND_SIZE + 1];
#elif defined SRP_CLIENT_UNIQUE
static char realhostname[sizeof(hostname) + SRP_CLIENT_UNIQUE_SIZE + 1];
static char realinstance[sizeof(service_instance) + SRP_CLIENT_UNIQUE_SIZE + 1];
#elif defined SRP_CLIENT_MANUAL
static char realhostname[sizeof(hostname) + SRP_CLIENT_MANUAL_SIZE + 1];
static char realinstance[sizeof(service_instance) + SRP_CLIENT_MANUAL_SIZE + 1];
#endif

#if defined SRP_CLIENT_RNG || defined SRP_CLIENT_UNIQUE || defined SRP_CLIENT_MANUAL
#define SRP_HOSTNAME realhostname
#define SRP_INSTANCE realinstance
#else
#define SRP_HOSTNAME hostname
#define SRP_INSTANCE service_instance
#endif

/* SRP service name */
static const char service_name[] = SRP_SERVICE_NAME;

/*
██   ██ ███████ ██      ██████  ███████ ██████  ███████
██   ██ ██      ██      ██   ██ ██      ██   ██ ██
███████ █████   ██      ██████  █████   ██████  ███████
██   ██ ██      ██      ██      ██      ██   ██      ██
██   ██ ███████ ███████ ██      ███████ ██   ██ ███████
*/
/*
  ____
 |  _ \
 | |_) |_   _ ___________ _ __
 |  _ <| | | |_  /_  / _ \ '__|
 | |_) | |_| |/ / / /  __/ |
 |____/ \__,_/___/___\___|_|
*/
/* Sets the buzzer tone on (50% duty cycle) or off. */
static void buzzer_tone(uint32_t frequency_khz, bool on)
{
	uint32_t period = PWM_KHZ(frequency_khz);

	pwm_set_dt(&pwm_buzzer, period, on ? period / 2U : 0);
}

/* Starts playing 'pattern'. Returns false if another pattern is already playing. */
static bool buzzer_play(const struct buzzer_pattern *pattern)
{
	if (!atomic_cas(&buzzer_active, 0, 1))
	{
		return false;
	}

	buzzer_current = pattern;
	buzzer_step = 0;
	k_timer_start(&buzzer_timer, K_NO_WAIT, K_MSEC(pattern->period_ms));

	return true;
}

/*
  _____
 |  __ \
 | |__) |   _ _ __ ___  _ __
 |  ___/ | | | '_ ` _ \| '_ \
 | |   | |_| | | | | | | |_) |
 |_|    \__,_|_| |_| |_| .__/
                       | |
                       |_|
*/
/* Turns the pump and the user LED on or off, and updates the 'pump' resource state. */
static void pump_set(bool on)
{
	if (on)
	{
		coap_activate_pump();
	}
	else
	{
		coap_diactivate_pump();
	}
	gpio_pin_set_dt(&pump_gpio, on ? 1 : 0);
	dk_set_led(LED1, on ? 1 : 0);
}

/* Runs the pump for 'pump_dc' seconds. Restarts the timer if the pump is already running. */
static void pump_start(void)
{
	pump_set(true);
	k_timer_start(&pump_timer, K_SECONDS(pump_dc), K_NO_WAIT);
	buzzer_play(&pump_pattern);
}

/* Stops the pump before its timer expires. */
static void pump_stop(void)
{
	k_timer_stop(&pump_timer);
	pump_set(false);
}

/*
   _____
  / ____|
 | (___   ___ _ __  ___  ___  _ __ ___
  \___ \ / _ \ '_ \/ __|/ _ \| '__/ __|
  ____) |  __/ | | \__ \ (_) | |  \__ \
 |_____/ \___|_| |_|___/\___/|_|  |___/
*/
/* Converts the soil sensor voltage to a moisture percentage (0% = dry, 100% = wet). */
static uint8_t soil_mv_to_percent(int32_t val_mv)
{
	float moisture = (float)val_mv;

	if (moisture < HUMIDITY_WET)
		moisture = HUMIDITY_WET;
	else if (moisture > HUMIDITY_DRY)
		moisture = HUMIDITY_DRY;
	moisture -= HUMIDITY_WET;
	moisture /= (HUMIDITY_DRY - HUMIDITY_WET);
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

	if (!adc_ready)
	{
		return -ENODEV;
	}

	/* TURN ON SENSOR */
	gpio_pin_set_dt(&sensor_en_gpio, 1);
	k_sleep(K_MSEC(SENSOR_POWER_UP_TIME));

	(void)adc_sequence_init_dt(&adc_channel, &sequence);
	err = adc_read(adc_channel.dev, &sequence);

	/* TURN OFF SENSOR */
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

	if (!fuel_gauge_ready)
	{
		return -ENODEV;
	}

	err = fuel_gauge_get_prop(dev_fuelgauge, props_fuel_gauge, ARRAY_SIZE(props_fuel_gauge));
	if (err < 0)
	{
		LOG_ERR("Cannot read fuel gauge properties (%d)", err);
		return err;
	}
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

/* Reads air humidity (%) and temperature (degC, as a two's complement byte). */
static int read_air(uint8_t *humidity, uint8_t *temperature)
{
	struct sensor_value temp, rh;
	int err;

	if (!hdc_ready)
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
	*temperature = (uint8_t)(int8_t)CLAMP(temp.val1, INT8_MIN, INT8_MAX);

	return 0;
}

/* Logs the fuel gauge properties fetched by the last read_battery_soc() call. */
static void log_fuel_gauge(void)
{
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

/* Blinks the red LED 'count' times to report a missing sensor, then leaves it on. */
static void blink_error(int count)
{
	for (int i = 0; i < count; i++)
	{
		dk_set_led_on(RADIO_RED_LED);
		k_sleep(K_MSEC(ERROR_BLINK_PERIOD));
		dk_set_led_off(RADIO_RED_LED);
		k_sleep(K_MSEC(ERROR_BLINK_PERIOD));
	}
	dk_set_led_on(RADIO_RED_LED);
}

/*
   _____ _____  _____
  / ____|  __ \|  __ \
 | (___ | |__) | |__) |
  \___ \|  _  /|  ___/
  ____) | | \ \| |
 |_____/|_|  \_\_|
*/
/* Fills 'device_id_buf' with the factory device ID. */
static void device_id_init(void)
{
	snprintf(device_id_buf, sizeof(device_id_buf), "%x", (unsigned int)NRF_FICR->DEVICEID[0]);
}

/* Generates a unique SRP hostname and service instance name */
static void srp_client_generate_name(void)
{
#if defined SRP_CLIENT_UNIQUE
	LOG_INF("Appending device ID to hostname");
	snprintf(realhostname, sizeof(realhostname), "%s-%s", hostname, device_id_buf);
	snprintf(realinstance, sizeof(realinstance), "%s-%s", service_instance, device_id_buf);
#elif defined SRP_CLIENT_RNG
	LOG_INF("Appending random number to hostname");
	uint32_t rn = sys_rand32_get(); // true random, hw based
	snprintf(realhostname, sizeof(realhostname), "%s-%x", hostname, (unsigned int)rn);
	snprintf(realinstance, sizeof(realinstance), "%s-%x", service_instance, (unsigned int)rn);
#elif defined SRP_CLIENT_MANUAL
	LOG_INF("Appending manual ID to hostname");
	snprintf(realhostname, sizeof(realhostname), "%s-%s", hostname, SRP_CLIENT_MANUAL_ID);
	snprintf(realinstance, sizeof(realinstance), "%s-%s", service_instance, SRP_CLIENT_MANUAL_ID);
#endif
	LOG_INF("hostname is: %s", SRP_HOSTNAME);
	LOG_INF("service instance is: %s", SRP_INSTANCE);
}

/*
 ██████  ██████   █████  ██████      ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
██      ██    ██ ██   ██ ██   ██     ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
██      ██    ██ ███████ ██████      ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
██      ██    ██ ██   ██ ██          ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
 ██████  ██████  ██   ██ ██          ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████

*/
/* PUMPDC PUT REQUEST */
static uint8_t on_pumpdc_request(uint8_t data)
{
	/* The payload is a single ASCII digit, so 1 to 9 seconds can be requested. */
	if ((data >= '0') && (data <= '9'))
	{
		uint8_t seconds = data - '0';

		if ((seconds >= PUMP_MIN_ACTIVE_TIME) && (seconds < PUMP_MAX_ACTIVE_TIME))
		{
			pump_dc = seconds;
			coap_set_pumpdc(pump_dc);
		}
	}

	return pump_dc;
}

/* PUMP PUT REQUEST */
static void on_pump_request(uint8_t command)
{
	switch (command)
	{
	case THREAD_COAP_UTILS_PUMP_CMD_ON:
		if (!coap_is_pump_active())
		{
			pump_start();
		}
		break;

	case THREAD_COAP_UTILS_PUMP_CMD_OFF:
		if (coap_is_pump_active())
		{
			pump_stop();
		}
		break;

	default:
		break;
	}
}

/* DATA GET REQUEST */
static const uint8_t *on_data_request(void)
{
	/* READ ADC (SOIL HUMIDITY) */
	if (read_soil_moisture(&data_buf[0]) != 0)
	{
		data_buf[0] = 0;
	}

	/* READ BATTERY SOC */
	if (read_battery_soc(&data_buf[1]) != 0)
	{
		data_buf[1] = 0;
	}

	/* READ AIR TEMPERATURE AND HUMIDITY */
	if (read_air(&data_buf[2], &data_buf[3]) != 0)
	{
		data_buf[2] = 0;
		data_buf[3] = 0;
	}

	LOG_INF("soil_humidity = %d, battery = %d, air_humidity = %d, temperature = %d",
		data_buf[0], data_buf[1], data_buf[2], (int8_t)data_buf[3]);

	return data_buf;
}

/* INFO GET REQUEST */
static struct info_data on_info_request(void)
{
	struct info_data info = {
		.fw_version = FW_VERSION,
		.hw_version = HW_VERSION,
		.device_id = device_id_buf,
	};

	return info;
}

/* PING PUT REQUEST */
static void on_ping_request(uint8_t command)
{
	switch (command)
	{
	case THREAD_COAP_UTILS_PING_CMD_BUZZER:
		buzzer_play(&ping_pattern);
		break;
	case THREAD_COAP_UTILS_PING_CMD_QUIET:
	default:
		break;
	}
}

/*
███████ ██████  ██████      ██   ██  █████  ███    ██ ██████  ██      ███████ ██████
██      ██   ██ ██   ██     ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██
███████ ██████  ██████      ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████
     ██ ██   ██ ██          ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██
███████ ██   ██ ██          ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██
*/
/* SRP client callback */
static void on_srp_client_updated(otError aError, const otSrpClientHostInfo *aHostInfo, const otSrpClientService *aServices, const otSrpClientService *aRemovedServices, void *aContext)
{
	static bool one_time = true;

	ARG_UNUSED(aHostInfo);
	ARG_UNUSED(aServices);
	ARG_UNUSED(aRemovedServices);
	ARG_UNUSED(aContext);

	LOG_INF("SRP callback: %s", otThreadErrorToString(aError));

	/* Play the OT connection tune once, after the first successful registration. */
	if ((aError == OT_ERROR_NONE) && one_time)
	{
		dk_set_led_off(RADIO_RED_LED);
		dk_set_led_off(RADIO_GREEN_LED);
		dk_set_led_off(RADIO_BLUE_LED);
		if (buzzer_play(&ot_pattern))
		{
			one_time = false;
		}
	}
}

/* Registers the CoAP service with the SRP server (called once, on the first attach). */
static void srp_client_start(otInstance *instance)
{
	otSrpClientBuffersServiceEntry *entry;
	uint16_t size;
	char *string;

	// generate a unique hostname and service name for the SRP node
	srp_client_generate_name();
	// set the SRP update callback
	otSrpClientSetCallback(instance, on_srp_client_updated, NULL);
	// set the service hostname
	if (otSrpClientSetHostName(instance, SRP_HOSTNAME) != OT_ERROR_NONE)
		LOG_INF("Cannot set SRP host name");
	// set address to auto
	if (otSrpClientEnableAutoHostAddress(instance) != OT_ERROR_NONE)
		LOG_INF("Cannot set SRP host address to auto");
	// allocate service buffers from OT SRP API
	entry = otSrpClientBuffersAllocateService(instance);
	if (entry == NULL)
	{
		LOG_ERR("Cannot allocate SRP service buffers");
		return;
	}
	// copy the service instance name into the OT SRP buffer
	string = otSrpClientBuffersGetServiceEntryInstanceNameString(entry, &size);
	snprintf(string, size, "%s", SRP_INSTANCE);
	// copy the service name (_ot._udp) into the OT SRP buffer
	string = otSrpClientBuffersGetServiceEntryServiceNameString(entry, &size);
	snprintf(string, size, "%s", service_name);
	// configure service
	entry->mService.mNumTxtEntries = 0;
	entry->mService.mPort = COAP_PORT;
	// add service
	if (otSrpClientAddService(instance, &entry->mService) != OT_ERROR_NONE)
		LOG_INF("Cannot add service to SRP client");
	else
		LOG_INF("Adding SRP client service...");
	// start SRP client (and set to auto-mode)
	otSrpClientEnableAutoStartMode(instance, NULL, NULL);
}

/*
 ██████  ████████     ██   ██  █████  ███    ██ ██████  ██      ███████ ██████
██    ██    ██        ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██
██    ██    ██        ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████
██    ██    ██        ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██
 ██████     ██        ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██

*/
/* Callback for OT network state change */
static void on_thread_state_changed(otChangedFlags flags, struct openthread_context *ot_context,
				    void *user_data)
{
	static bool srp_started;

	ARG_UNUSED(user_data);

	if (!(flags & OT_CHANGED_THREAD_ROLE))
	{
		return;
	}

	switch (otThreadGetDeviceRole(ot_context->instance))
	{
	case OT_DEVICE_ROLE_CHILD:
	case OT_DEVICE_ROLE_ROUTER:
	case OT_DEVICE_ROLE_LEADER:
		dk_set_led_off(RADIO_RED_LED);
		dk_set_led_off(RADIO_GREEN_LED);
		dk_set_led_off(RADIO_BLUE_LED);
		if (!srp_started)
		{
			// only do this once; the SRP client then runs in auto-start mode
			srp_started = true;
			dk_set_led_on(RADIO_BLUE_LED); // turned off once SRP registration succeeds
			srp_client_start(ot_context->instance);
		}
		break;

	case OT_DEVICE_ROLE_DISABLED:
	case OT_DEVICE_ROLE_DETACHED:
		dk_set_led_on(RADIO_RED_LED);
		dk_set_led_on(RADIO_GREEN_LED);
		dk_set_led_off(RADIO_BLUE_LED);
		break;

	default:
		dk_set_led_on(RADIO_RED_LED);
		dk_set_led_off(RADIO_GREEN_LED);
		dk_set_led_off(RADIO_BLUE_LED);
		break;
	}
}
static struct openthread_state_changed_cb ot_state_chaged_cb = {.state_changed_cb = on_thread_state_changed};

/*
████████ ██ ███    ███ ███████ ██████      ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
   ██    ██ ████  ████ ██      ██   ██     ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
   ██    ██ ██ ████ ██ █████   ██████      ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
   ██    ██ ██  ██  ██ ██      ██   ██     ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
   ██    ██ ██      ██ ███████ ██   ██     ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████
*/
/* Pump timer handler: the pump has run for 'pump_dc' seconds. */
static void on_pump_timer_expiry(struct k_timer *timer_id)
{
	ARG_UNUSED(timer_id);

	pump_set(false);
}

/* Buzzer timer handler: advances the pattern by one step (beep or pause). */
static void on_buzzer_timer_expiry(struct k_timer *timer_id)
{
	if (buzzer_step >= 2 * buzzer_current->beeps)
	{
		buzzer_tone(buzzer_current->frequency_khz, false);
		k_timer_stop(timer_id);
		atomic_clear(&buzzer_active);
		return;
	}

	buzzer_tone(buzzer_current->frequency_khz, (buzzer_step % 2) == 0);
	buzzer_step++;
}

/*
██████  ██    ██ ████████ ████████  ██████  ███    ██     ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
██   ██ ██    ██    ██       ██    ██    ██ ████   ██     ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
██████  ██    ██    ██       ██    ██    ██ ██ ██  ██     ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
██   ██ ██    ██    ██       ██    ██    ██ ██  ██ ██     ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
██████   ██████     ██       ██     ██████  ██   ████     ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████
*/
/* Runs the pump from the system work queue (not from the button interrupt). */
static void on_usr_button_work(struct k_work *work)
{
	ARG_UNUSED(work);

	pump_start();
}
static K_WORK_DEFINE(usr_button_work, on_usr_button_work);

/* Called when S1 is pressed. */
static void on_usr_button_changed(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(cb);
	ARG_UNUSED(pins);

	k_work_submit(&usr_button_work);
}

/*
██ ███    ██ ██ ████████
██ ████   ██ ██    ██
██ ██ ██  ██ ██    ██
██ ██  ██ ██ ██    ██
██ ██   ████ ██    ██
*/
/* Configures the pump and sensor power outputs, all off. VS_SEL off selects VCC for the sensor rail. */
static int outputs_init(void)
{
	const struct gpio_dt_spec *outputs[] = {&pump_gpio, &sensor_en_gpio, &sensor_pwr_gpio};
	int ret;

	for (size_t i = 0U; i < ARRAY_SIZE(outputs); i++)
	{
		if (!gpio_is_ready_dt(outputs[i]))
		{
			return -ENODEV;
		}
		ret = gpio_pin_configure_dt(outputs[i], GPIO_OUTPUT_INACTIVE);
		if (ret != 0)
		{
			return ret;
		}
	}

	return 0;
}

/* Configures S1 to start the pump when pressed. */
static int usr_button_init(void)
{
	int ret;

	if (!gpio_is_ready_dt(&usr_button))
	{
		return -ENODEV;
	}
	ret = gpio_pin_configure_dt(&usr_button, GPIO_INPUT);
	if (ret != 0)
	{
		return ret;
	}
	ret = gpio_pin_interrupt_configure_dt(&usr_button, GPIO_INT_EDGE_TO_ACTIVE);
	if (ret != 0)
	{
		return ret;
	}
	gpio_init_callback(&usr_button_cb_data, on_usr_button_changed, BIT(usr_button.pin));

	return gpio_add_callback(usr_button.port, &usr_button_cb_data);
}

/* Configures the soil sensor ADC channel. */
static bool adc_init(void)
{
	int ret;

	if (!device_is_ready(adc_channel.dev))
	{
		LOG_ERR("ADC controller device not ready");
		return false;
	}
	ret = adc_channel_setup_dt(&adc_channel);
	if (ret < 0)
	{
		LOG_ERR("Could not setup ADC channel (%d)", ret);
		return false;
	}

	return true;
}

/*
███    ███  █████  ██ ███    ██
████  ████ ██   ██ ██ ████   ██
██ ████ ██ ███████ ██ ██ ██  ██
██  ██  ██ ██   ██ ██ ██  ██ ██
██      ██ ██   ██ ██ ██   ████
*/
/* Initialization errors are logged (and shown on the red LED) but do not stop the boot:
 * the device must always join the network so that it stays reachable for updates. */
int main(void)
{
	int ret;

	k_sleep(K_MSEC(BOOT_DELAY));

	/*
	 _      ______ _____   _____       _____ _   _ _____ _______
	| |    |  ____|  __ \ / ____|     |_   _| \ | |_   _|__   __|
	| |    | |__  | |  | | (___         | | |  \| | | |    | |
	| |    |  __| | |  | |\___ \        | | | . ` | | |    | |
	| |____| |____| |__| |____) |      _| |_| |\  |_| |_   | |
	|______|______|_____/|_____/      |_____|_| \_|_____|  |_|
	*/
	/* First, so that the error indications below work. */
	ret = dk_leds_init();
	if (ret)
	{
		LOG_ERR("Could not initialize leds (error: %d)", ret);
	}

	/*
	 _    _  _____ ____     _____ _   _ _____ _______
	| |  | |/ ____|  _ \   |_   _| \ | |_   _|__   __|
	| |  | | (___ | |_) |    | | |  \| | | |    | |
	| |  | |\___ \|  _ <     | | | . ` | | |    | |
	| |__| |____) | |_) |   _| |_| |\  |_| |_   | |
	 \____/|_____/|____/   |_____|_| \_|_____|  |_|
	*/
	if (IS_ENABLED(CONFIG_USB_DEVICE_STACK))
	{
		ret = usb_enable(NULL);
		/* -EALREADY: USB was already enabled at boot (CONFIG_USB_DEVICE_INITIALIZE_AT_BOOT=y) */
		if ((ret != 0) && (ret != -EALREADY))
		{
			LOG_ERR("Could not enable USB (error: %d)", ret);
			dk_set_led_on(RADIO_RED_LED);
		}
	}

	/*
	  ____  _    _ _______ _____  _    _ _______ _____       _____ _   _ _____ _______
	 / __ \| |  | |__   __|  __ \| |  | |__   __/ ____|     |_   _| \ | |_   _|__   __|
	| |  | | |  | |  | |  | |__) | |  | |  | | | (___         | | |  \| | | |    | |
	| |  | | |  | |  | |  |  ___/| |  | |  | |  \___ \        | | | . ` | | |    | |
	| |__| | |__| |  | |  | |    | |__| |  | |  ____) |      _| |_| |\  |_| |_   | |
	 \____/ \____/   |_|  |_|     \____/   |_| |_____/      |_____|_| \_|_____|  |_|
	*/
	ret = outputs_init();
	if (ret)
	{
		LOG_ERR("Could not configure outputs (error: %d)", ret);
		dk_set_led_on(RADIO_RED_LED);
	}

	/*
	  _______ _____ __  __ ______ _____   _____       _____ _   _ _____ _______
	 |__   __|_   _|  \/  |  ____|  __ \ / ____|     |_   _| \ | |_   _|__   __|
		| |    | | | \  / | |__  | |__) | (___         | | |  \| | | |    | |
		| |    | | | |\/| |  __| |  _  / \___ \        | | | . ` | | |    | |
		| |   _| |_| |  | | |____| | \ \ ____) |      _| |_| |\  |_| |_   | |
		|_|  |_____|_|  |_|______|_|  \_\_____/      |_____|_| \_|_____|  |_|
	*/
	/* Before the button, which starts the pump timer. */
	k_timer_init(&pump_timer, on_pump_timer_expiry, NULL);
	k_timer_init(&buzzer_timer, on_buzzer_timer_expiry, NULL);

	/*
	 ____  _    _ _______ _______ ____  _   _  _____       _____ _   _ _____ _______
	|  _ \| |  | |__   __|__   __/ __ \| \ | |/ ____|     |_   _| \ | |_   _|__   __|
	| |_) | |  | |  | |     | | | |  | |  \| | (___         | | |  \| | | |    | |
	|  _ <| |  | |  | |     | | | |  | | . ` |\___ \        | | | . ` | | |    | |
	| |_) | |__| |  | |     | | | |__| | |\  |____) |      _| |_| |\  |_| |_   | |
	|____/ \____/   |_|     |_|  \____/|_| \_|_____/      |_____|_| \_|_____|  |_|
	*/
	ret = usr_button_init();
	if (ret)
	{
		LOG_ERR("Could not configure the user button (error: %d)", ret);
	}
	else
	{
		LOG_INF("Set up user button at %s pin %d", usr_button.port->name, usr_button.pin);
	}

	/*
	  _____ ______ _   _  _____  ____  _____   _____       _____ _   _ _____ _______
	 / ____|  ____| \ | |/ ____|/ __ \|  __ \ / ____|     |_   _| \ | |_   _|__   __|
	| (___ | |__  |  \| | (___ | |  | | |__) | (___         | | |  \| | | |    | |
	 \___ \|  __| | . ` |\___ \| |  | |  _  / \___ \        | | | . ` | | |    | |
	 ____) | |____| |\  |____) | |__| | | \ \ ____) |      _| |_| |\  |_| |_   | |
	|_____/|______|_| \_|_____/ \____/|_|  \_\_____/      |_____|_| \_|_____|  |_|
	*/
	/* Temperature and humidity sensor: 2 red blinks if missing */
	hdc_ready = device_is_ready(dev_hdc);
	if (!hdc_ready)
	{
		LOG_ERR("Device %s is not ready", dev_hdc->name);
		blink_error(2);
	}

	/* Fuel gauge: 3 red blinks if missing */
	fuel_gauge_ready = device_is_ready(dev_fuelgauge);
	if (!fuel_gauge_ready)
	{
		LOG_ERR("Fuel gauge is not ready");
		blink_error(3);
	}

	/* ADC (soil moisture) */
	adc_ready = adc_init();
	if (!adc_ready)
	{
		dk_set_led_on(RADIO_RED_LED);
	}

	/* Log a first set of readings */
	device_id_init();
	(void)on_data_request();
	if (fuel_gauge_ready)
	{
		log_fuel_gauge();
	}

	/*
	  _____ ____          _____        _____ _   _ _____ _______
	 / ____/ __ \   /\   |  __ \      |_   _| \ | |_   _|__   __|
	| |   | |  | | /  \  | |__) |       | | |  \| | | |    | |
	| |   | |  | |/ /\ \ |  ___/        | | | . ` | | |    | |
	| |___| |__| / ____ \| |           _| |_| |\  |_| |_   | |
	 \_____\____/_/    \_\_|          |_____|_| \_|_____|  |_|
	*/
	LOG_INF("Start CoAP-server sample");
	ret = ot_coap_init(&on_pumpdc_request, &on_pump_request, &on_data_request, &on_info_request, &on_ping_request);
	if (ret)
	{
		LOG_ERR("Could not initialize OpenThread CoAP");
		dk_set_led_on(RADIO_RED_LED);
	}

	/*
	 ____   ____   ____ _______     _    _ _____         _____ ______ ____  _    _ ______ _   _  _____ ______
	|  _ \ / __ \ / __ \__   __|   | |  | |  __ \       / ____|  ____/ __ \| |  | |  ____| \ | |/ ____|  ____|
	| |_) | |  | | |  | | | |______| |  | | |__) |     | (___ | |__ | |  | | |  | | |__  |  \| | |    | |__
	|  _ <| |  | | |  | | | |______| |  | |  ___/       \___ \|  __|| |  | | |  | |  __| | . ` | |    |  __|
	| |_) | |__| | |__| | | |      | |__| | |           ____) | |___| |__| | |__| | |____| |\  | |____| |____
	|____/ \____/ \____/  |_|       \____/|_|          |_____/|______\___\_\\____/|______|_| \_|\_____|______|
	*/
	LOG_INF("Initialization done. Starting OpenThread...");
	dk_set_led_on(RADIO_GREEN_LED);
	buzzer_tone(2, true);
	k_sleep(K_MSEC(INIT_BUZZER_PERIOD));
	dk_set_led_off(RADIO_GREEN_LED);
	buzzer_tone(4, true);
	k_sleep(K_MSEC(INIT_BUZZER_PERIOD));
	dk_set_led_on(RADIO_GREEN_LED);
	buzzer_tone(6, true);
	k_sleep(K_MSEC(INIT_BUZZER_PERIOD));
	dk_set_led_off(RADIO_GREEN_LED);
	buzzer_tone(6, false);

	/*
	  ____  _____  ______ _   _ _______ _    _ _____  ______          _____        _____ _   _ _____ _______
	 / __ \|  __ \|  ____| \ | |__   __| |  | |  __ \|  ____|   /\   |  __ \      |_   _| \ | |_   _|__   __|
	| |  | | |__) | |__  |  \| |  | |  | |__| | |__) | |__     /  \  | |  | |       | | |  \| | | |    | |
	| |  | |  ___/|  __| | . ` |  | |  |  __  |  _  /|  __|   / /\ \ | |  | |       | | | . ` | | |    | |
	| |__| | |    | |____| |\  |  | |  | |  | | | \ \| |____ / ____ \| |__| |      _| |_| |\  |_| |_   | |
	 \____/|_|    |______|_| \_|  |_|  |_|  |_|_|  \_\______/_/    \_\_____/      |_____|_| \_|_____|  |_|
	*/
	ret = openthread_state_changed_cb_register(openthread_get_default_context(), &ot_state_chaged_cb);
	if (ret)
	{
		LOG_ERR("Could not register OpenThread callback");
		dk_set_led_on(RADIO_RED_LED);
	}
	ret = openthread_start(openthread_get_default_context());
	if (ret)
	{
		LOG_ERR("Could not start OpenThread");
		dk_set_led_on(RADIO_RED_LED);
	}

	return 0;
}
