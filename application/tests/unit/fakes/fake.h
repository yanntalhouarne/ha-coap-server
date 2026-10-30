/*
 * fake.h
 *
 * Just enough of the Zephyr, OpenThread, mcumgr and nRF APIs to compile the firmware's
 * source files on a PC. The fake functions record what the code under test did, and
 * the tests drive timers, work items and callbacks by hand (see fakes.c).
 *
 * Every fake header (zephyr/kernel.h, openthread/coap.h, ...) includes this file.
 */

#ifndef FAKE_H_
#define FAKE_H_

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* ---------------------------------------------------------------- sys/util.h */

#define BIT(n) (1UL << (n))
#define ARRAY_SIZE(array) (sizeof(array) / sizeof((array)[0]))
#define ARG_UNUSED(x) (void)(x)
#define MIN(a, b) (((a) < (b)) ? (a) : (b))
#define MAX(a, b) (((a) > (b)) ? (a) : (b))
#define CLAMP(val, low, high) (((val) <= (low)) ? (low) : MIN(val, high))
#define CONTAINER_OF(ptr, type, field) ((type *)(((char *)(ptr)) - offsetof(type, field)))
#define BUILD_ASSERT(cond, msg) _Static_assert(cond, msg)
#define MSEC_PER_SEC 1000

/* IS_ENABLED(CONFIG_X): 1 if CONFIG_X is defined to 1, else 0 (Zephyr's own trick) */
#define Z_IS_ENABLED1(config_macro) Z_IS_ENABLED2(_XXXX##config_macro)
#define _XXXX1 _YYYY,
#define Z_IS_ENABLED2(one_or_two_args) Z_IS_ENABLED3(one_or_two_args 1, 0)
#define Z_IS_ENABLED3(ignore_this, val, ...) val
#define IS_ENABLED(config_macro) Z_IS_ENABLED1(config_macro)

/* ---------------------------------------------------------------- logging */

/* Logs are dropped, but their arguments are still checked against the format. */
__attribute__((format(printf, 1, 2))) static inline void fake_log(const char *format, ...)
{
	(void)format;
}

#define LOG_MODULE_REGISTER(...) extern int fake_log_module
#define LOG_MODULE_DECLARE(...) extern int fake_log_module
#define LOG_ERR(...) fake_log(__VA_ARGS__)
#define LOG_WRN(...) fake_log(__VA_ARGS__)
#define LOG_INF(...) fake_log(__VA_ARGS__)
#define LOG_DBG(...) fake_log(__VA_ARGS__)

/* ---------------------------------------------------------------- kernel */

typedef struct
{
	int64_t ms;
} k_timeout_t;

#define K_MSEC(ms) ((k_timeout_t){(ms)})
#define K_SECONDS(s) ((k_timeout_t){(int64_t)(s) * 1000})
#define K_NO_WAIT ((k_timeout_t){0})
#define K_FOREVER ((k_timeout_t){-1})

extern int64_t fake_uptime_ms;    // returned by k_uptime_get()
extern int64_t fake_slept_ms;     // total of all k_sleep() calls

int64_t k_uptime_get(void);
int32_t k_sleep(k_timeout_t timeout);

/* Timers: the tests fire them with fake_timer_fire(). */
struct k_timer
{
	void (*expiry_fn)(struct k_timer *timer);
	void (*stop_fn)(struct k_timer *timer);
	bool running;
	int64_t duration_ms;
	int64_t period_ms;
	int starts;
};

#define K_TIMER_DEFINE(name, expiry, stop) struct k_timer name = {.expiry_fn = (expiry), .stop_fn = (stop)}

void k_timer_start(struct k_timer *timer, k_timeout_t duration, k_timeout_t period);
void k_timer_stop(struct k_timer *timer);
/* Calls the timer's expiry function, as the kernel would. A one-shot timer stops first. */
void fake_timer_fire(struct k_timer *timer);

/* Work items: the tests run them with fake_work_run() / fake_dwork_run(). */
struct k_work
{
	void (*handler)(struct k_work *work);
	bool pending;
	int submits;
};

