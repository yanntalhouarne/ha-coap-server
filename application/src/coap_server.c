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
/* ZEPHYR */
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/openthread.h>
#include <zephyr/usb/usb_device.h>
#include <zephyr/random/rand32.h>
#include <zephyr/devicetree.h>
#include <zephyr/device.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/drivers/fuel_gauge.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/drivers/pwm.h>
#include <zephyr/drivers/uart.h>
/* OPENTHREAD */
#include <openthread/thread.h>
#include <openthread/srp_client.h>
#include <openthread/srp_client_buffers.h>
/* APPLICATION */
#include <dk_buttons_and_leds.h>
#include "../include/ot_coap_utils.h"
#include "../include/ot_srp_config.h"
#include "../include/coap_server.h"
/* OTHERS */
#include <stdio.h>

/*
 ██████  ██████   █████  ██████      ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
██      ██    ██ ██   ██ ██   ██     ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
██      ██    ██ ███████ ██████      ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
██      ██    ██ ██   ██ ██          ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
 ██████  ██████  ██   ██ ██          ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████

*/
/* PUMP PUT REQUEST */
static void on_pump_request(uint8_t command)
{
	switch (command)
	{
	case THREAD_COAP_UTILS_PUMP_CMD_ON:
		if (coap_is_pump_active() == false)
		{
			/* fetch IMU data */
			if (sensor_sample_fetch(lsm6dsl_dev) < 0)
			{
				LOG_INF("Sensor sample update error\n");
			}
			// /* lsm6dsl accel */
			// sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_ACCEL_X, &accel_x_out);
			// sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_ACCEL_Y, &accel_y_out);
			// sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_ACCEL_Z, &accel_z_out);
			// LOG_INF("x-accel = %d.%06d ms/2, z-accel = = %d.%06d ms/2, z-accel = = %d.%06d ms/2  %%\n",
			// 		x.val1, x.val2, y.val1, y.val2, z.val1, z.val2);
			// /* lsm6dsl gyro */
			// sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_GYRO_X, &gyro_x_out);
			// sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_GYRO_Y, &gyro_y_out);
			// sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_GYRO_Z, &gyro_z_out);
			// LOG_INF("x-gyro = %d.%06d dps, z-gyro = = %d.%06d dps, z-gyro = = %d.%06d dps  %%\n",
			// 		x.val1, x.val2, y.val1, y.val2, z.val1, z.val2);

			coap_activate_pump();
			dk_set_led_on(LED1);
			dk_set_led_on(WATER_PUMP);
			pwm_set_dt(&pwm_buzzer, PWM_KHZ(6), PWM_KHZ(6) / 2U);
			k_timer_start(&pump_timer, K_SECONDS(PUMP_MAX_ACTIVE_TIME), K_NO_WAIT); // pump will be active for 5 seconds, unless a stop command is received
			k_timer_start(&buzzer_timer, K_MSEC(OT_BUZZER_PERIOD), K_NO_WAIT);
		}
		break;

	case THREAD_COAP_UTILS_PUMP_CMD_OFF:
		if (coap_is_pump_active() == true)
		{
			coap_diactivate_pump();
			dk_set_led_off(LED1);
			dk_set_led_off(WATER_PUMP);
			k_timer_stop(&pump_timer);
		}
		break;

	default:
		break;
	}
}

