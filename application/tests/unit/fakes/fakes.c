/*
 * fakes.c
 *
 * Fake Zephyr, OpenThread, mcumgr and nRF functions (see fake.h).
 */

#include "fake.h"

#include <stdio.h>

/* ---------------------------------------------------------------- kernel */

int64_t fake_uptime_ms;
int64_t fake_slept_ms;

int64_t k_uptime_get(void)
{
	return fake_uptime_ms;
}

int32_t k_sleep(k_timeout_t timeout)
{
	fake_slept_ms += timeout.ms;
	fake_uptime_ms += timeout.ms;
	return 0;
}

void k_timer_start(struct k_timer *timer, k_timeout_t duration, k_timeout_t period)
{
	timer->running = true;
	timer->duration_ms = duration.ms;
	timer->period_ms = period.ms;
	timer->starts++;
}

void k_timer_stop(struct k_timer *timer)
{
	bool was_running = timer->running;

	timer->running = false;
	if (was_running && (timer->stop_fn != NULL))
	{
		timer->stop_fn(timer);
	}
}

void fake_timer_fire(struct k_timer *timer)
{
	if (timer->period_ms == 0)
	{
		timer->running = false;
	}
	timer->expiry_fn(timer);
}

int k_work_submit(struct k_work *work)
{
	int ret = work->pending ? 0 : 1;

	work->pending = true;
	work->submits++;
	return ret;
}

int k_work_schedule(struct k_work_delayable *dwork, k_timeout_t delay)
{
	if (dwork->scheduled)
	{
		return 0; // k_work_schedule() leaves an already scheduled item alone
	}
	dwork->scheduled = true;
	dwork->delay_ms = delay.ms;
	dwork->schedules++;
	return 1;
}

int k_work_reschedule(struct k_work_delayable *dwork, k_timeout_t delay)
{
	dwork->scheduled = true;
	dwork->delay_ms = delay.ms;
	dwork->schedules++;
	return 1;
}

void fake_work_run(struct k_work *work)
{
	work->pending = false;
	work->handler(work);
}

void fake_dwork_run(struct k_work_delayable *dwork)
{
	dwork->scheduled = false;
	dwork->work.handler(&dwork->work);
}

/* ---------------------------------------------------------------- devices */

struct device fake_gpio_dev = {.name = "gpio", .ready = true};
struct device fake_adc_dev = {.name = "adc", .ready = true};
struct device fake_hdc_dev = {.name = "hdc1080", .ready = true};
struct device fake_fuel_gauge_dev = {.name = "max17048", .ready = true};

/* ---------------------------------------------------------------- GPIO */

int fake_gpio_value[FAKE_PIN_COUNT];
int fake_gpio_input[FAKE_PIN_COUNT];
gpio_flags_t fake_gpio_flags[FAKE_PIN_COUNT];
gpio_flags_t fake_gpio_int_flags[FAKE_PIN_COUNT];
struct gpio_callback *fake_gpio_callback;

int gpio_pin_configure_dt(const struct gpio_dt_spec *spec, gpio_flags_t flags)
{
	fake_gpio_flags[spec->pin] = flags;
	if (flags & GPIO_OUTPUT_INACTIVE)
	{
		fake_gpio_value[spec->pin] = 0;
	}
	return 0;
}

int gpio_pin_set_dt(const struct gpio_dt_spec *spec, int value)
{
	fake_gpio_value[spec->pin] = value;
	return 0;
}

int gpio_pin_get_dt(const struct gpio_dt_spec *spec)
{
	return fake_gpio_input[spec->pin];
}

int gpio_pin_interrupt_configure_dt(const struct gpio_dt_spec *spec, gpio_flags_t flags)
{
	fake_gpio_int_flags[spec->pin] = flags;
	return 0;
}

void gpio_init_callback(struct gpio_callback *callback, gpio_callback_handler_t handler, uint32_t pin_mask)
{
	callback->handler = handler;
	callback->pin_mask = pin_mask;
}

int gpio_add_callback(const struct device *port, struct gpio_callback *callback)
{
	(void)port;
	fake_gpio_callback = callback;
	return 0;
}

/* ---------------------------------------------------------------- ADC */

int16_t fake_adc_raw;
int fake_adc_read_err;
int fake_adc_reads;
int fake_adc_power_at_read;

int adc_channel_setup_dt(const struct adc_dt_spec *spec)
{
	(void)spec;
	return 0;
}

