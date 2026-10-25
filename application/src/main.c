/*
 * Yann T.
 *
 * main.c
 *
 * Startup, and the glue between the CoAP resources, the hardware modules and OpenThread.
 *
 * Modules:
 *     - coap_resources: the CoAP API ('pumpdc', 'pump', 'data', 'info', 'ping')
 *     - pump:           timed pump runs, from CoAP or the S1 button
 *     - sensors:        soil, battery and air readings, sampled periodically
 *     - buzzer:         beep patterns
 *     - status_led:     network and error states on the module's RGB LED
 *     - mcumgr_poll:    faster Thread polling while mcumgr updates the device
 *     - srp:            service registration, so Home Assistant can discover the device
 *     - watchdog:       resets the SoC if the system work queue stalls
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/openthread.h>
#include <zephyr/usb/usb_device.h>
#include <openthread/thread.h>
#include <soc.h>
#include <stdio.h>
#include <version.h>

#include "buzzer.h"
#include "coap_resources.h"
#include "mcumgr_poll.h"
#include "pump.h"
#include "sensors.h"
#include "srp.h"
#include "status_led.h"
#include "watchdog.h"

LOG_MODULE_REGISTER(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

#define FW_VERSION GIT_COMMIT_HASH
#define BOOT_JINGLE_STEP_MS 100

/* Device ID (FICR DEVICEID[0] in hex), reported in 'info' and appended to the SRP hostname */
static char device_id[9];

/* CoAP handlers (called from the OpenThread thread) */
static uint8_t on_pumpdc_get(void)
{
	return pump_get_duration();
}

static uint8_t on_pumpdc_put(uint8_t value)
{
	/* The payload is a single ASCII digit. Out-of-range values keep the current run time. */
	if ((value >= '0') && (value <= '9'))
	{
		(void)pump_set_duration(value - '0');
	}

	return pump_get_duration();
}

static bool on_pump_get(void)
{
	return pump_is_running();
}

static void on_pump_put(uint8_t command)
{
	switch (command)
	{
	case PUMP_CMD_ON:
		if (!pump_is_running())
		{
			pump_start();
		}
		break;

	case PUMP_CMD_OFF:
		if (pump_is_running())
		{
			pump_stop();
		}
		break;

	default:
		break;
	}
}

static void on_data_get(uint8_t payload[DATA_PAYLOAD_SIZE])
{
	struct sensors_data data = sensors_get();

	payload[0] = data.soil_moisture;
	payload[1] = data.battery_soc;
	payload[2] = data.air_humidity;
	payload[3] = (uint8_t)data.temperature;
}

static struct coap_info on_info_get(void)
{
	struct coap_info info = {
		.fw_version = FW_VERSION,
		.hw_version = CONFIG_HACOAP_HW_VERSION,
		.device_id = device_id,
	};

	return info;
}

static void on_ping_put(uint8_t command)
{
	if (command == PING_CMD_BUZZER)
	{
		buzzer_play(BUZZER_PING);
	}
}

static const struct coap_resources_handlers coap_handlers = {
	.pumpdc_get = on_pumpdc_get,
	.pumpdc_put = on_pumpdc_put,
	.pump_get = on_pump_get,
	.pump_put = on_pump_put,
	.data_get = on_data_get,
	.info_get = on_info_get,
	.ping_put = on_ping_put,
};

/* Called after each successful SRP registration: announce the first one. */
static void on_srp_registered(void)
{
	static bool announced;

	if (!announced)
	{
		status_led_show(STATUS_LED_OFF);
		/* Retried on the next registration if another sound is playing. */
		announced = buzzer_play(BUZZER_CONNECTED);
	}
}

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
		status_led_show(STATUS_LED_OFF);
		if (!srp_started)
		{
			/* Only once: the SRP client then runs in auto-start mode. */
			srp_started = true;
			status_led_show(STATUS_LED_SRP_PENDING);
			srp_start(ot_context->instance, device_id, on_srp_registered);
		}
		break;

	case OT_DEVICE_ROLE_DISABLED:
	case OT_DEVICE_ROLE_DETACHED:
		status_led_show(STATUS_LED_NO_NETWORK);
		break;

	default:
		status_led_show(STATUS_LED_FAULT);
		break;
	}
}

static struct openthread_state_changed_cb ot_state_changed_cb = {.state_changed_cb = on_thread_state_changed};

/* Green LED blinks with a rising three-tone beep. */
static void boot_jingle(void)
{
	static const uint32_t tones_khz[] = {2, 4, 6};

	for (size_t i = 0U; i < ARRAY_SIZE(tones_khz); i++)
	{
		status_led_boot((i % 2) == 0);
		buzzer_tone(tones_khz[i], true);
		k_sleep(K_MSEC(BOOT_JINGLE_STEP_MS));
	}
	status_led_boot(false);
	buzzer_tone(tones_khz[ARRAY_SIZE(tones_khz) - 1], false);
}

/* Initialization errors are logged (and shown on the red LED) but do not stop the boot:
 * the device must always join the network so that it stays reachable for updates. */
int main(void)
{
	uint32_t missing_sensors;
	int ret;

	k_sleep(K_MSEC(CONFIG_HACOAP_BOOT_DELAY_MS));

	/* First, so that the error indications below work. */
	ret = status_led_init();
	if (ret)
	{
		LOG_ERR("Could not initialize leds (error: %d)", ret);
	}

	if (IS_ENABLED(CONFIG_USB_DEVICE_STACK))
	{
		ret = usb_enable(NULL);
		/* -EALREADY: USB was already enabled at boot (CONFIG_USB_DEVICE_INITIALIZE_AT_BOOT=y) */
		if ((ret != 0) && (ret != -EALREADY))
		{
			LOG_ERR("Could not enable USB (error: %d)", ret);
			status_led_error();
		}
	}

	ret = pump_init();
	if (ret)
	{
		LOG_ERR("Could not configure the pump or the user button (error: %d)", ret);
		status_led_error();
	}

	ret = watchdog_init();
	if (ret)
	{
		LOG_ERR("Could not start the watchdog (error: %d)", ret);
	}

	/* Missing sensors read 0. HDC1080: 2 red blinks, fuel gauge: 3, soil sensor: red on. */
	missing_sensors = sensors_init();
	if (missing_sensors & SENSOR_AIR)
	{
		status_led_error_blink(2);
	}
	if (missing_sensors & SENSOR_FUEL_GAUGE)
	{
		status_led_error_blink(3);
	}
	if (missing_sensors & SENSOR_SOIL)
	{
		status_led_error();
	}

	snprintf(device_id, sizeof(device_id), "%x", (unsigned int)NRF_FICR->DEVICEID[0]);
	sensors_start();
	mcumgr_poll_init();

	LOG_INF("Start CoAP-server sample");
	ret = coap_resources_init(&coap_handlers);
	if (ret)
	{
		LOG_ERR("Could not initialize OpenThread CoAP (error: %d)", ret);
		status_led_error();
	}

	LOG_INF("Initialization done. Starting OpenThread...");
	boot_jingle();

	ret = openthread_state_changed_cb_register(openthread_get_default_context(), &ot_state_changed_cb);
	if (ret)
	{
		LOG_ERR("Could not register OpenThread callback");
		status_led_error();
	}
	ret = openthread_start(openthread_get_default_context());
	if (ret)
	{
		LOG_ERR("Could not start OpenThread");
		status_led_error();
	}

	return 0;
}