/* DATA GET REQUEST */
static int8_t *on_data_request()
{
	int err;
	int32_t val_mv;
	float temp_val = 0;

	/* READ TEMPERATURE */
	for (size_t i = 0U; i < ARRAY_SIZE(adc_channels); i++)
	{

		(void)adc_sequence_init_dt(&adc_channels[i], &sequence);

		err = adc_read(adc_channels[i].dev, &sequence);
		if (err < 0)
		{
			LOG_ERR("Could not read (%d)\n", err);
			continue;
		}

		/* conversion to mV may not be supported, skip if not */
		val_mv = buf;
		err = adc_raw_to_millivolts_dt(&adc_channels[i],
									   &val_mv);
		if (err < 0)
		{
			LOG_ERR(" (value in mV not available)\n");
		}
	}
	// converts from mV to humidity
	temp_val = (float)val_mv;
	if (temp_val < HUMIDITY_WET)
		temp_val = HUMIDITY_WET;
	else if (temp_val > HUMIDITY_DRY)
		temp_val = HUMIDITY_DRY;
	temp_val -= HUMIDITY_WET;
	temp_val /= (HUMIDITY_DRY - HUMIDITY_WET);
	temp_val *= 100;
	temp_val = 100 - temp_val;

	ti_hdc_buf[0] = (uint8_t)temp_val;

	/* READ BATTERY SOC */
	err = fuel_gauge_get_prop(dev_fuelgauge, props_fuel_gauge, ARRAY_SIZE(props_fuel_gauge));
	if (err < 0)
	{
		LOG_INF("Error: properties\n");
	}
	else
	{
		if (err != 0)
		{
			LOG_INF("Warning: (Fuel-gauge)\n");
		}
		if (props_fuel_gauge[2].status == 0)
		{
			ti_hdc_buf[1] = (uint8_t)props_fuel_gauge[2].value.state_of_charge;
		}
		else
		{
			LOG_INF(
				"SOC error %d\n",
				props_fuel_gauge[2].status);
			ti_hdc_buf[1] = 0;
		}
	}

	/* READ AIR TEMPERATURE AND HUMIDITY*/
	struct sensor_value temp, humidity;
	sensor_sample_fetch(dev_hdc);
	sensor_channel_get(dev_hdc, SENSOR_CHAN_AMBIENT_TEMP, &temp);
	sensor_channel_get(dev_hdc, SENSOR_CHAN_HUMIDITY, &humidity);
	ti_hdc_buf[2] = humidity.val1;
	ti_hdc_buf[3] = temp.val1;

	/* print the result */
	LOG_INF("Temp = %d.%06d C, RH = %d.%06d %%\n",
			temp.val1, temp.val2, humidity.val1, humidity.val2);

	LOG_INF("soil_humidity = %d, battery = %d, air_humidity = %d, temperature = %d\n", ti_hdc_buf[0], ti_hdc_buf[1]);

	return ti_hdc_buf;
}

/*
███████ ██████  ██████      ██   ██  █████  ███    ██ ██████  ██      ███████ ██████
██      ██   ██ ██   ██     ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██
███████ ██████  ██████      ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████
	 ██ ██   ██ ██          ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██
███████ ██   ██ ██          ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██
*/
/* SRP client callback */
void on_srp_client_updated(otError aError, const otSrpClientHostInfo *aHostInfo, const otSrpClientService *aServices, const otSrpClientService *aRemovedServices, void *aContext)
{
	LOG_INF("SRP callback: %s", otThreadErrorToString(aError));
	if (aError == OT_ERROR_NONE)
	{
		// start buzzer OT connection tune
		k_timer_start(&ot_buzzer_timer, K_MSEC(1), K_NO_WAIT);
	}
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
	static uint8_t oneTime = 0;
	if (flags & OT_CHANGED_THREAD_ROLE)
	{
		switch (otThreadGetDeviceRole(ot_context->instance))
		{
		case OT_DEVICE_ROLE_CHILD:
		case OT_DEVICE_ROLE_ROUTER:
		case OT_DEVICE_ROLE_LEADER:
			// dk_set_led_on(RADIO_GREEN_LED);
			otSrpClientBuffersServiceEntry *entry = NULL;
			uint16_t size;
			char *string;
			if (!oneTime)
			{
				// only do this once
				oneTime = 1;
				// generate a unique hostname and servie name for the SRP node
				srp_client_generate_name();
				// set the SRP update callback
				otSrpClientSetCallback(openthread_get_default_instance(), on_srp_client_updated, NULL);
// set the service hostname
#if defined SRP_CLIENT_RNG || defined SRP_CLIENT_UNIQUE || defined SRP_CLIENT_MANUAL
				if (otSrpClientSetHostName(openthread_get_default_instance(), realhostname) != OT_ERROR_NONE)
#else
				if (otSrpClientSetHostName(openthread_get_default_instance(), hostname) != OT_ERROR_NONE)
#endif
					LOG_INF("Cannot set SRP host name");
				// set address to auto
				if (otSrpClientEnableAutoHostAddress(openthread_get_default_instance()) != OT_ERROR_NONE)
					LOG_INF("Cannot set SRP host address to auto");
				// allocate service buffers from OT SRP API
				entry = otSrpClientBuffersAllocateService(openthread_get_default_instance());
				// get the service instance name string buffer from OT SRP API
				string = otSrpClientBuffersGetServiceEntryInstanceNameString(entry, &size); // make sure "service_instance" is not bigger than "size"!
// copy the service instance
#if defined SRP_CLIENT_RNG || defined SRP_CLIENT_UNIQUE || defined SRP_CLIENT_MANUAL
				memcpy(string, realinstance, sizeof(realinstance) + 1);
#else
				memcpy(string, service_instance, sizeof(service_instance) + 1);
#endif
				// get the service name string buffer from OT SRP API
				string = otSrpClientBuffersGetServiceEntryServiceNameString(entry, &size);
				// copy the service name (_ot._udp)
				memcpy(string, service_name, sizeof(service_name) + 1); // make sure "service_name" is not bigger than "size"!;
				// configure service
				entry->mService.mNumTxtEntries = 0;
				entry->mService.mPort = 49154;
				// add service
				if (otSrpClientAddService(openthread_get_default_instance(), &entry->mService) != OT_ERROR_NONE)
					LOG_INF("Cannot add service to SRP client");
				else
					LOG_INF("Adding SRP client service...");
				// start SRP client (and set to auto-mode)
				otSrpClientEnableAutoStartMode(openthread_get_default_instance(), NULL, NULL);
				entry = NULL;
			}
			break;

		case OT_DEVICE_ROLE_DISABLED:
		case OT_DEVICE_ROLE_DETACHED:
		default:
			dk_set_led_off(RADIO_GREEN_LED);
			break;
		}
	}
}

