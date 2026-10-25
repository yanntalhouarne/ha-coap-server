/*
 * Yann T.
 *
 * status_led.h
 *
 * The module's RGB LED (network and error states) and the blue user LED (pump).
 */

#ifndef STATUS_LED_H_
#define STATUS_LED_H_

#include <stdbool.h>

/* RGB LED states */
enum status_led_state
{
	STATUS_LED_OFF,         // attached and registered
	STATUS_LED_SRP_PENDING, // blue: attached, SRP registration not confirmed yet
	STATUS_LED_NO_NETWORK,  // red + green: Thread disabled or detached
	STATUS_LED_FAULT,       // red only
};

/* Initializes the LEDs (all off). Call first, so later error indications work. */
int status_led_init(void);

/* Sets the RGB LED to 'state'. */
void status_led_show(enum status_led_state state);

/* Turns the red LED on, leaving the others as they are. Cleared by the next status_led_show(). */
void status_led_error(void);

/* Blinks the red LED 'count' times (blocking), then leaves it on. */
void status_led_error_blink(int count);

/* Turns the green LED on or off. For the boot jingle. */
void status_led_boot(bool on);

/* Turns the blue user LED on or off. It shows that the pump is running. */
void status_led_user(bool on);

#endif // STATUS_LED_H_
