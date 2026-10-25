/*
 * Yann T.
 *
 * status_led.c
 *
 * LEDs, driven through the DK library by their index in the devicetree 'leds' node.
 *
 * The RGB LED shows its state as a short flash every few seconds rather than solid colors,
 * and stops after CONFIG_HACOAP_STATUS_LED_TIMEOUT_S: a solid LED would draw more current
 * than the rest of the board in sleep.
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
#define FLASH_ON_MS 20            // on time of each status flash
#define FLASH_PERIOD_MS 5000      // time between status flashes

static struct k_spinlock lock;
static enum status_led_state shown_state = STATUS_LED_OFF; // protected by 'lock'
static bool error_shown;                                   // red added to the flash, protected by 'lock'
static int64_t flash_until_ms;                             // uptime to stop flashing at, protected by 'lock'

static void rgb_set(bool red, bool green, bool blue)
{
	dk_set_led(RED_LED, red);
	dk_set_led(GREEN_LED, green);
	dk_set_led(BLUE_LED, blue);
}

/* Ends a flash (timer callback, in interrupt context). */
static void on_flash_off_timer(struct k_timer *timer)
{
	ARG_UNUSED(timer);
	rgb_set(false, false, false);
}

static K_TIMER_DEFINE(flash_off_timer, on_flash_off_timer, NULL);

/* Starts a flash in the colors of the current state (timer callback, in interrupt context). */
static void on_flash_timer(struct k_timer *timer)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	enum status_led_state state = shown_state;
	bool error = error_shown;
	bool expired = (CONFIG_HACOAP_STATUS_LED_TIMEOUT_S > 0) && (k_uptime_get() >= flash_until_ms);

	k_spin_unlock(&lock, key);

	if (expired)
	{
		k_timer_stop(timer);
		return;
	}

	rgb_set(error || (state == STATUS_LED_NO_NETWORK) || (state == STATUS_LED_FAULT),
		state == STATUS_LED_NO_NETWORK, state == STATUS_LED_SRP_PENDING);
	k_timer_start(&flash_off_timer, K_MSEC(FLASH_ON_MS), K_NO_WAIT);
}

static K_TIMER_DEFINE(flash_timer, on_flash_timer, NULL);

/* Sets what the flashes show, and restarts them (and their timeout) if there is anything to show. */
static void flash_update(enum status_led_state state, bool error)
{
	k_spinlock_key_t key = k_spin_lock(&lock);

	shown_state = state;
	error_shown = error;
	flash_until_ms = k_uptime_get() + (CONFIG_HACOAP_STATUS_LED_TIMEOUT_S * MSEC_PER_SEC);
	k_spin_unlock(&lock, key);

	if ((state == STATUS_LED_OFF) && !error)
	{
		k_timer_stop(&flash_timer);
		k_timer_stop(&flash_off_timer);
		rgb_set(false, false, false);
	}
	else
	{
		k_timer_start(&flash_timer, K_NO_WAIT, K_MSEC(FLASH_PERIOD_MS));
	}
}

int status_led_init(void)
{
	return dk_leds_init();
}

void status_led_show(enum status_led_state state)
{
	flash_update(state, false);
}

void status_led_error(void)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	enum status_led_state state = shown_state;

	k_spin_unlock(&lock, key);
	flash_update(state, true);
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
	status_led_error();
}

void status_led_boot(bool on)
{
	dk_set_led(GREEN_LED, on);
}

void status_led_user(bool on)
{
	dk_set_led(USER_LED, on);
}
