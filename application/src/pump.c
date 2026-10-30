/*
 * Yann T.
 *
 * pump.c
 *
 * Water pump control: a timed run, started by CoAP or by the S1 button.
 */

#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>

#include "buzzer.h"
#include "pump.h"
#include "status_led.h"

LOG_MODULE_DECLARE(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

#define PUMP_MIN_DURATION 1 // in seconds

/* User button (S1). This is mandatory. */
#define USRBUTTON_NODE DT_ALIAS(usrbutton)
#if !DT_NODE_HAS_STATUS(USRBUTTON_NODE, okay)
#error "Unsupported board: usrbutton devicetree alias is not defined"
#endif

static const struct gpio_dt_spec pump_gpio = GPIO_DT_SPEC_GET(DT_ALIAS(pump1), gpios); // IO 0_17, Q1 gate (pump on J2)
static const struct gpio_dt_spec usr_button = GPIO_DT_SPEC_GET(USRBUTTON_NODE, gpios);
static struct gpio_callback usr_button_cb_data;

static atomic_t running;
static uint8_t duration_s = CONFIG_HACOAP_PUMP_DEFAULT_DURATION;

/* Turns the pump and the user LED on or off. */
static void pump_set(bool on)
{
	atomic_set(&running, on ? 1 : 0);
	gpio_pin_set_dt(&pump_gpio, on ? 1 : 0);
	status_led_user(on);
}

/* The pump has run for 'duration_s' seconds. */
static void on_pump_timer_expiry(struct k_timer *timer)
{
	ARG_UNUSED(timer);

	pump_set(false);
}

K_TIMER_DEFINE(pump_timer, on_pump_timer_expiry, NULL);

void pump_start(void)
{
	/* Restart the timer first, so an expiry of the previous run cannot turn the pump back off. */
	k_timer_start(&pump_timer, K_SECONDS(duration_s), K_NO_WAIT);
	pump_set(true);
	buzzer_play(BUZZER_PUMP);
}

void pump_stop(void)
{
	k_timer_stop(&pump_timer);
	pump_set(false);
}

bool pump_is_running(void)
{
	return atomic_get(&running) != 0;
}

bool pump_button_pressed(void)
{
	return gpio_pin_get_dt(&usr_button) > 0;
}

uint8_t pump_get_duration(void)
{
	return duration_s;
}

bool pump_set_duration(uint8_t seconds)
{
	if ((seconds < PUMP_MIN_DURATION) || (seconds > CONFIG_HACOAP_PUMP_MAX_DURATION))
	{
		return false;
	}
	duration_s = seconds;

	return true;
}

/* Starts the pump from the system work queue (not from the button interrupt). */
static void on_usr_button_work(struct k_work *work)
{
	ARG_UNUSED(work);

	pump_start();
}

static K_WORK_DEFINE(usr_button_work, on_usr_button_work);

/* Called when S1 is pressed. */
static void on_usr_button_changed(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(cb);
	ARG_UNUSED(pins);

	k_work_submit(&usr_button_work);
}

int pump_init(void)
{
	int ret;

	if (!gpio_is_ready_dt(&pump_gpio) || !gpio_is_ready_dt(&usr_button))
	{
		return -ENODEV;
	}
	ret = gpio_pin_configure_dt(&pump_gpio, GPIO_OUTPUT_INACTIVE);
	if (ret != 0)
	{
		return ret;
	}

	ret = gpio_pin_configure_dt(&usr_button, GPIO_INPUT);
	if (ret != 0)
	{
		return ret;
	}
	ret = gpio_pin_interrupt_configure_dt(&usr_button, GPIO_INT_EDGE_TO_ACTIVE);
	if (ret != 0)
	{
		return ret;
	}
	gpio_init_callback(&usr_button_cb_data, on_usr_button_changed, BIT(usr_button.pin));
	ret = gpio_add_callback(usr_button.port, &usr_button_cb_data);
	if (ret != 0)
	{
		return ret;
	}
	LOG_INF("Set up user button at %s pin %d", usr_button.port->name, usr_button.pin);

	return 0;
}
