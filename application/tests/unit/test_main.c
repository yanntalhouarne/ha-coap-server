/*
 * test_main.c
 *
 * Startup, and the glue between the CoAP API, the modules and OpenThread (src/main.c).
 */

#include "test.h"

/* main.c's main() becomes firmware_main(), so this file can have its own. */
#define main firmware_main
#include "../../src/main.c"
#undef main

/* The samples' history is the real one: which samples are pushed depends on it */
#include "../../src/history.c"

/* ---------------------------------------------------------------- fake modules */

static struct
{
	int led_inits;
	enum status_led_state led_state;
	int led_shows;
	int led_errors;
	int led_error_blinks[4]; // calls per blink count
	bool pump_running;
	uint8_t pump_duration;
	int pump_set_durations;
	uint8_t pump_set_duration_arg;
	int pump_starts;
	int pump_stops;
	uint32_t missing_sensors;
	struct sensors_data sensors;
	int sounds[4];        // plays per enum buzzer_sound
	int64_t s1_released_at; // S1 reads pressed until then (uptime, ms); 0: never pressed
	int joining_starts;
	int forgets;
	int forget_delay_ms;
	bool buzzer_busy;     // buzzer_play() fails
	int srp_starts;
	const char *srp_device_id;
	srp_registered_cb_t srp_registered;
	int mcumgr_poll_inits;
	uint32_t normal_poll_ms;
	int power_inits;
	int watchdog_init_call;
	int64_t slept_before_watchdog_ms;
	power_changed_cb_t power_changed;
	enum power_source power;
	int usb_power_sets;
	bool usb_power;
	int hacoap_mgmt_inits;
	int reschedules;
	device_settings_changed_cb settings_changed;
	int settings_init_call;
	int diag_inits;
	const struct coap_resources_handlers *coap;
	sensors_sampled_cb_t sampled;
	int samples_now;
	uint32_t button_s;
	uint32_t diag_button_s;
	bool observed;        // someone observes 'hist'...
	uint32_t observed_next; // ...and has every sample before this one
	int notifies;
	int calls;            // order of the init calls
	int led_init_call;
	int coap_init_call;
} fake_mod;

int status_led_init(void)
{
	fake_mod.led_inits++;
	fake_mod.led_init_call = ++fake_mod.calls;
	return 0;
}

void status_led_show(enum status_led_state state)
{
	fake_mod.led_state = state;
	fake_mod.led_shows++;
}

void status_led_error(void)
{
	fake_mod.led_errors++;
}

void status_led_error_blink(int count)
{
	fake_mod.led_error_blinks[count]++;
}

void status_led_boot(bool on)
{
	(void)on;
}

void status_led_user(bool on)
{
	(void)on;
}

int pump_init(void)
{
	++fake_mod.calls;
	return 0;
}

void pump_start(void)
{
	fake_mod.pump_starts++;
	fake_mod.pump_running = true;
}

void pump_stop(void)
{
	fake_mod.pump_stops++;
	fake_mod.pump_running = false;
}

bool pump_is_running(void)
{
	return fake_mod.pump_running;
}

uint8_t pump_get_duration(void)
{
	return fake_mod.pump_duration;
}

bool pump_set_duration(uint8_t seconds)
{
	fake_mod.pump_set_durations++;
	fake_mod.pump_set_duration_arg = seconds;
	if ((seconds < 1) || (seconds > CONFIG_HACOAP_PUMP_MAX_DURATION))
	{
		return false;
	}
	fake_mod.pump_duration = seconds;
	return true;
}

uint32_t sensors_init(void)
{
	++fake_mod.calls;
	return fake_mod.missing_sensors;
}

void sensors_start(void)
{
}

void sensors_set_sampled_cb(sensors_sampled_cb_t cb)
{
	fake_mod.sampled = cb;
}

void sensors_sample_now(void)
{
	fake_mod.samples_now++;
}

uint32_t pump_button_seconds(void)
{
	return fake_mod.button_s;
}

uint32_t device_settings_boots(void)
{
	return 7;
}