struct k_work_delayable
{
	struct k_work work;
	bool scheduled;
	int64_t delay_ms;
	int schedules;
};

#define K_WORK_DEFINE(name, fn) struct k_work name = {.handler = (fn)}
#define K_WORK_DELAYABLE_DEFINE(name, fn) struct k_work_delayable name = {.work = {.handler = (fn)}}

int k_work_submit(struct k_work *work);
int k_work_schedule(struct k_work_delayable *dwork, k_timeout_t delay);
int k_work_reschedule(struct k_work_delayable *dwork, k_timeout_t delay);
static inline struct k_work_delayable *k_work_delayable_from_work(struct k_work *work)
{
	return CONTAINER_OF(work, struct k_work_delayable, work);
}
/* Runs a submitted work item's handler, as the work queue would. */
void fake_work_run(struct k_work *work);
/* Runs a scheduled delayable work item's handler, as if its delay had passed. */
void fake_dwork_run(struct k_work_delayable *dwork);

/* Spinlocks and atomics: single-threaded in the tests */
struct k_spinlock
{
	int locked;
};
typedef int k_spinlock_key_t;

static inline k_spinlock_key_t k_spin_lock(struct k_spinlock *lock)
{
	lock->locked++;
	return 0;
}

static inline void k_spin_unlock(struct k_spinlock *lock, k_spinlock_key_t key)
{
	(void)key;
	lock->locked--;
}

typedef long atomic_t;

#define ATOMIC_INIT(i) (i)

static inline long atomic_set(atomic_t *target, long value)
{
	long old = *target;

	*target = value;
	return old;
}

static inline long atomic_get(const atomic_t *target)
{
	return *target;
}

/* ---------------------------------------------------------------- devices and devicetree */

struct device
{
	const char *name;
	bool ready;
};

extern struct device fake_gpio_dev;
extern struct device fake_adc_dev;
extern struct device fake_hdc_dev;
extern struct device fake_fuel_gauge_dev;

static inline bool device_is_ready(const struct device *dev)
{
	return dev->ready;
}

#define DT_PATH(...) 0
#define DT_ALIAS(alias) alias
#define DT_NODE_EXISTS(node) 1
#define DT_NODE_HAS_PROP(node, prop) 1
#define DT_NODE_HAS_STATUS(node, status) 1
#define DEVICE_DT_GET_ONE(compat) (&fake_hdc_dev)
#define DEVICE_DT_GET_ANY(compat) (&fake_fuel_gauge_dev)

/* ---------------------------------------------------------------- GPIO */

typedef uint32_t gpio_flags_t;

#define GPIO_INPUT BIT(16)
#define GPIO_OUTPUT_INACTIVE BIT(17)
#define GPIO_INT_EDGE_TO_ACTIVE BIT(18)

struct gpio_dt_spec
{
	const struct device *port;
	uint8_t pin;
};

/* Each alias gets its own pin number, so the fakes can tell the pins apart. */
enum fake_pin
{
	FAKE_PIN_pump1 = 1,
	FAKE_PIN_usrbutton,
	FAKE_PIN_sensor_en,
	FAKE_PIN_sensor_pwr,
	FAKE_PIN_COUNT,
};

/* Two steps, so that 'node' (DT_ALIAS(x)) is expanded before it is pasted */
#define GPIO_DT_SPEC_GET(node, prop) FAKE_GPIO_SPEC(node)
#define FAKE_GPIO_SPEC(alias) {.port = &fake_gpio_dev, .pin = FAKE_PIN_##alias}

struct gpio_callback;
typedef void (*gpio_callback_handler_t)(const struct device *port, struct gpio_callback *cb, uint32_t pins);

struct gpio_callback
{
	gpio_callback_handler_t handler;
	uint32_t pin_mask;
};

extern int fake_gpio_value[FAKE_PIN_COUNT];       // last value set on each pin
extern gpio_flags_t fake_gpio_flags[FAKE_PIN_COUNT]; // last configuration of each pin
extern gpio_flags_t fake_gpio_int_flags[FAKE_PIN_COUNT];
extern struct gpio_callback *fake_gpio_callback;  // last callback added

