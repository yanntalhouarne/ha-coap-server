/*
 * Yann T.
 *
 * watchdog.c
 *
 * Resets the SoC if the system work queue stops running.
 *
 * The nRF52 watchdog keeps running across soft resets: after an update, it's still counting
 * down from the previous image's last feed, through the bootloader's swap. So it's fed before
 * the kernel starts, and set up before main's boot delay. That isn't enough on the boards:
 * an image started while the watchdog runs gets stuck before main (HACOAP_BOOT_PROBE), and only
 * starts cleanly after the watchdog reset; see 'permanent' updates in the fleet manager.
 */

#include <zephyr/drivers/watchdog.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <hal/nrf_wdt.h>

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

/* The first thing after a reset: a watchdog still running from before gets a full timeout
 * again (every reload register: whichever channels the previous image enabled). */
static bool running_at_boot;

bool watchdog_was_running_at_boot(void)
{
	return running_at_boot;
}

static int watchdog_early_feed(void)
{
	running_at_boot = nrf_wdt_started(NRF_WDT);
	if (running_at_boot)
	{
		for (uint32_t i = 0U; i < NRF_WDT_CHANNEL_NUMBER; i++)
		{
			nrf_wdt_reload_request_set(NRF_WDT, (nrf_wdt_rr_register_t)(NRF_WDT_RR0 + i));
		}
	}
	return 0;
}

SYS_INIT(watchdog_early_feed, PRE_KERNEL_1, 0);

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