bool coap_resources_observed(uint32_t *next)
{
	if (fake_mod.observed)
	{
		*next = fake_mod.observed_next;
	}
	return fake_mod.observed;
}

int coap_resources_notify(void)
{
	CHECK_EQ(fake_ot_api_lock_depth, 1); // with OpenThread's lock held
	fake_mod.notifies++;
	fake_mod.observed_next = history_next(); // it was given them all
	return 0;
}

struct sensors_data sensors_get(void)
{
	return fake_mod.sensors;
}

bool buzzer_play(enum buzzer_sound sound)
{
	if (fake_mod.buzzer_busy)
	{
		return false;
	}
	fake_mod.sounds[sound]++;
	return true;
}

void buzzer_tone(uint32_t frequency_khz, bool on)
{
	(void)frequency_khz;
	(void)on;
}

void srp_start(otInstance *instance, const char *device_id, srp_registered_cb_t on_registered)
{
	(void)instance;
	fake_mod.srp_starts++;
	fake_mod.srp_device_id = device_id;
	fake_mod.srp_registered = on_registered;
}

int watchdog_init(void)
{
	fake_mod.watchdog_init_call = ++fake_mod.calls;
	fake_mod.slept_before_watchdog_ms = fake_slept_ms;
	return 0;
}

void mcumgr_poll_init(void)
{
	fake_mod.mcumgr_poll_inits++;
}

bool pump_button_pressed(void)
{
	return fake_uptime_ms < fake_mod.s1_released_at;
}

void joining_start(void)
{
	fake_mod.joining_starts++;
}

void joining_forget(int delay_ms)
{
	fake_mod.forgets++;
	fake_mod.forget_delay_ms = delay_ms;
}

void mcumgr_poll_set_normal_period(uint32_t period_ms)
{
	fake_mod.normal_poll_ms = period_ms;
}

void hacoap_mgmt_init(void)
{
	fake_mod.hacoap_mgmt_inits++;
}

void sensors_reschedule(void)
{
	fake_mod.reschedules++;
}

int device_settings_init(device_settings_changed_cb changed)
{
	fake_mod.settings_changed = changed;
	fake_mod.settings_init_call = ++fake_mod.calls;
	return 0;
}

/* Like the real one for the pump run time: checks the range, then applies it */
int device_settings_set(const enum device_setting *ids, const int32_t *values, size_t count)
{
	for (size_t i = 0U; i < count; i++)
	{
		if ((ids[i] == SETTING_PUMP_S) && ((values[i] < 1) || (values[i] > CONFIG_HACOAP_PUMP_MAX_DURATION)))
		{
			return -EINVAL;
		}
	}
	for (size_t i = 0U; i < count; i++)
	{
		on_setting_changed(ids[i], values[i]);
	}
	return 0;
}

void diag_init(void)
{
	fake_mod.diag_inits++;
}

void diag_link_read(otInstance *instance, struct diag_link *link)
{
	(void)instance;
	*link = (struct diag_link){.role = "child", .attached = true, .rloc16 = 0x5c01};
}

size_t diag_format(char *payload, size_t size, const struct diag_link *link, const char *srp, int32_t soil_mv,
		   const char *power, uint32_t button_s)
{
	fake_mod.diag_button_s = button_s;
	return (size_t)snprintf(payload, size, "srp=%s,rloc=%04x,soil_mv=%d,power=%s", srp, link->rloc16, (int)soil_mv, power);
}

void mcumgr_poll_set_usb_power(bool powered)
{
	fake_mod.usb_power_sets++;
	fake_mod.usb_power = powered;
}

int power_init(power_changed_cb_t on_changed)
{
	fake_mod.power_inits++;
	fake_mod.power_changed = on_changed;
	return 0;
}

enum power_source power_source(void)
{
	return fake_mod.power;
}

const char *power_name(enum power_source source)
{
	return (source == POWER_CHARGING) ? "charging" : "battery";
}

const char *srp_state(otInstance *instance)
{
	(void)instance;
	return "registered";
}

