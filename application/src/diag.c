/*
 * Yann T.
 *
 * diag.c
 *
 * Restart and crash records, and the 'diag' payload (see diag.h).
 *
 * The crash record is written by the fatal error handler (which replaces the SDK's,
 * CONFIG_RESET_ON_FATAL_ERROR=n) into RAM that is not cleared at boot, then the device
 * resets: the next boot finds it there. RAM keeps its content through a software reset, so
 * the record survives; a power loss clears it, and a magic value and a check word tell.
 */

#include <zephyr/drivers/hwinfo.h>
#include <zephyr/fatal.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/sys/reboot.h>
#include <openthread/thread.h>
#include <stdio.h>
#include <string.h>

#include "device_settings.h"
#include "diag.h"

LOG_MODULE_DECLARE(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

#define CRASH_MAGIC 0x48434352U // "HCCR"

struct crash_record
{
	uint32_t magic;
	uint32_t reason; // K_ERR_* (zephyr/fatal_types.h)
	uint32_t pc;     // where it happened
	uint32_t check;  // magic ^ reason ^ pc
};

static __noinit struct crash_record crash; // written just before a reset, read at the next boot

static enum diag_reset reset_cause;
static bool crashed;
static struct crash_record last_crash;

static const char *const reset_names[] = {
	[DIAG_RESET_POWER] = "power",
	[DIAG_RESET_PIN] = "pin",
	[DIAG_RESET_SOFT] = "soft",
	[DIAG_RESET_WATCHDOG] = "watchdog",
	[DIAG_RESET_LOCKUP] = "lockup",
	[DIAG_RESET_CRASH] = "crash",
	[DIAG_RESET_OTHER] = "other",
};

static const char *const role_names[] = {"disabled", "detached", "child", "router", "leader"};

void k_sys_fatal_error_handler(unsigned int reason, const z_arch_esf_t *esf)
{
	crash.magic = CRASH_MAGIC;
	crash.reason = reason;
	crash.pc = (esf != NULL) ? esf->basic.pc : 0U;
	crash.check = crash.magic ^ crash.reason ^ crash.pc;

	LOG_PANIC();
	LOG_ERR("Fatal error %u at 0x%08x: resetting", reason, (unsigned int)crash.pc);
	sys_reboot(SYS_REBOOT_COLD);
}

/* The most telling cause among the hardware's reset reasons */
static enum diag_reset cause_from_hwinfo(uint32_t flags)
{
	if (flags & RESET_WATCHDOG)
	{
		return DIAG_RESET_WATCHDOG;
	}
	if (flags & RESET_CPU_LOCKUP)
	{
		return DIAG_RESET_LOCKUP;
	}
	if (flags & RESET_SOFTWARE)
	{
		return DIAG_RESET_SOFT;
	}
	if (flags & RESET_PIN)
	{
		return DIAG_RESET_PIN;
	}
	if ((flags == 0U) || (flags & (RESET_POR | RESET_BROWNOUT)))
	{
		return DIAG_RESET_POWER;
	}
	return DIAG_RESET_OTHER;
}

void diag_init(void)
{
	uint32_t flags = 0U;
	int err;

	if (hwinfo_get_reset_cause(&flags) != 0)
	{
		flags = 0U;
	}
	(void)hwinfo_clear_reset_cause(); // the reasons add up until cleared

	crashed = (crash.magic == CRASH_MAGIC) && (crash.check == (crash.magic ^ crash.reason ^ crash.pc));
	if (crashed)
	{
		last_crash = crash;
	}
	memset(&crash, 0, sizeof(crash));

	reset_cause = crashed ? DIAG_RESET_CRASH : cause_from_hwinfo(flags);

	err = device_settings_count_boot();
	if (err != 0)
	{
		LOG_ERR("Could not store the boot count (%d)", err);
	}

	if (crashed)
	{
		LOG_WRN("Boot %u, after a crash: fatal error %u at 0x%08x", device_settings_boots(),
			last_crash.reason, (unsigned int)last_crash.pc);
	}
	else
	{
		LOG_INF("Boot %u, reset cause: %s (0x%x)", device_settings_boots(), reset_names[reset_cause],
			(unsigned int)flags);
	}
}

enum diag_reset diag_reset_cause(void)
{
	return reset_cause;
}

const char *diag_reset_name(enum diag_reset cause)
{
	return ((unsigned int)cause < ARRAY_SIZE(reset_names)) ? reset_names[cause] : "other";
}

void diag_link_read(otInstance *instance, struct diag_link *link)
{
	otDeviceRole role = otThreadGetDeviceRole(instance);
	otRouterInfo parent;

	memset(link, 0, sizeof(*link));
	link->role = ((unsigned int)role < ARRAY_SIZE(role_names)) ? role_names[role] : "unknown";
	link->attached = (role == OT_DEVICE_ROLE_CHILD) || (role == OT_DEVICE_ROLE_ROUTER) ||
			 (role == OT_DEVICE_ROLE_LEADER);
	if (!link->attached)
	{
		return;
	}

	link->rloc16 = otThreadGetRloc16(instance);
	if (otThreadGetParentInfo(instance, &parent) == OT_ERROR_NONE)
	{
		link->parent_rloc16 = parent.mRloc16;
		link->link_quality = parent.mLinkQualityIn;
	}
	(void)otThreadGetParentAverageRssi(instance, &link->parent_rssi);
	(void)otThreadGetParentLastRssi(instance, &link->last_rssi);
}

size_t diag_format(char *payload, size_t size, const struct diag_link *link, int32_t soil_mv)
{
	size_t length = 0U;
	int written;

#define APPEND(...)                                                                           \
	do                                                                                    \
	{                                                                                     \
		written = snprintf(&payload[length], size - length, __VA_ARGS__);             \
		if ((written < 0) || ((size_t)written >= size - length))                      \
		{                                                                             \
			return length;                                                        \
		}                                                                             \
		length += (size_t)written;                                                    \
	} while (0)

	if (size == 0U)
	{
		return 0U;
	}
	payload[0] = '\0';

	APPEND("boots=%u,up=%u,reset=%s", (unsigned int)device_settings_boots(),
	       (unsigned int)(k_uptime_get() / MSEC_PER_SEC), diag_reset_name(reset_cause));
	if (crashed)
	{
		APPEND(",fault=%u@%08x", (unsigned int)last_crash.reason, (unsigned int)last_crash.pc);
	}
	APPEND(",role=%s", link->role);
	if (link->attached)
	{
		APPEND(",rloc=%04x,parent=%04x,rssi=%d,last_rssi=%d,lq=%u", link->rloc16, link->parent_rloc16,
		       link->parent_rssi, link->last_rssi, link->link_quality);
	}
	APPEND(",soil_mv=%d", (int)soil_mv);

#undef APPEND

	return length;
}
