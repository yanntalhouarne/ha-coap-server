/*
 * Yann T.
 *
 * coap_server.h
 *
 * Headers fonts:
 *     - major: ANSI Regular (dafault): https://patorjk.com/software/taag/#p=display&f=ANSI%20Regular&t=LOCALS%20%20%20%20%20INIT
 * 	   - minor: Big          (default): https://patorjk.com/software/taag/#p=display&f=Big&t=LEDS%20%20%20%20%20INIT
 */

/*
███    ███  █████   ██████ ██████   ██████  ███████
████  ████ ██   ██ ██      ██   ██ ██    ██ ██
██ ████ ██ ███████ ██      ██████  ██    ██ ███████
██  ██  ██ ██   ██ ██      ██   ██ ██    ██      ██
██      ██ ██   ██  ██████ ██   ██  ██████  ███████
*/
/* Enable logging for coap_server.c */
LOG_MODULE_REGISTER(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

/* LEDs */
#define LED1 0            // IO 0_13
#define RADIO_RED_LED 1   // IO 1_2
#define RADIO_BLUE_LED 2  // IO 1_4
#define RADIO_GREEN_LED 3 // IO 1_6

/* Outputs */
#define WATER_PUMP 4 // IO 0_17
#define TOF_EN 5     // IO 0_9

/* Timing */
#define PUMP_MAX_ACTIVE_TIME 4 // in seconds. Maximum time the water pump can be ON continuously.
#define OT_BUZZER_PERIOD 100   // in milli-seconds. The time between when we succsefully connect to the OT network (see below).
#define OT_BUZZER_NBR_PULSES 6 // number of buzzer pulses when we succsefully connect to the OT network.
#define INIT_BUZZER_PERIOD 100 // in milli-seconds. Time between buzzer pulses upon initialization.
#define ADC_TIMER_PERIOD 1     // in seconds

/* Calibration values*/
#define HUMIDITY_DRY 2100 // in mV
#define HUMIDITY_WET 800  // in mV

/* ADC Timer */
// #define ADC_TIMER_ENABLED // if this un-commented, then the adc_timer will periodically read ADC value.

/*
██████  ███████ ██    ██ ██  ██████ ███████     ███████ ████████ ██████  ██    ██  ██████ ████████ ███████
██   ██ ██      ██    ██ ██ ██      ██          ██         ██    ██   ██ ██    ██ ██         ██    ██
██   ██ █████   ██    ██ ██ ██      █████       ███████    ██    ██████  ██    ██ ██         ██    ███████
██   ██ ██       ██  ██  ██ ██      ██               ██    ██    ██   ██ ██    ██ ██         ██         ██
██████  ███████   ████   ██  ██████ ███████     ███████    ██    ██   ██  ██████   ██████    ██    ███████
*/
/* ADC */
#if !DT_NODE_EXISTS(DT_PATH(zephyr_user)) || \
    !DT_NODE_HAS_PROP(DT_PATH(zephyr_user), io_channels)
#error "No suitable devicetree overlay specified for ADC."
#endif
#define DT_SPEC_AND_COMMA(node_id, prop, idx) \
    ADC_DT_SPEC_GET_BY_IDX(node_id, idx),

/* Temperature and humidity sensor */
const struct device *const dev_hdc = DEVICE_DT_GET_ONE(ti_hdc);

/* TOF sensor */
const struct device *const dev_tof = DEVICE_DT_GET_ONE(st_vl53l0x);

/* IMU */
const struct device *const lsm6dsl_dev = DEVICE_DT_GET_ONE(st_lsm6dsl);

/* BUZZER */
static const struct pwm_dt_spec pwm_buzzer = PWM_DT_SPEC_GET(DT_ALIAS(pwm_buzzer));

/* Fuel gauge*/
const struct device *const dev_fuelgauge = DEVICE_DT_GET_ANY(maxim_max17048);

/*
████████ ██ ███    ███ ███████ ██████  ███████
   ██    ██ ████  ████ ██      ██   ██ ██
   ██    ██ ██ ████ ██ █████   ██████  ███████
   ██    ██ ██  ██  ██ ██      ██   ██      ██
   ██    ██ ██      ██ ███████ ██   ██ ███████
*/

/* Water pump timer */
static struct k_timer pump_timer;      // turns off the water pump "PUMP_MAX_ACTIVE_TIME" seconds after it has been turned-on.
static struct k_timer adc_timer;       // if "ADC_TIMER_ENABLED" is defined, then this timer will fetch the ADC value every "ADC_TIMER_PERIOD" seconds.
static struct k_timer buzzer_timer;    // turns off the buzzer 1 second after timer_start() has been called.
static struct k_timer ot_buzzer_timer; // pulses the buzzer "OT_BUZZER_NBR_PULSES" times with a period of "OT_BUZZER_PERIOD" upon connection to the OT network.

/*
 ██████  ██       ██████  ██████   █████  ██      ███████
██       ██      ██    ██ ██   ██ ██   ██ ██      ██
██   ███ ██      ██    ██ ██████  ███████ ██      ███████
██    ██ ██      ██    ██ ██   ██ ██   ██ ██           ██
 ██████  ███████  ██████  ██████  ██   ██ ███████ ███████
*/
/* ADC data buffer */
static const struct adc_dt_spec adc_channels[] = {
    DT_FOREACH_PROP_ELEM(DT_PATH(zephyr_user), io_channels,
                         DT_SPEC_AND_COMMA)};

/* IMU sensor structs */
volatile static struct sensor_value accel_x_out, accel_y_out, accel_z_out;
volatile static struct sensor_value gyro_x_out, gyro_y_out, gyro_z_out;
struct sensor_value odr_attr;

/* HDC sensor global */
struct sensor_value temp, humidity;
uint8_t ti_hdc_buf[4] = {0};

/* ADC globals */
uint16_t buf;
struct adc_sequence sequence = {
    .buffer = &buf,
    /* buffer size in bytes, not number of samples */
    .buffer_size = sizeof(buf),
};

/* FW version */
const char fw_version[] = SRP_CLIENT_INFO;
struct fw_version fw = {
    .fw_version_buf = fw_version,
    .fw_version_size = sizeof(fw_version),
};

/* ADC channel reading */
#ifdef ADC_TIMER_ENABLED
/* ADC value */
int16_t adc_reading = 0; // This is the global variable that is updated when adc_timer executes.
#endif

/* fuel gauge*/
struct fuel_gauge_get_property props_fuel_gauge[] = {
    {
        .property_type = FUEL_GAUGE_RUNTIME_TO_EMPTY,
    },
    {
        .property_type = FUEL_GAUGE_RUNTIME_TO_FULL,
    },
    {
        .property_type = FUEL_GAUGE_STATE_OF_CHARGE,
    },
    {
        .property_type = FUEL_GAUGE_VOLTAGE,
    }};

/* SRP hostname */
const char hostname[] = SRP_CLIENT_HOSTNAME;
const char service_instance[] = SRP_CLIENT_SERVICE_INSTANCE;
#ifdef SRP_CLIENT_RNG
char realhostname[sizeof(hostname) + SRP_CLIENT_RAND_SIZE + 1] = {0};
char realinstance[sizeof(service_instance) + SRP_CLIENT_RAND_SIZE + 1] = {0};
#elif SRP_CLIENT_UNIQUE
char realhostname[sizeof(hostname) + SRP_CLIENT_UNIQUE_SIZE + 1] = {0};
char realinstance[sizeof(service_instance) + SRP_CLIENT_UNIQUE_SIZE + 1] = {0};
#elif SRP_CLIENT_MANUAL
char realhostname[sizeof(hostname) + SRP_CLIENT_MANUAL_SIZE + 1] = {0};
char realinstance[sizeof(service_instance) + SRP_CLIENT_MANUAL_SIZE + 1] = {0};
#endif

/* SRP service name */
const char service_name[] = SRP_SERVICE_NAME;

struct fw_version on_info_request()
{
    return fw;
}

/*
 ██████  ██████   █████  ██████      ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
██      ██    ██ ██   ██ ██   ██     ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
██      ██    ██ ███████ ██████      ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
██      ██    ██ ██   ██ ██          ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
 ██████  ██████  ██   ██ ██          ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████

*/
/* PUMP PUT REQUEST */
static void on_pump_request(uint8_t command);
/* DATA GET REQUEST */
static int8_t *on_data_request();

/*
███████ ██████  ██████      ██   ██  █████  ███    ██ ██████  ██      ███████ ██████
██      ██   ██ ██   ██     ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██
███████ ██████  ██████      ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████
     ██ ██   ██ ██          ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██
███████ ██   ██ ██          ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██
*/
/* SRP client callback */
void on_srp_client_updated(otError aError, const otSrpClientHostInfo *aHostInfo, const otSrpClientService *aServices, const otSrpClientService *aRemovedServices, void *aContext);

/*
 ██████  ████████     ██   ██  █████  ███    ██ ██████  ██      ███████ ██████
██    ██    ██        ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██
██    ██    ██        ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████
██    ██    ██        ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██
 ██████     ██        ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██

*/

/* Callback for OT network state change */
static void on_thread_state_changed(otChangedFlags flags, struct openthread_context *ot_context, void *user_data);
static struct openthread_state_changed_cb ot_state_chaged_cb = {.state_changed_cb = on_thread_state_changed};

/*
████████ ██ ███    ███ ███████ ██████      ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████
   ██    ██ ████  ████ ██      ██   ██     ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██
   ██    ██ ██ ████ ██ █████   ██████      ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████
   ██    ██ ██  ██  ██ ██      ██   ██     ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██
   ██    ██ ██      ██ ███████ ██   ██     ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████
*/
/* Pump timer handler */
static void on_pump_timer_expiry(struct k_timer *timer_id);
/* Stops the buzzer one second after timer_start() has been called  */
static void on_buzzer_timer_expiry(struct k_timer *timer_id);
/* Pulses the buzzer "OT_BUZZER_NBR_PULSES" times with a period of "OT_BUZZER_PERIOD" upon connection to the OT network. */
static void on_ot_buzzer_timer_expiry(struct k_timer *timer_id);
/* Called when S1 is pressed. */
static void on_button_changed(uint32_t button_state, uint32_t has_changed);
/* Fetches the ADC value every "ADC_TIMER_PERIOD" seconds.*/
#ifdef ADC_TIMER_ENABLED
static void on_adc_timer_expiry(struct k_timer *timer_id);
#endif

/*
██   ██ ███████ ██      ██████  ███████ ██████  ███████
██   ██ ██      ██      ██   ██ ██      ██   ██ ██
███████ █████   ██      ██████  █████   ██████  ███████
██   ██ ██      ██      ██      ██      ██   ██      ██
██   ██ ███████ ███████ ██      ███████ ██   ██ ███████
*/
/* Generates a unique SRP hostname and service name */
void srp_client_generate_name();