/*
████████ ██ ███    ███ ███████ ██████      ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
   ██    ██ ████  ████ ██      ██   ██     ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
   ██    ██ ██ ████ ██ █████   ██████      ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
   ██    ██ ██  ██  ██ ██      ██   ██     ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
   ██    ██ ██      ██ ███████ ██   ██     ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████
*/
/* Pump timer handler */
static void on_pump_timer_expiry(struct k_timer *timer_id)
{
	ARG_UNUSED(timer_id);

	coap_diactivate_pump();

	dk_set_led_off(LED1);
	dk_set_led_off(WATER_PUMP);

	k_timer_stop(&pump_timer);
}

/* Stops the buzzer one second after timer_start() has been called  */
static void on_buzzer_timer_expiry(struct k_timer *timer_id)
{
	ARG_UNUSED(timer_id);

	pwm_set_dt(&pwm_buzzer, PWM_KHZ(6), 0);

	k_timer_stop(&buzzer_timer);
}

/* Pulses the buzzer "OT_BUZZER_NBR_PULSES" times with a period of "OT_BUZZER_PERIOD" upon connection to the OT network. */
static void on_ot_buzzer_timer_expiry(struct k_timer *timer_id)
{
	ARG_UNUSED(timer_id);

	static uint8_t cnt = 0;

	if (cnt < OT_BUZZER_NBR_PULSES)
	{
		if (cnt % 2) // 1, 3, 5, ...
		{
			pwm_set_dt(&pwm_buzzer, PWM_KHZ(6), 0);
			k_timer_start(&ot_buzzer_timer, K_MSEC(OT_BUZZER_PERIOD), K_NO_WAIT);
		}
		else // 0, 2, 4, ...
		{
			pwm_set_dt(&pwm_buzzer, PWM_KHZ(6), PWM_KHZ(6) / 2U);
			k_timer_start(&ot_buzzer_timer, K_MSEC(OT_BUZZER_PERIOD), K_NO_WAIT);
		}
		cnt++;
	}
	else
	{
		cnt = 0;
		k_timer_stop(&ot_buzzer_timer);
	}
}

/* Called when S1 is pressed. */
static void on_button_changed(uint32_t button_state, uint32_t has_changed)
{
	uint32_t buttons = button_state & has_changed;

	if (buttons & 4)
	{
		// k_work_submit(&provisioning_work);
	}
}

/* Fetches the ADC value every "ADC_TIMER_PERIOD" seconds.*/
#ifdef ADC_TIMER_ENABLED
static void on_adc_timer_expiry(struct k_timer *timer_id)
{
	ARG_UNUSED(timer_id);
	int err;
	int32_t val_mv;

	for (size_t i = 0U; i < ARRAY_SIZE(adc_channels); i++)
	{

		(void)adc_sequence_init_dt(&adc_channels[i], &sequence);

		err = adc_read(adc_channels[i].dev, &sequence);
		if (err < 0)
		{
			LOG_ERR("Could not read (%d)\n", err);
			continue;
		}

		/* conversion to mV may not be supported, skip if not */
		val_mv = buf;
		err = adc_raw_to_millivolts_dt(&adc_channels[i],
									   &val_mv);
		if (err < 0)
		{
			LOG_ERR(" (value in mV not available)\n");
		}
	}

	adc_reading = (int16_t)val_mv;
}
#endif