int adc_sequence_init_dt(const struct adc_dt_spec *spec, struct adc_sequence *seq)
{
	(void)spec;
	(void)seq;
	return 0;
}

int adc_read(const struct device *dev, const struct adc_sequence *sequence)
{
	(void)dev;
	fake_adc_reads++;
	fake_adc_power_at_read = fake_gpio_value[FAKE_PIN_sensor_en];
	if (fake_adc_read_err != 0)
	{
		return fake_adc_read_err;
	}
	memcpy(sequence->buffer, &fake_adc_raw, sizeof(fake_adc_raw));
	return 0;
}

int adc_raw_to_millivolts_dt(const struct adc_dt_spec *spec, int32_t *valp)
{
	(void)spec;
	(void)valp;
	return 0;
}

/* ---------------------------------------------------------------- sensors */

struct sensor_value fake_temperature;
struct sensor_value fake_humidity;
int fake_sensor_err;

int sensor_sample_fetch(const struct device *dev)
{
	(void)dev;
	return fake_sensor_err;
}

int sensor_channel_get(const struct device *dev, enum sensor_channel chan, struct sensor_value *val)
{
	(void)dev;
	*val = (chan == SENSOR_CHAN_AMBIENT_TEMP) ? fake_temperature : fake_humidity;
	return 0;
}

/* ---------------------------------------------------------------- fuel gauge */

uint8_t fake_battery_soc;
int fake_fuel_gauge_err;

int fuel_gauge_get_prop(const struct device *dev, struct fuel_gauge_get_property *props, size_t props_len)
{
	(void)dev;
	if (fake_fuel_gauge_err != 0)
	{
		return fake_fuel_gauge_err;
	}
	for (size_t i = 0; i < props_len; i++)
	{
		props[i].status = 0;
		if (props[i].property_type == FUEL_GAUGE_STATE_OF_CHARGE)
		{
			props[i].value.state_of_charge = fake_battery_soc;
		}
	}
	return 0;
}

/* ---------------------------------------------------------------- OpenThread CoAP */

otInstance fake_ot_instance;
otCoapResource *fake_coap_resources[FAKE_MAX_RESOURCES];
int fake_coap_resource_count;
otCoapRequestHandler fake_coap_default_handler;
uint16_t fake_coap_port;
otError fake_coap_start_error;
bool fake_coap_no_bufs;
otMessage fake_response;
otMessageInfo fake_response_info;
int fake_responses_sent;
int fake_messages_allocated;
int fake_messages_freed;

static otMessage message_pool[4];
static int message_pool_next;

otCoapType otCoapMessageGetType(const otMessage *message)
{
	return message->type;
}

otCoapCode otCoapMessageGetCode(const otMessage *message)
{
	return message->code;
}

otMessage *otCoapNewMessage(otInstance *instance, const otMessageSettings *settings)
{
	otMessage *message;

	(void)instance;
	(void)settings;
	if (fake_coap_no_bufs)
	{
		return NULL;
	}
	message = &message_pool[message_pool_next];
	message_pool_next = (message_pool_next + 1) % (int)ARRAY_SIZE(message_pool);
	memset(message, 0, sizeof(*message));
	fake_messages_allocated++;
	return message;
}

otError otCoapMessageInitResponse(otMessage *response, const otMessage *request, otCoapType type, otCoapCode code)
{
	(void)request;
	response->type = type;
	response->code = code;
	response->initialized = true;
	return OT_ERROR_NONE;
}

otError otCoapMessageSetPayloadMarker(otMessage *message)
{
	message->payload_marker = true;
	return OT_ERROR_NONE;
}

otError otMessageAppend(otMessage *message, const void *buf, uint16_t length)
{
	if (message->length + length > FAKE_MESSAGE_SIZE)
	{
		return OT_ERROR_NO_BUFS;
	}
	memcpy(&message->bytes[message->length], buf, length);
	message->length += length;
	return OT_ERROR_NONE;
}

otError otCoapSendResponse(otInstance *instance, otMessage *message, const otMessageInfo *message_info)
{
	(void)instance;
	fake_response = *message;
	fake_response_info = *message_info;
	fake_responses_sent++;
	return OT_ERROR_NONE;
}

void otMessageFree(otMessage *message)
{
	message->freed = true;
	fake_messages_freed++;
}