static inline bool gpio_is_ready_dt(const struct gpio_dt_spec *spec)
{
	return spec->port->ready;
}

int gpio_pin_configure_dt(const struct gpio_dt_spec *spec, gpio_flags_t flags);
int gpio_pin_set_dt(const struct gpio_dt_spec *spec, int value);
int gpio_pin_interrupt_configure_dt(const struct gpio_dt_spec *spec, gpio_flags_t flags);
void gpio_init_callback(struct gpio_callback *callback, gpio_callback_handler_t handler, uint32_t pin_mask);
int gpio_add_callback(const struct device *port, struct gpio_callback *callback);

/* ---------------------------------------------------------------- ADC */

struct adc_dt_spec
{
	const struct device *dev;
};

struct adc_sequence
{
	void *buffer;
	size_t buffer_size;
};

#define ADC_DT_SPEC_GET_BY_IDX(node, idx) {.dev = &fake_adc_dev}

extern int16_t fake_adc_raw;  // sample returned by adc_read()
extern int fake_adc_read_err;
extern int fake_adc_reads;
extern int fake_adc_power_at_read; // soil sensor power (sensor_en) during the last adc_read()

int adc_channel_setup_dt(const struct adc_dt_spec *spec);
int adc_sequence_init_dt(const struct adc_dt_spec *spec, struct adc_sequence *seq);
int adc_read(const struct device *dev, const struct adc_sequence *sequence);
/* The fake ADC's raw values are already in millivolts. */
int adc_raw_to_millivolts_dt(const struct adc_dt_spec *spec, int32_t *valp);

/* ---------------------------------------------------------------- sensors */

struct sensor_value
{
	int32_t val1;
	int32_t val2;
};

enum sensor_channel
{
	SENSOR_CHAN_AMBIENT_TEMP,
	SENSOR_CHAN_HUMIDITY,
};

extern struct sensor_value fake_temperature;
extern struct sensor_value fake_humidity;
extern int fake_sensor_err;

int sensor_sample_fetch(const struct device *dev);
int sensor_channel_get(const struct device *dev, enum sensor_channel chan, struct sensor_value *val);

/* ---------------------------------------------------------------- fuel gauge */

enum fuel_gauge_property
{
	FUEL_GAUGE_RUNTIME_TO_EMPTY,
	FUEL_GAUGE_RUNTIME_TO_FULL,
	FUEL_GAUGE_STATE_OF_CHARGE,
	FUEL_GAUGE_VOLTAGE,
};

struct fuel_gauge_get_property
{
	enum fuel_gauge_property property_type;
	int status;
	union
	{
		uint32_t runtime_to_empty;
		uint32_t runtime_to_full;
		uint8_t state_of_charge;
		int voltage;
	} value;
};

extern uint8_t fake_battery_soc;
extern int fake_fuel_gauge_err;

int fuel_gauge_get_prop(const struct device *dev, struct fuel_gauge_get_property *props, size_t props_len);

/* ---------------------------------------------------------------- OpenThread */

typedef enum
{
	OT_ERROR_NONE = 0,
	OT_ERROR_FAILED = 1,
	OT_ERROR_NO_BUFS = 3,
	OT_ERROR_INVALID_ARGS = 7,
} otError;

typedef struct otInstance
{
	int unused;
} otInstance;

typedef enum
{
	OT_COAP_TYPE_CONFIRMABLE = 0,
	OT_COAP_TYPE_NON_CONFIRMABLE = 1,
	OT_COAP_TYPE_ACKNOWLEDGMENT = 2,
	OT_COAP_TYPE_RESET = 3,
} otCoapType;

typedef enum
{
	OT_COAP_CODE_EMPTY = 0,
	OT_COAP_CODE_GET = 1,
	OT_COAP_CODE_POST = 2,
	OT_COAP_CODE_PUT = 3,
	OT_COAP_CODE_DELETE = 4,
	OT_COAP_CODE_CHANGED = 0x44,
	OT_COAP_CODE_CONTENT = 0x45,
	OT_COAP_CODE_NOT_FOUND = 0x84,
} otCoapCode;

#define OT_COAP_OPTION_URI_QUERY 15