/*
██   ██ ███████ ██      ██████  ███████ ██████  ███████
██   ██ ██      ██      ██   ██ ██      ██   ██ ██
███████ █████   ██      ██████  █████   ██████  ███████
██   ██ ██      ██      ██      ██      ██   ██      ██
██   ██ ███████ ███████ ██      ███████ ██   ██ ███████
*/
/* Generates a unique SRP hostname and service name */
void srp_client_generate_name()
{
#ifdef SRP_CLIENT_UNIQUE
	LOG_INF("Appending device ID to hostname");
	// first copy the hostname and service instance defined defined by SRP_CLIENT_HOSTNAME and SRP_CLIENT_SERVICE_INSTANCE, respectively
	memcpy(realhostname, hostname, sizeof(hostname));
	memcpy(realinstance, service_instance, sizeof(service_instance));
	// get a device ID
	uint32_t device_id = NRF_FICR->DEVICEID[0];
	// append the random number as a string to the hostname and service_instance buffers (numbe of digits is defined by SRP_CLIENT_RAND_SIZE)
	snprintf(realhostname + sizeof(hostname) - 1, SRP_CLIENT_UNIQUE_SIZE + 2, "-%x", device_id);
	snprintf(realinstance + sizeof(service_instance) - 1, SRP_CLIENT_UNIQUE_SIZE + 2, "-%x", device_id);
	LOG_INF("hostname is: %s\n", realhostname);
	LOG_INF("service instance is: %s\n", realinstance);
#elif SRP_CLIENT_RNG
	LOG_INF("Appending random number to hostname");
	/* append a random number of size SRP_CLIENT_RAND_SIZE to the service hostname and service instance string buffers */
	// first copy the hostname and service instance defined defined by SRP_CLIENT_HOSTNAME and SRP_CLIENT_SERVICE_INSTANCE, respectively
	memcpy(realhostname, hostname, sizeof(hostname));
	memcpy(realinstance, service_instance, sizeof(service_instance));
	// get a random uint32_t (true random, hw based)
	uint32_t rn = sys_rand32_get();
	// append the random number as a string to the hostname and service_instance buffers (numbe of digits is defined by SRP_CLIENT_RAND_SIZE)
	snprintf(realhostname + sizeof(hostname) - 1, SRP_CLIENT_RAND_SIZE + 2, "-%x", rn);
	snprintf(realinstance + sizeof(service_instance) - 1, SRP_CLIENT_RAND_SIZE + 2, "-%x", rn);
	LOG_INF("hostname is: %s\n", realhostname);
	LOG_INF("service instance is: %s\n", realinstance);
#elif SRP_CLIENT_MANUAL
	LOG_INF("Appending manual ID to hostname");
	/* append the device ID of size SRP_CLIENT_MANUAL_SIZE to the service hostname and service instance string buffers */
	// first copy the hostname and service instance defined defined by SRP_CLIENT_HOSTNAME and SRP_CLIENT_SERVICE_INSTANCE, respectively
	memcpy(realhostname, hostname, sizeof(hostname));
	memcpy(realinstance, service_instance, sizeof(service_instance));
	// get a random uint32_t (true random, hw based)
	uint32_t manual_id = SRP_CLIENT_MANUAL_ID;
	// append the random number as a string to the hostname and service_instance buffers (numbe of digits is defined by SRP_CLIENT_MANUAL_SIZE)
	snprintf(realhostname + sizeof(hostname) - 1, SRP_CLIENT_MANUAL_SIZE + 2, "-%x", manual_id);
	snprintf(realinstance + sizeof(service_instance) - 1, SRP_CLIENT_MANUAL_SIZE + 2, "-%x", manual_id);
	LOG_INF("hostname is: %s\n", realhostname);
	LOG_INF("service instance is: %s\n", realinstance);
#else
	LOG_INF("hostname is: %s\n", hostname);
	LOG_INF("service instance is: %s\n", service_instance);
#endif
}

