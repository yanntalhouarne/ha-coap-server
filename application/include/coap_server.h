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
#define __OT_COAP_SERVER_H__

/*
██ ███    ██  ██████ ██      ██    ██ ██████  ███████ ███████
██ ████   ██ ██      ██      ██    ██ ██   ██ ██      ██
██ ██ ██  ██ ██      ██      ██    ██ ██   ██ █████   ███████
██ ██  ██ ██ ██      ██      ██    ██ ██   ██ ██           ██
██ ██   ████  ██████ ███████  ██████  ██████  ███████ ███████
*/
/* ZEPHYR */
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
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
#include <zephyr/drivers/gpio.h>
#include <soc.h>
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
#include <string.h>

/*
███    ███  █████   ██████ ██████   ██████  ███████
████  ████ ██   ██ ██      ██   ██ ██    ██ ██
██ ████ ██ ███████ ██      ██████  ██    ██ ███████
██  ██  ██ ██   ██ ██      ██   ██ ██    ██      ██
██      ██ ██   ██  ██████ ██   ██  ██████  ███████
*/
/* LEDs (indices into the devicetree 'leds' node, driven through the DK library) */
#define LED1 0            // IO 0_13, blue user LED (LED2 on the schematic)
#define RADIO_RED_LED 1   // IO 1_2, module RGB LED
#define RADIO_BLUE_LED 2  // IO 1_4, module RGB LED
#define RADIO_GREEN_LED 3 // IO 1_6, module RGB LED

/* Timing */
#define BOOT_DELAY 2150 // in milli-seconds. Delay at the start of main().
#define PUMP_DEFAULT_ACTIVE_TIME 1 // in seconds. Default time the water pump is ON continuously.
#define PUMP_MIN_ACTIVE_TIME 1 // in seconds. Minimum time the water pump can be ON continuously.
#define PUMP_MAX_ACTIVE_TIME 10 // in seconds. Upper bound (exclusive) for the time the water pump can be ON continuously.
#define PUMP_BUZZER_FREQUENCY 4 // in kHz
#define PUMP_BUZZER_PERIOD 100 // in milli-seconds. Length of the beep when the pump starts.
#define OT_BUZZER_FREQUENCY 6 // in kHz
#define OT_BUZZER_PERIOD 100   // in milli-seconds. Length of each beep (and pause) when we successfully connect to the OT network.
#define OT_BUZZER_NBR_BEEPS 3  // number of beeps when we successfully connect to the OT network.
#define PING_BUZZER_FREQUENCY 10 // in kHz
#define PING_BUZZER_PERIOD 75   // in milli-seconds. Length of each beep (and pause) when we receive a 'ping' PUT request with payload '1'.
#define PING_BUZZER_NBR_BEEPS 6 // number of beeps when we receive a 'ping' PUT request with payload '1'.
#define INIT_BUZZER_PERIOD 100 // in milli-seconds. Time between buzzer pulses upon initialization.
#define SENSOR_POWER_UP_TIME 200 // in milli-seconds. Time the soil sensor needs after SENSOR_EN before it is sampled.
#define ERROR_BLINK_PERIOD 500 // in milli-seconds. On (and off) time of the red LED blinks reporting a missing sensor.

/* Calibration values*/
#define HUMIDITY_DRY 2200 // in mV
#define HUMIDITY_WET 980  // in mV

#endif // __OT_COAP_SERVER_H__
