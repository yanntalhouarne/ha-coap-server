/*
 * Yann T.
 *
 * watchdog.c
 *
 * Resets the SoC if the system work queue stops running.
 */

#include <zephyr/drivers/watchdog.h>
#include <zephyr/kernel.h>

#include "watchdog.h"

BUILD_ASSERT(CONFIG_HACOAP_WDT_FEED_PERIOD_MS < CONFIG_HACOAP_WDT_TIMEOUT_MS,
	     "The watchdog must be fed more often than its timeout");

static const struct device *const wdt_dev = DEVICE_DT_GET(DT_ALIAS(watchdog0));
static int wdt_channel;

/* Feeds the watchdog and schedules the next feed. */
static void on_wdt_feed_work(struct k_work *work)
{
	wdt_feed(wdt_dev, wdt_channel);
	k_work_schedule(k_work_delayable_from_work(work), K_MSEC(CONFIG_HACOAP_WDT_FEED_PERIOD_MS));
}

static K_WORK_DELAYABLE_DEFINE(wdt_feed_work, on_wdt_feed_work);

int watchdog_init(void)
{
	struct wdt_timeout_cfg wdt_config = {
		.window.min = 0U,
		.window.max = CONFIG_HACOAP_WDT_TIMEOUT_MS,
		.callback = NULL,
		.flags = WDT_FLAG_RESET_SOC,
	};
	int err;

	if (!device_is_ready(wdt_dev))
	{
		return -ENODEV;
	}
	wdt_channel = wdt_install_timeout(wdt_dev, &wdt_config);
	if (wdt_channel < 0)
	{
		return wdt_channel;
	}
	err = wdt_setup(wdt_dev, WDT_OPT_PAUSE_HALTED_BY_DBG);
	if (err != 0)
	{
		return err;
	}

	/* The nRF52 watchdog keeps running across soft resets (e.g. mcumgr reset), so it may
	 * already be counting down from the previous image: feed it right away. */
	wdt_feed(wdt_dev, wdt_channel);
	k_work_schedule(&wdt_feed_work, K_MSEC(CONFIG_HACOAP_WDT_FEED_PERIOD_MS));

	return 0;
}