#define OT_DEFAULT_COAP_PORT 5683

#define FAKE_MESSAGE_SIZE 600
#define FAKE_MAX_QUERIES 4

typedef struct otMessage
{
	otCoapType type;
	otCoapCode code;
	uint8_t bytes[FAKE_MESSAGE_SIZE]; // the payload, after the (unmodeled) header
	uint16_t length;
	bool payload_marker;
	bool initialized;
	bool freed;
	const char *queries[FAKE_MAX_QUERIES]; // Uri-Query options
	int query_count;
} otMessage;

typedef struct otCoapOption
{
	uint16_t mNumber;
	uint16_t mLength;
} otCoapOption;

typedef struct otCoapOptionIterator
{
	const otMessage *mMessage;
	otCoapOption mOption;
	uint16_t mNextOptionOffset; // here, the index of the next query
} otCoapOptionIterator;

typedef struct
{
	uint8_t m8[16];
} otIp6Address;

typedef struct otMessageInfo
{
	otIp6Address mSockAddr;
	otIp6Address mPeerAddr;
	uint16_t mSockPort;
	uint16_t mPeerPort;
} otMessageInfo;

typedef void (*otCoapRequestHandler)(void *context, otMessage *message, const otMessageInfo *message_info);

typedef struct otCoapResource
{
	const char *mUriPath;
	otCoapRequestHandler mHandler;
	void *mContext;
	struct otCoapResource *mNext;
} otCoapResource;

typedef struct otMessageSettings otMessageSettings;

#define FAKE_MAX_RESOURCES 8

extern otInstance fake_ot_instance;
extern otCoapResource *fake_coap_resources[FAKE_MAX_RESOURCES]; // added with otCoapAddResource()
extern int fake_coap_resource_count;
extern otCoapRequestHandler fake_coap_default_handler;
extern uint16_t fake_coap_port;           // set by otCoapStart()
extern otError fake_coap_start_error;
extern bool fake_coap_no_bufs;            // otCoapNewMessage() returns NULL
extern otMessage fake_response;           // last response sent
extern otMessageInfo fake_response_info;
extern int fake_responses_sent;
extern int fake_messages_allocated;
extern int fake_messages_freed;

otCoapType otCoapMessageGetType(const otMessage *message);
otCoapCode otCoapMessageGetCode(const otMessage *message);
otMessage *otCoapNewMessage(otInstance *instance, const otMessageSettings *settings);
otError otCoapMessageInitResponse(otMessage *response, const otMessage *request, otCoapType type, otCoapCode code);
otError otCoapMessageSetPayloadMarker(otMessage *message);
otError otMessageAppend(otMessage *message, const void *buf, uint16_t length);
otError otCoapSendResponse(otInstance *instance, otMessage *message, const otMessageInfo *message_info);
void otMessageFree(otMessage *message);
uint16_t otMessageGetOffset(const otMessage *message);
uint16_t otMessageRead(const otMessage *message, uint16_t offset, void *buf, uint16_t length);
otError otCoapOptionIteratorInit(otCoapOptionIterator *iterator, const otMessage *message);
const otCoapOption *otCoapOptionIteratorGetFirstOptionMatching(otCoapOptionIterator *iterator, uint16_t option);
const otCoapOption *otCoapOptionIteratorGetNextOptionMatching(otCoapOptionIterator *iterator, uint16_t option);
otError otCoapOptionIteratorGetOptionValue(otCoapOptionIterator *iterator, void *value);
void otCoapSetDefaultHandler(otInstance *instance, otCoapRequestHandler handler, void *context);
void otCoapAddResource(otInstance *instance, otCoapResource *resource);
otError otCoapStart(otInstance *instance, uint16_t port);

/* Builds a request with an optional payload (NULL for none). */
void fake_request_init(otMessage *request, otCoapType type, otCoapCode code, const char *payload);
/* Adds a Uri-Query option ("from=12"). 'query' must stay valid. */
void fake_request_add_query(otMessage *request, const char *query);

/* Link */
extern uint32_t fake_poll_period_ms; // last value passed to otLinkSetPollPeriod()
extern int fake_poll_period_sets;

