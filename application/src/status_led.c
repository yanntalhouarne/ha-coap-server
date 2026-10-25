/*
 * Yann T.
 *
 * status_led.c
 *
 * LEDs, driven through the DK library by their index in the devicetree 'leds' node.
 */

#include <zephyr/kernel.h>
#include <dk_buttons_and_leds.h>

#include "status_led.h"

/* Indices into the devicetree 'leds' node */
#define USER_LED 0  // IO 0_13, blue user LED (LED2 on the schematic)
#define RED_LED 1   // IO 1_2, module RGB LED
#define BLUE_LED 2  // IO 1_4, module RGB LED
#define GREEN_LED 3 // IO 1_6, module RGB LED

#define ERROR_BLINK_PERIOD_MS 500 // on (and off) time of each red blink

int status_led_init(void)
{
	return dk_leds_init();
}

void status_led_show(enum status_led_state state)
{
	dk_set_led(RED_LED, (state == STATUS_LED_NO_NETWORK) || (state == STATUS_LED_FAULT));
	dk_set_led(GREEN_LED, state == STATUS_LED_NO_NETWORK);
	dk_set_led(BLUE_LED, state == STATUS_LED_SRP_PENDING);
}

void status_led_error(void)
{
	dk_set_led_on(RED_LED);
}

void status_led_error_blink(int count)
{
	for (int i = 0; i < count; i++)
	{
		dk_set_led_on(RED_LED);
		k_sleep(K_MSEC(ERROR_BLINK_PERIOD_MS));
		dk_set_led_off(RED_LED);
		k_sleep(K_MSEC(ERROR_BLINK_PERIOD_MS));
	}
	dk_set_led_on(RED_LED);
}

void status_led_boot(bool on)
{
	dk_set_led(GREEN_LED, on);
}

void status_led_user(bool on)
{
	dk_set_led(USER_LED, on);
}