uint16_t otMessageGetOffset(const otMessage *message)
{
	(void)message;
	return 0;
}

uint16_t otMessageRead(const otMessage *message, uint16_t offset, void *buf, uint16_t length)
{
	uint16_t available = (offset < message->length) ? (uint16_t)(message->length - offset) : 0;
	uint16_t count = MIN(length, available);

	memcpy(buf, &message->bytes[offset], count);
	return count;
}

/* The fake message only has Uri-Query options. */
otError otCoapOptionIteratorInit(otCoapOptionIterator *iterator, const otMessage *message)
{
	memset(iterator, 0, sizeof(*iterator));
	iterator->mMessage = message;
	return OT_ERROR_NONE;
}

const otCoapOption *otCoapOptionIteratorGetNextOptionMatching(otCoapOptionIterator *iterator, uint16_t option)
{
	if ((option != OT_COAP_OPTION_URI_QUERY) || (iterator->mNextOptionOffset >= iterator->mMessage->query_count))
	{
		return NULL;
	}
	iterator->mOption.mNumber = option;
	iterator->mOption.mLength = (uint16_t)strlen(iterator->mMessage->queries[iterator->mNextOptionOffset]);
	iterator->mNextOptionOffset++;
	return &iterator->mOption;
}

const otCoapOption *otCoapOptionIteratorGetFirstOptionMatching(otCoapOptionIterator *iterator, uint16_t option)
{
	iterator->mNextOptionOffset = 0;
	return otCoapOptionIteratorGetNextOptionMatching(iterator, option);
}

otError otCoapOptionIteratorGetOptionValue(otCoapOptionIterator *iterator, void *value)
{
	if (iterator->mNextOptionOffset == 0)
	{
		return OT_ERROR_INVALID_ARGS;
	}
	memcpy(value, iterator->mMessage->queries[iterator->mNextOptionOffset - 1], iterator->mOption.mLength);
	return OT_ERROR_NONE;
}

void otCoapSetDefaultHandler(otInstance *instance, otCoapRequestHandler handler, void *context)
{
	(void)instance;
	(void)context;
	fake_coap_default_handler = handler;
}

void otCoapAddResource(otInstance *instance, otCoapResource *resource)
{
	(void)instance;
	if (fake_coap_resource_count < FAKE_MAX_RESOURCES)
	{
		fake_coap_resources[fake_coap_resource_count++] = resource;
	}
}

otError otCoapStart(otInstance *instance, uint16_t port)
{
	(void)instance;
	fake_coap_port = port;
	return fake_coap_start_error;
}

void fake_request_init(otMessage *request, otCoapType type, otCoapCode code, const char *payload)
{
	memset(request, 0, sizeof(*request));
	request->type = type;
	request->code = code;
	if (payload != NULL)
	{
		request->length = (uint16_t)strlen(payload);
		memcpy(request->bytes, payload, request->length);
	}
}

void fake_request_add_query(otMessage *request, const char *query)
{
	if (request->query_count < FAKE_MAX_QUERIES)
	{
		request->queries[request->query_count++] = query;
	}
}

/* ---------------------------------------------------------------- OpenThread link, Thread, SRP */

uint32_t fake_poll_period_ms;
int fake_poll_period_sets;

otError otLinkSetPollPeriod(otInstance *instance, uint32_t poll_period)
{
	(void)instance;
	fake_poll_period_ms = poll_period;
	fake_poll_period_sets++;
	return OT_ERROR_NONE;
}

otDeviceRole fake_device_role;

otDeviceRole otThreadGetDeviceRole(otInstance *instance)
{
	(void)instance;
	return fake_device_role;
}

const char *otThreadErrorToString(otError error)
{
	return (error == OT_ERROR_NONE) ? "OK" : "error";
}

otSrpClientCallback fake_srp_callback;
const char *fake_srp_host_name;
const otSrpClientService *fake_srp_service;
bool fake_srp_auto_host_address;
bool fake_srp_auto_start;
bool fake_srp_no_buffers;

static otSrpClientBuffersServiceEntry srp_entry;

void otSrpClientSetCallback(otInstance *instance, otSrpClientCallback callback, void *context)
{
	(void)instance;
	(void)context;
	fake_srp_callback = callback;
}

otError otSrpClientSetHostName(otInstance *instance, const char *name)
{
	(void)instance;
	fake_srp_host_name = name;
	return OT_ERROR_NONE;
}

