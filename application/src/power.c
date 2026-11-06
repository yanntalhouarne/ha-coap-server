/*
 * Yann T.
 *
 * power.c
 *
 * Where the board's power comes from (see power.h). USB power is the nRF52840's own VBUS
 * detection; whether the battery is charging is the STC4054's CHRG output (P1.10, low while
 * charging, open drain with a pull-up). Both are read every CONFIG_HACOAP_POWER_CHECK_S
 * seconds from the system work queue: a few register reads, a negligible cost next to a
 * Thread poll, and simpler than interrupts on both.
 */

#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <hal/nrf_power.h>

#include "power.h"

LOG_MODULE_DECLARE(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

static const struct gpio_dt_spec charging_gpio = GPIO_DT_SPEC_GET(DT_ALIAS(charging), gpios); // P1.10, STC4054 CHRG

static const char *const names[] = {
	[POWER_BATTERY] = "battery",
	[POWER_USB] = "usb",
	[POWER_CHARGING] = "charging",
	[POWER_CHARGED] = "charged",
};

static bool charging_pin_ok;
static atomic_t current = ATOMIC_INIT(POWER_BATTERY); // read from the OpenThread thread ('diag')
static power_changed_cb_t changed_cb;

static enum power_source read_source(void)
{
	int charging;

	if (!nrf_power_usbregstatus_vbusdet_get(NRF_POWER))
	{
		return POWER_BATTERY;
	}
	if (!charging_pin_ok)
	{
		return POWER_USB;
	}
	charging = gpio_pin_get_dt(&charging_gpio); // active low in the devicetree: 1 while charging
	if (charging < 0)
	{
		return POWER_USB;
	}
	return charging ? POWER_CHARGING : POWER_CHARGED;
}

static void on_check(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(check_work, on_check);

static void on_check(struct k_work *work)
{
	enum power_source source = read_source();

	ARG_UNUSED(work);

	if (source != (enum power_source)atomic_get(&current))
	{
		atomic_set(&current, source);
		LOG_INF("Power: %s", names[source]);
		if (changed_cb != NULL)
		{
			changed_cb(source);
		}
	}
	k_work_schedule(&check_work, K_SECONDS(CONFIG_HACOAP_POWER_CHECK_S));
}

int power_init(power_changed_cb_t on_changed)
{
	int err = 0;

	changed_cb = on_changed;
	charging_pin_ok = false;
	if (!gpio_is_ready_dt(&charging_gpio))
	{
		err = -ENODEV;
	}
	else
	{
		/* The pull-up only draws current while the charger holds the pin low (on USB) */
		err = gpio_pin_configure_dt(&charging_gpio, GPIO_INPUT);
		charging_pin_ok = (err == 0);
	}
	if (err != 0)
	{
		LOG_ERR("Could not read the charger's CHRG pin (error: %d)", err);
	}

	atomic_set(&current, POWER_BATTERY);
	on_check(&check_work.work); // the first check now, the next ones from the work queue
	return err;
}

enum power_source power_source(void)
{
	return (enum power_source)atomic_get(&current);
}

const char *power_name(enum power_source source)
{
	return ((unsigned int)source < ARRAY_SIZE(names)) ? names[source] : "unknown";
}