otError otLinkSetPollPeriod(otInstance *instance, uint32_t poll_period);

/* Thread */
typedef uint32_t otChangedFlags;
#define OT_CHANGED_THREAD_ROLE BIT(2)

typedef enum
{
	OT_DEVICE_ROLE_DISABLED = 0,
	OT_DEVICE_ROLE_DETACHED = 1,
	OT_DEVICE_ROLE_CHILD = 2,
	OT_DEVICE_ROLE_ROUTER = 3,
	OT_DEVICE_ROLE_LEADER = 4,
} otDeviceRole;

extern otDeviceRole fake_device_role;

otDeviceRole otThreadGetDeviceRole(otInstance *instance);
const char *otThreadErrorToString(otError error);

/* SRP client */
typedef struct otSrpClientHostInfo otSrpClientHostInfo;

typedef struct otSrpClientService
{
	const char *mName;
	const char *mInstanceName;
	uint8_t mNumTxtEntries;
	uint16_t mPort;
} otSrpClientService;

typedef void (*otSrpClientCallback)(otError error, const otSrpClientHostInfo *host_info,
				     const otSrpClientService *services, const otSrpClientService *removed_services,
				     void *context);

#define FAKE_SRP_STRING_SIZE 64

typedef struct otSrpClientBuffersServiceEntry
{
	otSrpClientService mService;
	char instance_name[FAKE_SRP_STRING_SIZE];
	char service_name[FAKE_SRP_STRING_SIZE];
} otSrpClientBuffersServiceEntry;

extern otSrpClientCallback fake_srp_callback;
extern const char *fake_srp_host_name;
extern const otSrpClientService *fake_srp_service; // last service added
extern bool fake_srp_auto_host_address;
extern bool fake_srp_auto_start;
extern bool fake_srp_no_buffers;               // otSrpClientBuffersAllocateService() returns NULL

void otSrpClientSetCallback(otInstance *instance, otSrpClientCallback callback, void *context);
otError otSrpClientSetHostName(otInstance *instance, const char *name);
otError otSrpClientEnableAutoHostAddress(otInstance *instance);
otSrpClientBuffersServiceEntry *otSrpClientBuffersAllocateService(otInstance *instance);
char *otSrpClientBuffersGetServiceEntryInstanceNameString(otSrpClientBuffersServiceEntry *entry, uint16_t *size);
char *otSrpClientBuffersGetServiceEntryServiceNameString(otSrpClientBuffersServiceEntry *entry, uint16_t *size);
otError otSrpClientAddService(otInstance *instance, otSrpClientService *service);
void otSrpClientEnableAutoStartMode(otInstance *instance, void *callback, void *context);

/* ---------------------------------------------------------------- Zephyr's OpenThread glue */

struct openthread_context
{
	otInstance *instance;
};

struct openthread_state_changed_cb
{
	void (*state_changed_cb)(otChangedFlags flags, struct openthread_context *ot_context, void *user_data);
	void *user_data;
};

extern struct openthread_context fake_ot_context;
extern int fake_ot_api_lock_depth;     // must be back to 0 after every call
extern int fake_ot_api_locks;          // number of lock calls
extern struct openthread_state_changed_cb *fake_ot_state_cb;
extern bool fake_ot_started;

struct openthread_context *openthread_get_default_context(void);
otInstance *openthread_get_default_instance(void);
void openthread_api_mutex_lock(struct openthread_context *ot_context);
void openthread_api_mutex_unlock(struct openthread_context *ot_context);
int openthread_state_changed_cb_register(struct openthread_context *ot_context, struct openthread_state_changed_cb *cb);
int openthread_start(struct openthread_context *ot_context);

/* ---------------------------------------------------------------- mcumgr */

typedef int32_t (*mgmt_cb)(uint32_t event, int32_t rc, bool *abort_more, void *data, size_t data_size);

struct mgmt_callback
{
	void *node;
	mgmt_cb callback;
	uint32_t event_id;
};

#define MGMT_EVT_OP_CMD_RECV 0x00010000U
#define MGMT_ERR_EOK 0

extern struct mgmt_callback *fake_mgmt_callback; // last callback registered