int coap_resources_init(const struct coap_resources_handlers *handlers)
{
	fake_mod.coap = handlers;
	fake_mod.coap_init_call = ++fake_mod.calls;
	return 0;
}

/* ---------------------------------------------------------------- helpers */

static void reset_module(void)
{
	memset(&fake_mod, 0, sizeof(fake_mod));
	memset(ring, 0, sizeof(ring));
	added = 0U;
	fake_mod.pump_duration = CONFIG_HACOAP_PUMP_DEFAULT_DURATION;
	fake_mod.led_state = STATUS_LED_OFF;
}

static void role_changes_to(otDeviceRole role)
{
	fake_device_role = role;
	fake_ot_state_cb->state_changed_cb(OT_CHANGED_THREAD_ROLE, &fake_ot_context, NULL);
}

/* ---------------------------------------------------------------- tests */

static void test_boot_reaches_openthread(void)
{
	reset_module();
	fake_ficr.DEVICEID[0] = 0x1a2b3c4d;
	CHECK_EQ(firmware_main(), 0);

	/* The watchdog first, before the boot delay: after an update it may still be running */
	CHECK_EQ(fake_mod.watchdog_init_call, 1);
	CHECK_EQ(fake_mod.slept_before_watchdog_ms, 0);
	CHECK_EQ(fake_mod.led_init_call, 2); // then the LEDs, so that error indications work
	CHECK_EQ(fake_mod.settings_init_call, 3); // before the modules that use the settings
	CHECK_EQ(fake_mod.diag_inits, 1);
	CHECK(fake_mod.coap == &coap_handlers);
	CHECK_EQ(fake_mod.mcumgr_poll_inits, 1);
	CHECK_EQ(fake_mod.hacoap_mgmt_inits, 1);
	CHECK_EQ(fake_mod.joining_starts, 1); // after OpenThread started
	CHECK_EQ(fake_mod.forgets, 0);
	CHECK(fake_ot_state_cb != NULL);
	CHECK(fake_ot_started);
	CHECK_STR(device_id, "1a2b3c4d");
	CHECK_EQ(fake_mod.led_errors, 0);
}

static void test_boot_continues_with_missing_sensors(void)
{
	reset_module();
	fake_mod.missing_sensors = SENSOR_AIR | SENSOR_FUEL_GAUGE | SENSOR_SOIL;
	CHECK_EQ(firmware_main(), 0);

	CHECK_EQ(fake_mod.led_error_blinks[2], 1); // air sensor
	CHECK_EQ(fake_mod.led_error_blinks[3], 1); // fuel gauge
	CHECK_EQ(fake_mod.led_errors, 1);          // soil sensor
	CHECK(fake_ot_started);
}

static void test_usb_already_enabled_is_not_an_error(void)
{
	if (!IS_ENABLED(CONFIG_USB_DEVICE_STACK))
	{
		return;
	}
	reset_module();
	fake_usb_enable_ret = -EALREADY;
	CHECK_EQ(firmware_main(), 0);
	CHECK_EQ(fake_mod.led_errors, 0);

	reset_module();
	fake_usb_enable_ret = -EIO;
	CHECK_EQ(firmware_main(), 0);
	CHECK_EQ(fake_mod.led_errors, 1);
	CHECK(fake_ot_started);
}

static void test_pumpdc_put_takes_one_ascii_digit(void)
{
	reset_module();
	CHECK_EQ(on_pumpdc_put('5'), 5);
	CHECK_EQ(fake_mod.pump_set_duration_arg, 5);

	/* Not digits: ignored, and the run time stays */
	CHECK_EQ(on_pumpdc_put('a'), 5);
	CHECK_EQ(on_pumpdc_put(':'), 5);
	CHECK_EQ(on_pumpdc_put('/'), 5);
	CHECK_EQ(on_pumpdc_put(5), 5);
	CHECK_EQ(fake_mod.pump_set_durations, 1);

	/* '0' is a digit, but out of range for the pump: the setting refuses it */
	CHECK_EQ(on_pumpdc_put('0'), 5);
	CHECK_EQ(fake_mod.pump_set_durations, 1);
	CHECK_EQ(on_pumpdc_get(), 5);
}