/*
███    ███  █████  ██ ███    ██
████  ████ ██   ██ ██ ████   ██
██ ████ ██ ███████ ██ ██ ██  ██
██  ██  ██ ██   ██ ██ ██  ██ ██
██      ██ ██   ██ ██ ██   ████
*/
int main(void)
{

	/*
	 _      ____   _____          _       _____       _____ _   _ _____ _______
	| |    / __ \ / ____|   /\   | |     / ____|     |_   _| \ | |_   _|__   __|
	| |   | |  | | |       /  \  | |    | (___         | | |  \| | | |    | |
	| |   | |  | | |      / /\ \ | |     \___ \        | | | . ` | | |    | |
	| |___| |__| | |____ / ____ \| |____ ____) |      _| |_| |\  |_| |_   | |
	|______\____/ \_____/_/    \_\______|_____/      |_____|_| \_|_____|  |_|
	*/
	int ret;

	/*
	 _      ______ _____   _____       _____ _   _ _____ _______
	| |    |  ____|  __ \ / ____|     |_   _| \ | |_   _|__   __|
	| |    | |__  | |  | | (___         | | |  \| | | |    | |
	| |    |  __| | |  | |\___ \        | | | . ` | | |    | |
	| |____| |____| |__| |____) |      _| |_| |\  |_| |_   | |
	|______|______|_____/|_____/      |_____|_| \_|_____|  |_|
	*/
	/*******************
	 * Initialize LEDs *
	 *******************/
	ret = dk_leds_init();
	if (ret)
	{
		LOG_ERR("Could not initialize leds (error: %d", ret);
		goto end;
	}

	/*
	 ____  _    _ _______ _______ ____  _   _  _____       _____ _   _ _____ _______
	|  _ \| |  | |__   __|__   __/ __ \| \ | |/ ____|     |_   _| \ | |_   _|__   __|
	| |_) | |  | |  | |     | | | |  | |  \| | (___         | | |  \| | | |    | |
	|  _ <| |  | |  | |     | | | |  | | . ` |\___ \        | | | . ` | | |    | |
	| |_) | |__| |  | |     | | | |__| | |\  |____) |      _| |_| |\  |_| |_   | |
	|____/ \____/   |_|     |_|  \____/|_| \_|_____/      |_____|_| \_|_____|  |_|
	*/
	/**********************
	 * Initialize buttons *
	 **********************/
	ret = dk_buttons_init(on_button_changed);
	if (ret)
	{
		LOG_ERR("Cannot initialize buttons (error: %d)", ret);
		goto end;
	}

	/*
	 ____   ____   ____ _______     _    _ _____        _____ _   _ _____ _______
	|  _ \ / __ \ / __ \__   __|   | |  | |  __ \      |_   _| \ | |_   _|__   __|
	| |_) | |  | | |  | | | |______| |  | | |__) |       | | |  \| | | |    | |
	|  _ <| |  | | |  | | | |______| |  | |  ___/        | | | . ` | | |    | |
	| |_) | |__| | |__| | | |      | |__| | |           _| |_| |\  |_| |_   | |
	|____/ \____/ \____/  |_|       \____/|_|          |_____|_| \_|_____|  |_|

	*/
	/*********************
	 * Boot-up sequence *
	 *********************/
	dk_set_led_on(RADIO_GREEN_LED);
	pwm_set_dt(&pwm_buzzer, PWM_KHZ(2), PWM_KHZ(2) / 2U);
	k_sleep(K_MSEC(INIT_BUZZER_PERIOD));
	dk_set_led_off(RADIO_GREEN_LED);
	pwm_set_dt(&pwm_buzzer, PWM_KHZ(4), PWM_KHZ(4) / 2U);
	k_sleep(K_MSEC(INIT_BUZZER_PERIOD));
	dk_set_led_on(RADIO_GREEN_LED);
	pwm_set_dt(&pwm_buzzer, PWM_KHZ(6), PWM_KHZ(6) / 2U);
	k_sleep(K_MSEC(INIT_BUZZER_PERIOD));
	dk_set_led_off(RADIO_GREEN_LED);
	pwm_set_dt(&pwm_buzzer, PWM_KHZ(6), 0);
	LOG_INF("Starting application...\n\n");
	k_sleep(K_MSEC(5000));

	/*
	  _______ ____  ______        _____ ______ _   _  _____  ____  _____        _____ _   _ _____ _______
	 |__   __/ __ \|  ____|      / ____|  ____| \ | |/ ____|/ __ \|  __ \      |_   _| \ | |_   _|__   __|
		| | | |  | | |__        | (___ | |__  |  \| | (___ | |  | | |__) |       | | |  \| | | |    | |
		| | | |  | |  __|        \___ \|  __| | . ` |\___ \| |  | |  _  /        | | | . ` | | |    | |
		| | | |__| | |           ____) | |____| |\  |____) | |__| | | \ \       _| |_| |\  |_| |_   | |
		|_|  \____/|_|          |_____/|______|_| \_|_____/ \____/|_|  \_\     |_____|_| \_|_____|  |_|
	*/
	// /****************************
	//  * TOF sensor configuration *
	//  ****************************/
	// dk_set_led_on(TOF_EN);
	// struct sensor_value value;
	// if (!device_is_ready(dev_tof)) {
	// 	LOG_INF("sensor: device not ready.\n");
	// 	goto end;
	// }
	// /*************************
	//  * Fetch TOF sensor data *
	//  *************************/
	// ret = sensor_sample_fetch(dev_tof);
	// if (ret) {
	// 	LOG_INF("sensor_sample_fetch failed ret %d\n", ret);
	// 	goto end;
	// }
	// /*************************
	//  * Print TOF sensor data *
	//  *************************/
	// ret = sensor_channel_get(dev_tof, SENSOR_CHAN_PROX, &value);
	// LOG_INF("prox is %d\n", value.val1);

	// ret = sensor_channel_get(dev_tof,
	// 				SENSOR_CHAN_DISTANCE,
	// 				&value);
	// LOG_INF("distance is %.3fm\n", sensor_value_to_double(&value));
	// dk_set_led_off(TOF_EN);

	/*
	  _____ __  __ _    _       _____ _   _ _____ _______
	 |_   _|  \/  | |  | |     |_   _| \ | |_   _|__   __|
	  | | | \  / | |  | |       | | |  \| | | |    | |
	  | | | |\/| | |  | |       | | | . ` | | |    | |
	 _| |_| |  | | |__| |      _| |_| |\  |_| |_   | |
	|_____|_|  |_|\____/      |_____|_| \_|_____|  |_|
	*/
	/*********************
	 * IMU configuration *
	 *********************/
	if (!device_is_ready(lsm6dsl_dev))
	{
		LOG_ERR("\nError: Device \"%s\" is not ready\n");
		goto end;
	}
	LOG_INF("Dev %p name %s is ready!\n", lsm6dsl_dev, lsm6dsl_dev->name);
	odr_attr.val1 = 104;
	odr_attr.val2 = 0;
	/* set acceleration sampling frequency to 104 Hz*/
	if (sensor_attr_set(lsm6dsl_dev, SENSOR_CHAN_ACCEL_XYZ,
						SENSOR_ATTR_SAMPLING_FREQUENCY, &odr_attr) < 0)
	{
		LOG_ERR("Cannot set sampling frequency for accelerometer.\n");
		goto end;
	}
	/* set gyro sampling frequency to 104 Hz*/
	if (sensor_attr_set(lsm6dsl_dev, SENSOR_CHAN_GYRO_XYZ,
						SENSOR_ATTR_SAMPLING_FREQUENCY, &odr_attr) < 0)
	{
		LOG_ERR("Cannot set sampling frequency for gyro.\n");
		goto end;
	}
	/*****************
	 * Fetch IMU data *
	 ******************/
	if (sensor_sample_fetch(lsm6dsl_dev) < 0)
	{
		LOG_INF("IMU sensor sample update error\n");
		goto end;
	}
	/******************
	 * Print IMU data *
	 ******************/
	// LOG_INF("LSM6DSL sensor data:\n");
	// /* lsm6dsl accel */
	sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_ACCEL_X, &accel_x_out);
	sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_ACCEL_Y, &accel_y_out);
	sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_ACCEL_Z, &accel_z_out);
	LOG_INF("x-accel = %d.%06d ms/2, z-accel = = %d.%06d ms/2, z-accel = = %d.%06d ms/2  %%\n",
			accel_x_out.val1, accel_x_out.val2, accel_y_out.val1, accel_y_out.val2, accel_z_out.val1, accel_z_out.val2);
	/* lsm6dsl gyro */
	sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_GYRO_X, &gyro_x_out);
	sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_GYRO_Y, &gyro_y_out);
	sensor_channel_get(lsm6dsl_dev, SENSOR_CHAN_GYRO_Z, &gyro_z_out);
	LOG_INF("x-gyro = %d.%06d dps, z-gyro = = %d.%06d dps, z-gyro = = %d.%06d dps  %%\n",
			gyro_x_out.val1, gyro_x_out.val2, gyro_y_out.val1, gyro_y_out.val2, gyro_y_out.val1, gyro_y_out.val2);

	/*
	 _    _ _____   _____        _____ ______ _   _  _____  ____  _____        _____ _   _ _____ _______
	| |  | |  __ \ / ____|      / ____|  ____| \ | |/ ____|/ __ \|  __ \      |_   _| \ | |_   _|__   __|
	| |__| | |  | | |          | (___ | |__  |  \| | (___ | |  | | |__) |       | | |  \| | | |    | |
	|  __  | |  | | |           \___ \|  __| | . ` |\___ \| |  | |  _  /        | | | . ` | | |    | |
	| |  | | |__| | |____       ____) | |____| |\  |____) | |__| | | \ \       _| |_| |\  |_| |_   | |
	|_|  |_|_____/ \_____|     |_____/|______|_| \_|_____/ \____/|_|  \_\     |_____|_| \_|_____|  |_|
	*/
	/****************************
	 * HDC sensor configuration *
	 *****************************/
	if (!device_is_ready(dev_hdc))
	{
		LOG_ERR("\nError: Device \"%s\" is not ready\n");
		goto end;
	}
	LOG_INF("Dev %p name %s is ready!\n", dev_hdc, dev_hdc->name);
	/*************************
	 * Fetch HDC sensor data *
	 **************************/
	LOG_INF("Fetching...\n");
	sensor_sample_fetch(dev_hdc);
	sensor_channel_get(dev_hdc, SENSOR_CHAN_AMBIENT_TEMP, &temp);
	sensor_channel_get(dev_hdc, SENSOR_CHAN_HUMIDITY, &humidity);
	/*************************
	 * Print HDC sensor data *
	 **************************/
	LOG_INF("Temp = %d.%06d C, RH = %d.%06d %%\n",
			temp.val1, temp.val2, humidity.val1, humidity.val2);

	/*
	 ______ _    _ ______ _         _____         _    _  _____ ______       _____ _   _ _____ _______
	|  ____| |  | |  ____| |       / ____|   /\  | |  | |/ ____|  ____|     |_   _| \ | |_   _|__   __|
	| |__  | |  | | |__  | |      | |  __   /  \ | |  | | |  __| |__          | | |  \| | | |    | |
	|  __| | |  | |  __| | |      | | |_ | / /\ \| |  | | | |_ |  __|         | | | . ` | | |    | |
	| |    | |__| | |____| |____  | |__| |/ ____ \ |__| | |__| | |____       _| |_| |\  |_| |_   | |
	|_|     \____/|______|______|  \_____/_/    \_\____/ \_____|______|     |_____|_| \_|_____|  |_|
	*/
	/****************************
	 * Fuel gauge configuration *
	 *****************************/
	if (!device_is_ready(dev_fuelgauge))
	{
		LOG_ERR("\nError: Device \"%s\" is not ready\n");
		goto end;
	}
	LOG_INF("Dev %p name %s is ready!\n", dev_fuelgauge, dev_fuelgauge->name);
	/***********************************
	 * Fetch and print fuel gauge data *
	 ************************************/
	ret = fuel_gauge_get_prop(dev_fuelgauge, props_fuel_gauge, ARRAY_SIZE(props_fuel_gauge));
	if (ret < 0)
	{
		LOG_ERR("Error: cannot get properties\n");
	}
	else
	{
		if (ret != 0)
		{
			LOG_ERR("Warning: Some properties failed\n");
		}
		if (props_fuel_gauge[0].status == 0)
		{
			LOG_INF("Time to empty %d\n", props_fuel_gauge[0].value.runtime_to_empty);
		}
		else
		{
			LOG_ERR(
				"Time to empty error %d\n",
				props_fuel_gauge[0].status);
		}
		if (props_fuel_gauge[1].status == 0)
		{
			LOG_INF("Time to full %d\n", props_fuel_gauge[1].value.runtime_to_full);
		}
		else
		{
			LOG_ERR(
				"Time to full error %d\n",
				props_fuel_gauge[1].status);
		}
		if (props_fuel_gauge[2].status == 0)
		{
			LOG_INF("Charge %d%%\n", props_fuel_gauge[2].value.state_of_charge);
		}
		else
		{
			LOG_ERR(
				"Time to full error %d\n",
				props_fuel_gauge[2].status);
		}
		if (props_fuel_gauge[3].status == 0)
		{
			LOG_INF("Voltage %d\n", props_fuel_gauge[3].value.voltage);
		}
		else
		{
			LOG_ERR(
				"FUEL_GAUGE_VOLTAGEerror %d\n",
				props_fuel_gauge[3].status);
		}
	}

	/*
			  _____   _____       _____ _   _ _____ _______
		/\   |  __ \ / ____|     |_   _| \ | |_   _|__   __|
	   /  \  | |  | | |            | | |  \| | | |    | |
	  / /\ \ | |  | | |            | | | . ` | | |    | |
	 / ____ \| |__| | |____       _| |_| |\  |_| |_   | |
	/_/    \_\_____/ \_____|     |_____|_| \_|_____|  |_|
	*/
	/*****************
	 * Configure ADC *
	 *****************/
	for (size_t i = 0U; i < ARRAY_SIZE(adc_channels); i++)
	{
		if (!device_is_ready(adc_channels[i].dev))
		{
			LOG_ERR("ADC controller device not ready\n");
			goto end;
		}
		ret = adc_channel_setup_dt(&adc_channels[i]);
		if (ret < 0)
		{
			LOG_ERR("Could not setup channel #%d (%d)\n", i, ret);
			goto end;
		}
	}

	/*
	  _______ _____ __  __ ______ _____   _____       _____ _   _ _____ _______
	 |__   __|_   _|  \/  |  ____|  __ \ / ____|     |_   _| \ | |_   _|__   __|
		| |    | | | \  / | |__  | |__) | (___         | | |  \| | | |    | |
		| |    | | | |\/| |  __| |  _  / \___ \        | | | . ` | | |    | |
		| |   _| |_| |  | | |____| | \ \ ____) |      _| |_| |\  |_| |_   | |
		|_|  |_____|_|  |_|______|_|  \_\_____/      |_____|_| \_|_____|  |_|
	*/
	/*************************
	 * Timers initialization *
	 *************************/
	k_timer_init(&pump_timer, on_pump_timer_expiry, NULL);
	k_timer_init(&buzzer_timer, on_buzzer_timer_expiry, NULL);
	k_timer_init(&ot_buzzer_timer, on_ot_buzzer_timer_expiry, NULL);
