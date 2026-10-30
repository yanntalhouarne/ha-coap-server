/*
 * Yann T.
 *
 * device_settings.h
 *
 * Settings that can change without a new firmware: kept in flash (Zephyr's settings
 * subsystem, under "hacoap/"), with the Kconfig values as defaults. The fleet manager reads
 * and writes them through the 'hacoap' mcumgr group (hacoap_mgmt.c).
 */

#ifndef DEVICE_SETTINGS_H_
#define DEVICE_SETTINGS_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum device_setting
{
	SETTING_SAMPLE_S,    // sensor sampling period (s)
	SETTING_SOIL_DRY_MV, // soil sensor output when dry (mV): 0 %
	SETTING_SOIL_WET_MV, // soil sensor output when wet (mV): 100 %
	SETTING_PUMP_S,      // pump run time (s)
	SETTING_POLL_MS,     // Thread poll period (ms)
	SETTING_COUNT,
};

struct device_setting_info
{
	const char *name; // stored as "hacoap/<name>"; also the name in mcumgr requests
	int32_t min;
	int32_t max;
	int32_t default_value;
};

extern const struct device_setting_info device_settings_info[SETTING_COUNT];

/* Called after a setting changed (at load too), to apply it. */
typedef void (*device_settings_changed_cb)(enum device_setting id, int32_t value);

/* Loads the stored settings (the defaults for any not stored, or out of range). 'changed'
 * is called for each setting that differs from its default, and after every later change. */
int device_settings_init(device_settings_changed_cb changed);

int32_t device_setting_get(enum device_setting id);

/* The setting called 'name', or -1. */
int device_setting_find(const char *name, size_t length);

/* Sets several settings at once: all of them, or none if one is out of range or the soil
 * calibration would end up with dry at or below wet. They apply at once, and are stored from
 * the system work queue. Returns 0, or -EINVAL (nothing changed). */
int device_settings_set(const enum device_setting *ids, const int32_t *values, size_t count);

/* Number of boots, kept with the settings (diag.c counts them). */
uint32_t device_settings_boots(void);
int device_settings_count_boot(void);

#endif // DEVICE_SETTINGS_H_
