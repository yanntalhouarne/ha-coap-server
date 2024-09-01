/*
 * Yann T.
 *
 * coap_server.h
 *
 * Headers fonts:
 *     - major: ANSI Regular (dafault): https://patorjk.com/software/taag/#p=display&f=ANSI%20Regular&t=LOCALS%20%20%20%20%20INIT
 * 	   - minor: Big          (default): https://patorjk.com/software/taag/#p=display&f=Big&t=LEDS%20%20%20%20%20INIT
 */

#ifndef __OT_COAP_SERVER_H__
#define __OT_COAP_SEVER_H__

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
#include <zephyr/drivers/gpio.h>
/* OPENTHREAD */
#include <openthread/thread.h>
#include <openthread/srp_client.h>
#include <openthread/srp_client_buffers.h>
/* APPLICATION */
#include <dk_buttons_and_leds.h>
#include "ot_coap_utils.h"
#include "ot_srp_config.h"
/* OTHERS */
#include <stdio.h>

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
#define SENSOR_EN 6 // IO 0_28
#define SENSOR_VCC_MCU 7 // IO 1_15

/* Timing */
#define PUMP_MAX_ACTIVE_TIME 4 // in seconds. Maximum time the water pump can be ON continuously.
#define PUMP_BUZZER_FREQUENCY 4 // in kHz
#define OT_BUZZER_FREQUENCY 6 // in kHz
#define OT_BUZZER_PERIOD 100   // in milli-seconds. The time between buzzer on/off when we succsefully connect to the OT network (see below).
#define OT_BUZZER_NBR_PULSES 6 // number of buzzer pulses when we succesfully connect to the OT network.
#define PING_BUZZER_FREQUENCY 10 // in kHz
#define PING_BUZZER_PERIOD 50   // in milli-seconds. The time between buzzer on/off when we receive a CON PUT 'ping' request with payload '1'.
#define PING_BUZZER_NBR_PULSES 12 // number of buzzer pulses when we receive a CON PUT 'ping' request with payload '1'.
#define INIT_BUZZER_PERIOD 100 // in milli-seconds. Time between buzzer pulses upon initialization.
#define ADC_TIMER_PERIOD 1     // in seconds

/* Calibration values*/
#define HUMIDITY_DRY 2200 // in mV
#define HUMIDITY_WET 980  // in mV

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

// /* IMU */
// const struct device *const lsm6dsl_dev = DEVICE_DT_GET_ONE(st_lsm6dsl);

/* BUZZER */
static const struct pwm_dt_spec pwm_buzzer = PWM_DT_SPEC_GET(DT_ALIAS(pwm_buzzer));

/* Fuel gauge*/
const struct device *const dev_fuelgauge = DEVICE_DT_GET_ANY(maxim_max17048);

/* Get button configuration from the devicetree sw0 alias. This is mandatory. */
#define USRBUTTON_NODE	DT_ALIAS(usrbutton)
#if !DT_NODE_HAS_STATUS(USRBUTTON_NODE, okay)
#error "Unsupported board: usrbutton devicetree alias is not defined"
#endif
static const struct gpio_dt_spec usr_button = GPIO_DT_SPEC_GET_OR(USRBUTTON_NODE, gpios,
							      {0});
static struct gpio_callback usr_button_cb_data;