static void test_s1_held_at_boot_forgets_the_network(void)
{
	reset_module();
	/* Held from power on, released 6 s later */
	fake_mod.s1_released_at = CONFIG_HACOAP_BOOT_DELAY_MS + FORGET_HOLD_MS + 3000;
	(void)firmware_main();
	CHECK_EQ(fake_mod.sounds[BUZZER_FORGET], 1);
	CHECK_EQ(fake_mod.forgets, 1);
	CHECK_EQ(fake_mod.forget_delay_ms, 0);
}

static void test_a_short_press_at_boot_forgets_nothing(void)
{
	reset_module();
	fake_mod.s1_released_at = CONFIG_HACOAP_BOOT_DELAY_MS + 1000; // let go a second after the check
	(void)firmware_main();
	CHECK_EQ(fake_mod.forgets, 0);
	CHECK_EQ(fake_mod.sounds[BUZZER_FORGET], 0);
	CHECK(fake_ot_started);
}

static void test_settings_are_applied(void)
{
	reset_module();
	(void)firmware_main();
	fake_mod.settings_changed(SETTING_PUMP_S, 7);
	CHECK_EQ(fake_mod.pump_duration, 7);
	fake_mod.settings_changed(SETTING_POLL_MS, 5000);
	CHECK_EQ(fake_mod.normal_poll_ms, 5000);
	fake_mod.settings_changed(SETTING_SAMPLE_S, 60);
	CHECK_EQ(fake_mod.reschedules, 1);
	fake_mod.settings_changed(SETTING_SOIL_DRY_MV, 2000); // read at each sample
}

static void test_a_sample_period_from_flash_waits_for_the_sensors(void)
{
	reset_module();
	sampling = false;
	on_setting_changed(SETTING_SAMPLE_S, 60); // at load, before sensors_start()
	CHECK_EQ(fake_mod.reschedules, 0);
}

static void test_diag_reports_the_link_and_the_soil_voltage(void)
{
	char payload[DIAG_PAYLOAD_MAX_SIZE];
	size_t length;

	reset_module();
	fake_mod.sensors.soil_mv = 1696;
	length = on_diag_get(payload, sizeof(payload));
	CHECK_EQ(length, 51);
	CHECK(memcmp(payload, "srp=registered,rloc=5c01,soil_mv=1696,power=battery", 51) == 0);

	fake_mod.power = POWER_CHARGING;
	length = on_diag_get(payload, sizeof(payload));
	CHECK(memcmp(payload, "srp=registered,rloc=5c01,soil_mv=1696,power=charging", length) == 0);

	fake_mod.button_s = 6;                     // the pump's runs with S1, for the water tank
	(void)on_diag_get(payload, sizeof(payload));
	CHECK_EQ(fake_mod.diag_button_s, 6);
}

/* A sample of this soil moisture, taken now */
static void sampled(uint8_t soil)
{
	struct sensors_data data = {.soil_moisture = soil, .battery_soc = 80, .air_humidity = 50, .temperature = 21};

	fake_mod.sampled(&data);
}

static void test_samples_are_kept_for_hist(void)
{
	uint8_t payload[HIST_PAYLOAD_MAX_SIZE];
	uint32_t next;
	size_t length;

	reset_module();
	CHECK_EQ(firmware_main(), 0);
	CHECK(fake_mod.sampled != NULL);           // set before the first sample
	fake_uptime_ms = 900000;
	fake_mod.power = POWER_CHARGING;
	sampled(42);
	CHECK_EQ(history_next(), 1);
	CHECK_EQ(fake_mod.notifies, 0);            // no one observes
	CHECK(fake_mod.coap->hist_get != NULL);
	length = fake_mod.coap->hist_get(0, payload, sizeof(payload), &next);
	CHECK_EQ(length, HISTORY_HEADER_SIZE + HISTORY_ENTRY_SIZE);
	CHECK_EQ(payload[4], 7);                   // this boot
	CHECK_EQ(payload[HISTORY_HEADER_SIZE + 4], 42);
	CHECK_EQ(payload[HISTORY_HEADER_SIZE + 8], POWER_CHARGING);
	CHECK_EQ(next, 1);
}