otError otSrpClientEnableAutoHostAddress(otInstance *instance)
{
	(void)instance;
	fake_srp_auto_host_address = true;
	return OT_ERROR_NONE;
}

otSrpClientBuffersServiceEntry *otSrpClientBuffersAllocateService(otInstance *instance)
{
	(void)instance;
	if (fake_srp_no_buffers)
	{
		return NULL;
	}
	memset(&srp_entry, 0, sizeof(srp_entry));
	srp_entry.mService.mInstanceName = srp_entry.instance_name;
	srp_entry.mService.mName = srp_entry.service_name;
	return &srp_entry;
}

char *otSrpClientBuffersGetServiceEntryInstanceNameString(otSrpClientBuffersServiceEntry *entry, uint16_t *size)
{
	*size = sizeof(entry->instance_name);
	return entry->instance_name;
}

char *otSrpClientBuffersGetServiceEntryServiceNameString(otSrpClientBuffersServiceEntry *entry, uint16_t *size)
{
	*size = sizeof(entry->service_name);
	return entry->service_name;
}

otError otSrpClientAddService(otInstance *instance, otSrpClientService *service)
{
	(void)instance;
	fake_srp_service = service;
	return OT_ERROR_NONE;
}

void otSrpClientEnableAutoStartMode(otInstance *instance, void *callback, void *context)
{
	(void)instance;
	(void)callback;
	(void)context;
	fake_srp_auto_start = true;
}

/* ---------------------------------------------------------------- Zephyr's OpenThread glue */

struct openthread_context fake_ot_context = {.instance = &fake_ot_instance};
int fake_ot_api_lock_depth;
int fake_ot_api_locks;
struct openthread_state_changed_cb *fake_ot_state_cb;
bool fake_ot_started;

struct openthread_context *openthread_get_default_context(void)
{
	return &fake_ot_context;
}

otInstance *openthread_get_default_instance(void)
{
	return fake_ot_context.instance;
}

void openthread_api_mutex_lock(struct openthread_context *ot_context)
{
	(void)ot_context;
	fake_ot_api_lock_depth++;
	fake_ot_api_locks++;
}

void openthread_api_mutex_unlock(struct openthread_context *ot_context)
{
	(void)ot_context;
	fake_ot_api_lock_depth--;
}

int openthread_state_changed_cb_register(struct openthread_context *ot_context, struct openthread_state_changed_cb *cb)
{
	(void)ot_context;
	fake_ot_state_cb = cb;
	return 0;
}

int openthread_start(struct openthread_context *ot_context)
{
	(void)ot_context;
	fake_ot_started = true;
	return 0;
}

/* ---------------------------------------------------------------- mcumgr */

struct mgmt_callback *fake_mgmt_callback;

void mgmt_callback_register(struct mgmt_callback *callback)
{
	fake_mgmt_callback = callback;
}

int32_t fake_mgmt_notify(uint32_t event)
{
	bool abort_more = false;

	if ((fake_mgmt_callback == NULL) || ((fake_mgmt_callback->event_id & event) == 0))
	{
		return MGMT_ERR_EOK;
	}
	return fake_mgmt_callback->callback(event, MGMT_ERR_EOK, &abort_more, NULL, 0);
}

/* ---------------------------------------------------------------- OpenThread joiner, dataset, instance */

bool fake_commissioned;
otJoinerState fake_joiner_state;
int fake_joiner_starts;
const char *fake_joiner_pskd;
otJoinerCallback fake_joiner_callback;
void *fake_joiner_context;
otError fake_joiner_start_error;
int fake_thread_enables;
int fake_factory_resets;

bool otDatasetIsCommissioned(otInstance *instance)
{
	(void)instance;
	return fake_commissioned;
}

otJoinerState otJoinerGetState(otInstance *instance)
{
	(void)instance;
	return fake_joiner_state;
}

otError otJoinerStart(otInstance *instance, const char *pskd, const char *provisioning_url, const char *vendor_name,
		      const char *vendor_model, const char *vendor_sw_version, const char *vendor_data,
		      otJoinerCallback callback, void *context)
{
	(void)instance;
	(void)provisioning_url;
	(void)vendor_name;
	(void)vendor_model;
	(void)vendor_sw_version;
	(void)vendor_data;
	fake_joiner_starts++;
	fake_joiner_pskd = pskd;
	fake_joiner_callback = callback;
	fake_joiner_context = context;
	if (fake_joiner_start_error == OT_ERROR_NONE)
	{
		fake_joiner_state = OT_JOINER_STATE_DISCOVER;
	}
	return fake_joiner_start_error;
}

