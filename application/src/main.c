/*
 * Yann T.
 *
 * main.c
 *
 * Startup, and the glue between the CoAP resources, the hardware modules and OpenThread.
 *
 * Modules:
 *     - coap_resources: the CoAP API ('pumpdc', 'pump', 'data', 'info', 'ping', 'diag', 'log', 'hist')
 *     - pump:           timed pump runs, from CoAP or the S1 button
 *     - sensors:        soil, battery and air readings, sampled periodically
 *     - buzzer:         beep patterns
 *     - status_led:     network and error states on the module's RGB LED
 *     - mcumgr_poll:    faster Thread polling while mcumgr updates the device or the log is read, or on USB
 *     - power:          whether the board is on USB power, and charging
 *     - log_buffer:     the latest log output, for 'log' (with remote_log, CONFIG_HACOAP_REMOTE_LOG)
 *     - joining:        joins the Thread network again until it has one, and forgets it on request
 *     - device_settings: the settings that can change without a new firmware, in flash
 *     - hacoap_mgmt:    the 'hacoap' mcumgr group, to read and write them
 *     - diag:           restart and crash records, and the link to the parent, for 'diag'
 *     - history:        the latest samples, for 'hist', and which ones to push to the fleet manager
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
#include "device_settings.h"
#include "diag.h"
#include "hacoap_mgmt.h"
#include "history.h"
#include "joining.h"
#include "log_buffer.h"
#include "mcumgr_poll.h"
#include "power.h"
#include "pump.h"
#include "sensors.h"
#include "srp.h"
#include "status_led.h"
#include "watchdog.h"

LOG_MODULE_REGISTER(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

#define FW_VERSION GIT_COMMIT_HASH
#define BOOT_JINGLE_STEP_MS 100
#define FORGET_HOLD_MS 3000          // S1 held this long at boot forgets the network
#define FORGET_RELEASE_WAIT_MS 10000 // then how long to wait for it to be released
#define FORGET_POLL_MS 100

/* Device ID (FICR DEVICEID[0] in hex), reported in 'info' and appended to the SRP hostname */
static char device_id[9];

/* Set once the sensors sample periodically */
static bool sampling;

/* Set once the CoAP API is up: samples can be pushed */
static bool coap_ready;

/* Applies a setting: at boot (when it differs from its default), and after each change */
static void on_setting_changed(enum device_setting id, int32_t value)
{
	switch (id)
	{
	case SETTING_SAMPLE_S:
		if (sampling)
		{
			sensors_reschedule();
		}
		break;

	case SETTING_PUMP_S:
		(void)pump_set_duration((uint8_t)value);
		break;

	case SETTING_POLL_MS:
		mcumgr_poll_set_normal_period((uint32_t)value);
		break;

	default:
		break; // the soil calibration is read at each sample
	}
}

/* CoAP handlers (called from the OpenThread thread) */
static uint8_t on_pumpdc_get(void)
{
	return pump_get_duration();
}