// If we want to get the temperature value periodically, start the timer. Otherwise, the ADC will be check only upon a tempereature GET request
#ifdef ADC_TIMER_ENABLED
	k_timer_init(&adc_timer, on_adc_timer_expiry, NULL);
	k_timer_start(&adc_timer, K_SECONDS(ADC_TIMER_PERIOD), K_SECONDS(ADC_TIMER_PERIOD));
#endif

	/*
	  _____ ____          _____        _____ _   _ _____ _______
	 / ____/ __ \   /\   |  __ \      |_   _| \ | |_   _|__   __|
	| |   | |  | | /  \  | |__) |       | | |  \| | | |    | |
	| |   | |  | |/ /\ \ |  ___/        | | | . ` | | |    | |
	| |___| |__| / ____ \| |           _| |_| |\  |_| |_   | |
	 \_____\____/_/    \_\_|          |_____|_| \_|_____|  |_|
	*/
	/******************************
	 * COAP Server initialization *
	 *******************************/
	LOG_INF("Start CoAP-server sample");
	ret = ot_coap_init(&on_pump_request, &on_data_request, &on_info_request);
	if (ret)
	{
		LOG_ERR("Could not initialize OpenThread CoAP");
		goto end;
	}

	/*
	  ____  _____  ______ _   _ _______ _    _ _____  ______          _____        _____ _   _ _____ _______
	 / __ \|  __ \|  ____| \ | |__   __| |  | |  __ \|  ____|   /\   |  __ \      |_   _| \ | |_   _|__   __|
	| |  | | |__) | |__  |  \| |  | |  | |__| | |__) | |__     /  \  | |  | |       | | |  \| | | |    | |
	| |  | |  ___/|  __| | . ` |  | |  |  __  |  _  /|  __|   / /\ \ | |  | |       | | | . ` | | |    | |
	| |__| | |    | |____| |\  |  | |  | |  | | | \ \| |____ / ____ \| |__| |      _| |_| |\  |_| |_   | |
	 \____/|_|    |______|_| \_|  |_|  |_|  |_|_|  \_\______/_/    \_\_____/      |_____|_| \_|_____|  |_|
	*/
	/*****************************
	 * Openthread Initialization *
	 *****************************/
	openthread_state_changed_cb_register(openthread_get_default_context(), &ot_state_chaged_cb);
	openthread_start(openthread_get_default_context());

end:
	return 0;
}