otError otThreadSetEnabled(otInstance *instance, bool enabled)
{
	(void)instance;
	if (enabled)
	{
		fake_thread_enables++;
	}
	return OT_ERROR_NONE;
}

void otInstanceFactoryReset(otInstance *instance)
{
	(void)instance;
	fake_factory_resets++;
}

/* ---------------------------------------------------------------- OpenThread parent */

uint16_t fake_rloc16;
otRouterInfo fake_parent;
int8_t fake_parent_rssi;
int8_t fake_parent_last_rssi;

uint16_t otThreadGetRloc16(otInstance *instance)
{
	(void)instance;
	return fake_rloc16;
}

otError otThreadGetParentInfo(otInstance *instance, otRouterInfo *parent)
{
	(void)instance;
	*parent = fake_parent;
	return OT_ERROR_NONE;
}

otError otThreadGetParentAverageRssi(otInstance *instance, int8_t *rssi)
{
	(void)instance;
	*rssi = fake_parent_rssi;
	return OT_ERROR_NONE;
}

otError otThreadGetParentLastRssi(otInstance *instance, int8_t *rssi)
{
	(void)instance;
	*rssi = fake_parent_last_rssi;
	return OT_ERROR_NONE;
}

/* ---------------------------------------------------------------- settings */

struct fake_setting fake_settings[FAKE_SETTINGS_MAX];
int fake_settings_count;
int fake_settings_saves;
int fake_settings_load_err;
int (*fake_settings_handler)(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg);

int settings_subsys_init(void)
{
	return 0;
}

static long read_setting(void *cb_arg, void *data, size_t len)
{
	const struct fake_setting *setting = cb_arg;
	size_t count = MIN(len, setting->length);

	memcpy(data, setting->value, count);
	return (long)count;
}

int settings_load_subtree(const char *subtree)
{
	size_t prefix = strlen(subtree);

	if (fake_settings_load_err != 0)
	{
		return fake_settings_load_err;
	}
	for (int i = 0; (i < fake_settings_count) && (fake_settings_handler != NULL); i++)
	{
		if ((strncmp(fake_settings[i].name, subtree, prefix) == 0) && (fake_settings[i].name[prefix] == '/'))
		{
			fake_settings_handler(&fake_settings[i].name[prefix + 1], fake_settings[i].length, read_setting,
					      &fake_settings[i]);
		}
	}
	return 0;
}

void fake_setting_store(const char *name, const void *value, size_t length)
{
	struct fake_setting *setting = NULL;

	for (int i = 0; i < fake_settings_count; i++)
	{
		if (strcmp(fake_settings[i].name, name) == 0)
		{
			setting = &fake_settings[i];
		}
	}
	if ((setting == NULL) && (fake_settings_count < FAKE_SETTINGS_MAX))
	{
		setting = &fake_settings[fake_settings_count++];
		snprintf(setting->name, sizeof(setting->name), "%s", name);
	}
	if (setting != NULL)
	{
		setting->length = MIN(length, (size_t)FAKE_SETTING_SIZE);
		memcpy(setting->value, value, setting->length);
	}
}

int settings_save_one(const char *name, const void *value, size_t val_len)
{
	fake_settings_saves++;
	fake_setting_store(name, value, val_len);
	return 0;
}

int32_t fake_setting_int(const char *name, int32_t missing)
{
	int32_t value = missing;

	for (int i = 0; i < fake_settings_count; i++)
	{
		if ((strcmp(fake_settings[i].name, name) == 0) && (fake_settings[i].length == sizeof(value)))
		{
			memcpy(&value, fake_settings[i].value, sizeof(value));
		}
	}
	return value;
}

/* ---------------------------------------------------------------- reset cause, reboot */

uint32_t fake_reset_cause;
int fake_reset_cause_clears;
int fake_reboots;

int hwinfo_get_reset_cause(uint32_t *cause)
{
	*cause = fake_reset_cause;
	return 0;
}

int hwinfo_clear_reset_cause(void)
{
	fake_reset_cause = 0;
	fake_reset_cause_clears++;
	return 0;
}