/*
████████ ██ ███    ███ ███████ ██████  ███████
   ██    ██ ████  ████ ██      ██   ██ ██
   ██    ██ ██ ████ ██ █████   ██████  ███████
   ██    ██ ██  ██  ██ ██      ██   ██      ██
   ██    ██ ██      ██ ███████ ██   ██ ███████
*/
static struct k_timer pump_timer;      // turns off the water pump "PUMP_MAX_ACTIVE_TIME" seconds after it has been turned-on.
static struct k_timer adc_timer;       // if "ADC_TIMER_ENABLED" is defined, then this timer will fetch the ADC value every "ADC_TIMER_PERIOD" seconds.
static struct k_timer pump_buzzer_timer;    // turns off the buzzer 1 second after timer_start() has been called.
static struct k_timer ot_buzzer_timer; // pulses the buzzer "OT_BUZZER_NBR_PULSES" times with a period of "OT_BUZZER_PERIOD" upon connection to the OT network.
static struct k_timer ping_buzzer_timer; // pulses the buzzer "PING_BUZZER_NBR_PULSES" times with a period of "PING_BUZZER_PERIOD" upon reception a a CON PUT 'ping' request with payload '1'.

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
static struct sensor_value accel_x_out, accel_y_out, accel_z_out;
static struct sensor_value gyro_x_out, gyro_y_out, gyro_z_out;
struct sensor_value odr_attr;
char imu_buf[100];

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
const char fw_version[] = FW_VERSION;
const char hw_version[] = HW_VERSION;
struct info_data info = {
    .fw_version_buf = fw_version,
    .fw_version_size = sizeof(fw_version),

    .hw_version_buf = hw_version,
    .hw_version_size = sizeof(hw_version),

    .total_size = sizeof(fw_version)+sizeof(hw_version),
};

/* Buzzer */
uint8_t buzzer_active = 0;

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
/* INFO GET REQUEST */
struct info_data on_info_request();
/* PING PUT REQUEST */
static void on_ping_request(uint8_t command);

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
static void on_pump_buzzer_timer_expiry(struct k_timer *timer_id);
/* Pulses the buzzer "OT_BUZZER_NBR_PULSES" times with a period of "OT_BUZZER_PERIOD" upon connection to the OT network. */
static void on_ot_buzzer_timer_expiry(struct k_timer *timer_id);
/* pulses the buzzer "PING_BUZZER_NBR_PULSES" times with a period of "PING_BUZZER_PERIOD" upon reception a a CON PUT 'ping' request with payload '1'. */
static void on_opingbuzzer_timer_expiry(struct k_timer *timer_id);
/* Fetches the ADC value every "ADC_TIMER_PERIOD" seconds.*/
#ifdef ADC_TIMER_ENABLED
static void on_adc_timer_expiry(struct k_timer *timer_id);
#endif

/*
██████  ██    ██ ████████ ████████  ██████  ███    ██ ███████     ██   ██  █████  ███    ██ ██████  ██      ███████ ██████  ███████ 
██   ██ ██    ██    ██       ██    ██    ██ ████   ██ ██          ██   ██ ██   ██ ████   ██ ██   ██ ██      ██      ██   ██ ██      
██████  ██    ██    ██       ██    ██    ██ ██ ██  ██ ███████     ███████ ███████ ██ ██  ██ ██   ██ ██      █████   ██████  ███████ 
██   ██ ██    ██    ██       ██    ██    ██ ██  ██ ██      ██     ██   ██ ██   ██ ██  ██ ██ ██   ██ ██      ██      ██   ██      ██ 
██████   ██████     ██       ██     ██████  ██   ████ ███████     ██   ██ ██   ██ ██   ████ ██████  ███████ ███████ ██   ██ ███████
*/
/* Called when S1 is pressed. */
void on_usr_button_changed(const struct device *dev, struct gpio_callback *cb, uint32_t pins);

/*
██   ██ ███████ ██      ██████  ███████ ██████  ███████
██   ██ ██      ██      ██   ██ ██      ██   ██ ██
███████ █████   ██      ██████  █████   ██████  ███████
██   ██ ██      ██      ██      ██      ██   ██      ██
██   ██ ███████ ███████ ██      ███████ ██   ██ ███████
*/
/* Generates a unique SRP hostname and service name */
void srp_client_generate_name();

/* Converts a sensor_value struct into a float */
static inline float out_ev(struct sensor_value *val);


#endif // __OT_COAP_SERVER_H__