void mgmt_callback_register(struct mgmt_callback *callback);
/* Delivers an mcumgr event to the registered callback, as mcumgr would. */
int32_t fake_mgmt_notify(uint32_t event);

/* ---------------------------------------------------------------- OpenThread parent */

typedef struct otRouterInfo
{
	uint16_t mRloc16;
	uint8_t mLinkQualityIn;
} otRouterInfo;

extern uint16_t fake_rloc16;
extern otRouterInfo fake_parent;
extern int8_t fake_parent_rssi;
extern int8_t fake_parent_last_rssi;

uint16_t otThreadGetRloc16(otInstance *instance);
otError otThreadGetParentInfo(otInstance *instance, otRouterInfo *parent);
otError otThreadGetParentAverageRssi(otInstance *instance, int8_t *rssi);
otError otThreadGetParentLastRssi(otInstance *instance, int8_t *rssi);

/* ---------------------------------------------------------------- settings */

typedef long (*settings_read_cb)(void *cb_arg, void *data, size_t len);

/* The handler's set function becomes fake_settings_set_<name>; the tests hand it to
 * fake_settings_handler before settings_load_subtree(), which feeds it the stored values. */
#define SETTINGS_STATIC_HANDLER_DEFINE(_hname, _tree, _get, _set, _commit, _export) \
	int (*const fake_settings_set_##_hname)(const char *, size_t, settings_read_cb, void *) = _set

#define FAKE_SETTINGS_MAX 16
#define FAKE_SETTING_SIZE 8

struct fake_setting
{
	char name[32];
	uint8_t value[FAKE_SETTING_SIZE];
	size_t length;
};

extern struct fake_setting fake_settings[FAKE_SETTINGS_MAX]; // the "flash"
extern int fake_settings_count;
extern int fake_settings_saves;
extern int fake_settings_load_err;
extern int (*fake_settings_handler)(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg);

int settings_subsys_init(void);
int settings_load_subtree(const char *subtree);
int settings_save_one(const char *name, const void *value, size_t val_len);
/* The stored value of 'name' as an int32 (or 'missing') */
int32_t fake_setting_int(const char *name, int32_t missing);
void fake_setting_store(const char *name, const void *value, size_t length);

/* ---------------------------------------------------------------- reset cause, fatal errors, reboot */

#define RESET_PIN BIT(0)
#define RESET_SOFTWARE BIT(1)
#define RESET_BROWNOUT BIT(2)
#define RESET_POR BIT(3)
#define RESET_WATCHDOG BIT(4)
#define RESET_DEBUG BIT(5)
#define RESET_LOW_POWER_WAKE BIT(7)
#define RESET_CPU_LOCKUP BIT(8)

extern uint32_t fake_reset_cause;
extern int fake_reset_cause_clears;

int hwinfo_get_reset_cause(uint32_t *cause);
int hwinfo_clear_reset_cause(void);

typedef struct
{
	struct
	{
		uint32_t pc;
	} basic;
} z_arch_esf_t;

#define __noinit
#define LOG_PANIC() ((void)0)
#define SYS_REBOOT_COLD 1

extern int fake_reboots;

void sys_reboot(int type);

/* ---------------------------------------------------------------- nRF, USB, random */

#define FAKE_LED_COUNT 4

extern int fake_leds[FAKE_LED_COUNT];
extern int fake_led_changes; // dk_set_led*() calls

int dk_leds_init(void);
int dk_set_led(uint8_t led_idx, uint32_t val);
int dk_set_led_on(uint8_t led_idx);
int dk_set_led_off(uint8_t led_idx);

typedef struct
{
	uint32_t DEVICEID[2];
} NRF_FICR_Type;

extern NRF_FICR_Type fake_ficr;
#define NRF_FICR (&fake_ficr)

extern int fake_usb_enable_ret;

int usb_enable(void *status_cb);

extern uint32_t fake_random;

uint32_t sys_rand32_get(void);

/* ---------------------------------------------------------------- test helpers */

/* Resets every fake to its initial state. Called before each test. */
void fake_reset(void);

#endif // FAKE_H_