void sys_reboot(int type)
{
	(void)type;
	fake_reboots++;
}

/* ---------------------------------------------------------------- nRF, USB, random */

int fake_leds[FAKE_LED_COUNT];
int fake_led_changes;

int dk_leds_init(void)
{
	memset(fake_leds, 0, sizeof(fake_leds));
	return 0;
}

int dk_set_led(uint8_t led_idx, uint32_t val)
{
	fake_leds[led_idx] = (val != 0) ? 1 : 0;
	fake_led_changes++;
	return 0;
}

int dk_set_led_on(uint8_t led_idx)
{
	return dk_set_led(led_idx, 1);
}

int dk_set_led_off(uint8_t led_idx)
{
	return dk_set_led(led_idx, 0);
}

NRF_FICR_Type fake_ficr;
int fake_usb_enable_ret;

int usb_enable(void *status_cb)
{
	(void)status_cb;
	return fake_usb_enable_ret;
}

uint32_t fake_random;

uint32_t sys_rand32_get(void)
{
	return fake_random;
}

/* ---------------------------------------------------------------- reset */

void fake_reset(void)
{
	fake_uptime_ms = 0;
	fake_slept_ms = 0;

	fake_gpio_dev.ready = true;
	fake_adc_dev.ready = true;
	fake_hdc_dev.ready = true;
	fake_fuel_gauge_dev.ready = true;

	memset(fake_gpio_value, 0, sizeof(fake_gpio_value));
	memset(fake_gpio_flags, 0, sizeof(fake_gpio_flags));
	memset(fake_gpio_int_flags, 0, sizeof(fake_gpio_int_flags));
	fake_gpio_callback = NULL;

	fake_adc_raw = 0;
	fake_adc_read_err = 0;
	fake_adc_reads = 0;
	fake_adc_power_at_read = 0;
	memset(&fake_temperature, 0, sizeof(fake_temperature));
	memset(&fake_humidity, 0, sizeof(fake_humidity));
	fake_sensor_err = 0;
	fake_battery_soc = 0;
	fake_fuel_gauge_err = 0;

	memset(fake_coap_resources, 0, sizeof(fake_coap_resources));
	fake_coap_resource_count = 0;
	fake_coap_default_handler = NULL;
	fake_coap_port = 0;
	fake_coap_start_error = OT_ERROR_NONE;
	fake_coap_no_bufs = false;
	memset(&fake_response, 0, sizeof(fake_response));
	memset(&fake_response_info, 0, sizeof(fake_response_info));
	fake_responses_sent = 0;
	fake_messages_allocated = 0;
	fake_messages_freed = 0;

	fake_poll_period_ms = 0;
	fake_poll_period_sets = 0;
	fake_device_role = OT_DEVICE_ROLE_DISABLED;

	fake_srp_callback = NULL;
	fake_srp_host_name = NULL;
	fake_srp_service = NULL;
	fake_srp_auto_host_address = false;
	fake_srp_auto_start = false;
	fake_srp_no_buffers = false;

	fake_ot_api_lock_depth = 0;
	fake_ot_api_locks = 0;
	fake_ot_state_cb = NULL;
	fake_ot_started = false;

	fake_mgmt_callback = NULL;

	memset(fake_leds, 0, sizeof(fake_leds));
	fake_led_changes = 0;
	memset(&fake_ficr, 0, sizeof(fake_ficr));
	fake_usb_enable_ret = 0;
	fake_random = 0;

	fake_commissioned = false;
	fake_joiner_state = OT_JOINER_STATE_IDLE;
	fake_joiner_starts = 0;
	fake_joiner_pskd = NULL;
	fake_joiner_callback = NULL;
	fake_joiner_context = NULL;
	fake_joiner_start_error = OT_ERROR_NONE;
	fake_thread_enables = 0;
	fake_factory_resets = 0;
	memset(fake_gpio_input, 0, sizeof(fake_gpio_input));

	fake_rloc16 = 0;
	memset(&fake_parent, 0, sizeof(fake_parent));
	fake_parent_rssi = 0;
	fake_parent_last_rssi = 0;

	memset(fake_settings, 0, sizeof(fake_settings));
	fake_settings_count = 0;
	fake_settings_saves = 0;
	fake_settings_load_err = 0;
	fake_settings_handler = NULL;

	fake_reset_cause = 0;
	fake_reset_cause_clears = 0;
	fake_reboots = 0;
}