static void test_samples_that_changed_are_pushed(void)
{
	reset_module();
	CHECK_EQ(firmware_main(), 0);
	sampled(40);
	fake_mod.observed = true;                  // the fleet manager registered, and has sample 0
	fake_mod.observed_next = 1;
	sampled(38);                               // 2 % drier than what it has: not worth a message
	CHECK_EQ(fake_mod.notifies, 0);
	sampled(40 - CONFIG_HACOAP_PUSH_SOIL_DELTA);
	CHECK_EQ(fake_mod.notifies, 1);            // pushed (samples 1 and 2)
	CHECK_EQ(fake_ot_api_lock_depth, 0);
	sampled(40 - CONFIG_HACOAP_PUSH_SOIL_DELTA);
	CHECK_EQ(fake_mod.notifies, 1);            // the same as the last one given
	fake_mod.power = POWER_USB;                // plugged in
	sampled(40 - CONFIG_HACOAP_PUSH_SOIL_DELTA);
	CHECK_EQ(fake_mod.notifies, 2);
	/* Registered before any sample it was given (or the last one given is gone): pushed */
	fake_mod.observed_next = 0;
	sampled(10);
	CHECK_EQ(fake_mod.notifies, 3);
}

static void test_a_power_change_takes_a_sample(void)
{
	reset_module();
	CHECK_EQ(firmware_main(), 0);
	fake_mod.power_changed(POWER_CHARGING);
	CHECK_EQ(fake_mod.samples_now, 1);         // the change is in the history, and pushed
}

static void test_usb_power_polls_faster(void)
{
	reset_module();
	CHECK_EQ(firmware_main(), 0);
	CHECK_EQ(fake_mod.power_inits, 1);
	fake_mod.power_changed(POWER_CHARGING);
	CHECK_EQ(fake_mod.usb_power_sets, 1);
	CHECK(fake_mod.usb_power);
	fake_mod.power_changed(POWER_BATTERY);
	CHECK(!fake_mod.usb_power);
}

static void test_pump_put_only_acts_on_a_change(void)
{
	reset_module();
	on_pump_put(PUMP_CMD_ON);
	on_pump_put(PUMP_CMD_ON); // already running: not restarted
	CHECK_EQ(fake_mod.pump_starts, 1);
	CHECK(on_pump_get());

	on_pump_put(PUMP_CMD_OFF);
	on_pump_put(PUMP_CMD_OFF);
	CHECK_EQ(fake_mod.pump_stops, 1);
	CHECK(!on_pump_get());

	on_pump_put('x');
	CHECK_EQ(fake_mod.pump_starts, 1);
	CHECK_EQ(fake_mod.pump_stops, 1);
}

static void test_data_sends_the_temperature_as_a_signed_byte(void)
{
	uint8_t payload[DATA_PAYLOAD_SIZE];

	reset_module();
	fake_mod.sensors = (struct sensors_data){.soil_moisture = 42, .battery_soc = 87, .air_humidity = 55, .temperature = -5};
	on_data_get(payload);
	CHECK_EQ(payload[0], 42);
	CHECK_EQ(payload[1], 87);
	CHECK_EQ(payload[2], 55);
	CHECK_EQ(payload[3], 251); // -5 as int8_t, which the integration decodes
}

static void test_info_reports_versions_and_device_id(void)
{
	struct coap_info info;

	reset_module();
	fake_ficr.DEVICEID[0] = 0xdeadbeef;
	(void)firmware_main();
	info = on_info_get();
	CHECK_STR(info.fw_version, GIT_COMMIT_HASH);
	CHECK_STR(info.hw_version, CONFIG_HACOAP_HW_VERSION);
	CHECK_STR(info.device_id, "deadbeef");
}