static uint8_t on_pumpdc_put(uint8_t value)
{
	/* The payload is a single ASCII digit. Out-of-range values keep the current run time.
	 * The run time is a setting, so it's kept across resets. */
	static const enum device_setting pump_s = SETTING_PUMP_S;
	int32_t seconds = value - '0';

	if ((value >= '0') && (value <= '9'))
	{
		(void)device_settings_set(&pump_s, &seconds, 1);
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

static size_t on_diag_get(char *payload, size_t size)
{
	struct diag_link link;

	diag_link_read(openthread_get_default_instance(), &link);
	return diag_format(payload, size, &link, srp_state(openthread_get_default_instance()), sensors_get().soil_mv,
			   power_name(power_source()), pump_button_seconds());
}

static size_t on_hist_get(uint32_t from, uint8_t *payload, size_t size, uint32_t *next)
{
	return history_read(from, device_settings_boots(), (uint32_t)(k_uptime_get() / MSEC_PER_SEC), payload, size, next);
}

/* After each sample (system work queue): kept for 'hist', and pushed to the fleet manager (when it
 * observes 'hist') if it changed enough since the last one it was given. */
static void on_sampled(const struct sensors_data *data)
{
	struct history_entry sample = {
		.uptime_s = (uint32_t)(k_uptime_get() / MSEC_PER_SEC),
		.soil = data->soil_moisture,
		.battery = data->battery_soc,
		.air = data->air_humidity,
		.temperature = data->temperature,
		.power = (uint8_t)power_source(),
	};
	struct openthread_context *context = openthread_get_default_context();
	struct history_entry given;
	uint32_t next;
	int err;

	history_add(&sample);
	if (!IS_ENABLED(CONFIG_HACOAP_PUSH) || !coap_ready || (context == NULL))
	{
		return;
	}
	openthread_api_mutex_lock(context);
	/* The last sample it was given: one that's gone (or none yet) counts as a change */
	if (coap_resources_observed(&next) && (!history_get(next - 1U, &given) || history_push_wanted(&given, &sample)))
	{
		err = coap_resources_notify();
		if (err != 0)
		{
			LOG_WRN("Could not push the sample (%d)", err);
		}
	}
	openthread_api_mutex_unlock(context);
}

/* On USB power, poll fast: commands arrive quickly, and battery life doesn't matter. A sample
 * now records the change (and pushes it to the fleet manager). */
static void on_power_changed(enum power_source source)
{
	mcumgr_poll_set_usb_power(power_on_usb(source));
	if (sampling)
	{
		sensors_sample_now();
	}
}

#ifdef CONFIG_HACOAP_REMOTE_LOG
static size_t on_log_get(uint32_t from, char *payload, size_t size)
{
	/* Someone is reading the log: poll fast for their next request, as during an update. */
	mcumgr_poll_hold();
	return log_buffer_read(from, payload, size);
}
#endif

static const struct coap_resources_handlers coap_handlers = {
	.pumpdc_get = on_pumpdc_get,
	.pumpdc_put = on_pumpdc_put,
	.pump_get = on_pump_get,
	.pump_put = on_pump_put,
	.data_get = on_data_get,
	.info_get = on_info_get,
	.ping_put = on_ping_put,
	.diag_get = on_diag_get,
#ifdef CONFIG_HACOAP_REMOTE_LOG
	.log_get = on_log_get,
#endif
	.hist_get = on_hist_get,
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

/* S1 held at boot, until two long low beeps (FORGET_HOLD_MS after the board starts): forgets
 * the Thread network, so that the board joins another one. Then resets. */
static void forget_network_if_held(void)
{
	int ms;

	if (!pump_button_pressed())
	{
		return;
	}
	for (ms = 0; ms < FORGET_HOLD_MS; ms += FORGET_POLL_MS)
	{
		k_sleep(K_MSEC(FORGET_POLL_MS));
		if (!pump_button_pressed())
		{
			return; // a short press: nothing to do
		}
	}

	LOG_WRN("S1 held at boot: forgetting the Thread network");
	buzzer_play(BUZZER_FORGET);
	/* Wait for the release, so that the next boot doesn't forget again (and the beeps end). */
	for (ms = 0; (ms < FORGET_RELEASE_WAIT_MS) && pump_button_pressed(); ms += FORGET_POLL_MS)
	{
		k_sleep(K_MSEC(FORGET_POLL_MS));
	}
	joining_forget(0);
	k_sleep(K_SECONDS(5)); // the reset comes from the work queue
}

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

#ifdef CONFIG_HACOAP_BOOT_PROBE
/* Diagnostic builds only (see HACOAP_BOOT_PROBE): how far the boot got, in two settings that
 * the previous firmware reports after the bootloader reverts this image. */
static void probe(int stage)
{
	static const enum device_setting ids[] = {SETTING_SAMPLE_S, SETTING_SOIL_WET_MV};
	int32_t values[] = {
		stage * 1000 + (int32_t)MIN(k_uptime_get() / MSEC_PER_SEC, 999),
		1 + (watchdog_was_running_at_boot() ? 10 : 0) + ((stage >= 4) ? 100 * (1 + (int32_t)diag_reset_cause()) : 0),
	};

	(void)device_settings_set(ids, values, ARRAY_SIZE(ids));
}
#else
static inline void probe(int stage)
{
	ARG_UNUSED(stage);
}
#endif

/* Initialization errors are logged (and shown on the red LED) but do not stop the boot:
 * the device must always join the network so that it stays reachable for updates. */
int main(void)
{
	uint32_t missing_sensors;
	int ret;

	if (IS_ENABLED(CONFIG_HACOAP_BOOT_PROBE))
	{
		(void)device_settings_init(on_setting_changed); // for probe(), before anything else
		probe(1);
	}

	/* Before the boot delay: after an update, the watchdog may still be running from the previous
	 * image (see watchdog.c), and this one isn't confirmed until it answers the fleet manager. */
	ret = watchdog_init();
	if (ret)
	{
		LOG_ERR("Could not start the watchdog (error: %d)", ret);
	}
	probe(2);

	k_sleep(K_MSEC(CONFIG_HACOAP_BOOT_DELAY_MS));
	probe(3);

	/* First, so that the error indications below work. */
	ret = status_led_init();
	if (ret)
	{
		LOG_ERR("Could not initialize leds (error: %d)", ret);
	}

	/* Before the modules that use the settings. A failure leaves the defaults in use. */
	if (!IS_ENABLED(CONFIG_HACOAP_BOOT_PROBE))
	{
		(void)device_settings_init(on_setting_changed);
	}
	diag_init();
	probe(4);

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
	probe(5);

	ret = pump_init();
	if (ret)
	{
		LOG_ERR("Could not configure the pump or the user button (error: %d)", ret);
		status_led_error();
	}
	else
	{
		forget_network_if_held();
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
	probe(6);

	snprintf(device_id, sizeof(device_id), "%x", (unsigned int)NRF_FICR->DEVICEID[0]);
	sensors_set_sampled_cb(on_sampled);
	sensors_start();
	sampling = true;
	mcumgr_poll_init();
	(void)power_init(on_power_changed); // a failure only loses the charge state: it says so
	hacoap_mgmt_init();

	LOG_INF("Start CoAP-server sample");
	ret = coap_resources_init(&coap_handlers);
	if (ret)
	{
		LOG_ERR("Could not initialize OpenThread CoAP (error: %d)", ret);
		status_led_error();
	}
	coap_ready = (ret == 0);
	probe(7);

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
	joining_start();
	probe(8);

	for (int stage = 9; IS_ENABLED(CONFIG_HACOAP_BOOT_PROBE) && (stage <= 20); stage++)
	{
		k_sleep(K_SECONDS(5));
		probe(stage);
	}

	return 0;
}