static void test_ping_beeps_only_on_1(void)
{
	reset_module();
	on_ping_put(PING_CMD_QUIET);
	CHECK_EQ(fake_mod.sounds[BUZZER_PING], 0);
	on_ping_put(PING_CMD_BUZZER);
	CHECK_EQ(fake_mod.sounds[BUZZER_PING], 1);
}

/* One test, in order: srp_start() and the first-registration sound happen once per boot. */
static void test_thread_states_and_srp(void)
{
	reset_module();
	fake_ficr.DEVICEID[0] = 0x1a2b3c4d;
	(void)firmware_main();

	role_changes_to(OT_DEVICE_ROLE_DETACHED);
	CHECK_EQ(fake_mod.led_state, STATUS_LED_NO_NETWORK);

	/* Other changes are ignored. */
	fake_mod.led_shows = 0;
	fake_device_role = OT_DEVICE_ROLE_CHILD;
	fake_ot_state_cb->state_changed_cb(BIT(0), &fake_ot_context, NULL);
	CHECK_EQ(fake_mod.led_shows, 0);

	/* Attached: SRP starts, with the device ID */
	role_changes_to(OT_DEVICE_ROLE_CHILD);
	CHECK_EQ(fake_mod.led_state, STATUS_LED_SRP_PENDING);
	CHECK_EQ(fake_mod.srp_starts, 1);
	CHECK_STR(fake_mod.srp_device_id, "1a2b3c4d");

	/* First registration, while another sound plays: retried at the next one */
	fake_mod.buzzer_busy = true;
	fake_mod.srp_registered();
	CHECK_EQ(fake_mod.led_state, STATUS_LED_OFF);
	CHECK_EQ(fake_mod.sounds[BUZZER_CONNECTED], 0);
	fake_mod.buzzer_busy = false;
	fake_mod.srp_registered();
	CHECK_EQ(fake_mod.sounds[BUZZER_CONNECTED], 1);
	fake_mod.srp_registered();
	CHECK_EQ(fake_mod.sounds[BUZZER_CONNECTED], 1); // only the first time

	/* Detached and back: SRP keeps running on its own, so it isn't started again */
	role_changes_to(OT_DEVICE_ROLE_DETACHED);
	CHECK_EQ(fake_mod.led_state, STATUS_LED_NO_NETWORK);
	role_changes_to(OT_DEVICE_ROLE_ROUTER);
	CHECK_EQ(fake_mod.led_state, STATUS_LED_OFF);
	CHECK_EQ(fake_mod.srp_starts, 1);

	role_changes_to(OT_DEVICE_ROLE_DISABLED);
	CHECK_EQ(fake_mod.led_state, STATUS_LED_NO_NETWORK);
	role_changes_to(OT_DEVICE_ROLE_LEADER);
	CHECK_EQ(fake_mod.led_state, STATUS_LED_OFF);
}

int main(void)
{
	RUN_TEST(test_boot_reaches_openthread);
	RUN_TEST(test_boot_continues_with_missing_sensors);
	RUN_TEST(test_usb_already_enabled_is_not_an_error);
	RUN_TEST(test_pumpdc_put_takes_one_ascii_digit);
	RUN_TEST(test_s1_held_at_boot_forgets_the_network);
	RUN_TEST(test_a_short_press_at_boot_forgets_nothing);
	RUN_TEST(test_settings_are_applied);
	RUN_TEST(test_a_sample_period_from_flash_waits_for_the_sensors);
	RUN_TEST(test_diag_reports_the_link_and_the_soil_voltage);
	RUN_TEST(test_samples_are_kept_for_hist);
	RUN_TEST(test_samples_that_changed_are_pushed);
	RUN_TEST(test_a_power_change_takes_a_sample);
	RUN_TEST(test_usb_power_polls_faster);
	RUN_TEST(test_pump_put_only_acts_on_a_change);
	RUN_TEST(test_data_sends_the_temperature_as_a_signed_byte);
	RUN_TEST(test_info_reports_versions_and_device_id);
	RUN_TEST(test_ping_beeps_only_on_1);
	RUN_TEST(test_thread_states_and_srp);
	return TEST_RESULT();
}
