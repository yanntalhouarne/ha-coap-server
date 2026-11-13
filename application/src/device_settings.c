/*
 * Yann T.
 *
 * device_settings.c
 *
 * The settings that can change at run time, stored in flash with Zephyr's settings
 * subsystem (see device_settings.h). Read from any thread; written from the mcumgr thread
 * and the OpenThread thread ('pumpdc' PUT), under a lock. A change applies at once, and is
 * stored from the system work queue, so neither thread waits on the flash.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>
#include <zephyr/spinlock.h>
#include <stdio.h>
#include <string.h>

#include "device_settings.h"

LOG_MODULE_DECLARE(coap_server, CONFIG_COAP_SERVER_LOG_LEVEL);

#define SUBTREE "hacoap"
#define BOOTS_NAME "boots"

const struct device_setting_info device_settings_info[SETTING_COUNT] = {
	[SETTING_SAMPLE_S] = {"sample_s", 10, 86400, CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S},
	[SETTING_SOIL_DRY_MV] = {"soil_dry_mv", 1, 3600, CONFIG_HACOAP_SOIL_DRY_MV},
	[SETTING_SOIL_WET_MV] = {"soil_wet_mv", 0, 3599, CONFIG_HACOAP_SOIL_WET_MV},
	[SETTING_PUMP_S] = {"pump_s", 1, CONFIG_HACOAP_PUMP_MAX_DURATION, CONFIG_HACOAP_PUMP_DEFAULT_DURATION},
	[SETTING_POLL_MS] = {"poll_ms", CONFIG_HACOAP_MCUMGR_POLL_PERIOD_MS + 1, 600000, CONFIG_OPENTHREAD_POLL_PERIOD},
};

static struct k_spinlock lock;
static int32_t values[SETTING_COUNT];
static uint32_t dirty; // settings changed but not stored yet (bits), under the lock
static uint32_t boots;
static device_settings_changed_cb on_changed;

static bool in_range(enum device_setting id, int32_t value)
{
	return (value >= device_settings_info[id].min) && (value <= device_settings_info[id].max);
}

int device_setting_find(const char *name, size_t length)
{
	for (int i = 0; i < SETTING_COUNT; i++)
	{
		if ((strlen(device_settings_info[i].name) == length) && (memcmp(device_settings_info[i].name, name, length) == 0))
		{
			return i;
		}
	}
	return -1;
}

/* Settings handler: called by settings_load_subtree() for each stored "hacoap/..." value */
static int on_set(const char *name, size_t length, settings_read_cb read_cb, void *cb_arg)
{
	int32_t value;
	int id;

	if (strcmp(name, BOOTS_NAME) == 0)
	{
		if ((length == sizeof(boots)) && (read_cb(cb_arg, &boots, sizeof(boots)) == sizeof(boots)))
		{
			return 0;
		}
		return -EINVAL;
	}

	id = device_setting_find(name, strlen(name));
	if ((id < 0) || (length != sizeof(value)) || (read_cb(cb_arg, &value, sizeof(value)) != sizeof(value)))
	{
		return 0; // an old or unknown setting: ignored
	}
	if (in_range(id, value))
	{
		values[id] = value;
	}
	return 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(hacoap, SUBTREE, NULL, on_set, NULL, NULL);

static int store(const char *name, const void *value, size_t length)
{
	char key[32];

	snprintf(key, sizeof(key), SUBTREE "/%s", name);
	return settings_save_one(key, value, length);
}

/* Stores the changed settings, from the system work queue */
static void on_store_work(struct k_work *work)
{
	k_spinlock_key_t key;
	uint32_t pending;
	int32_t value;
	int err;

	ARG_UNUSED(work);

	key = k_spin_lock(&lock);
	pending = dirty;
	dirty = 0U;
	k_spin_unlock(&lock, key);

	for (int i = 0; i < SETTING_COUNT; i++)
	{
		if (!(pending & BIT(i)))
		{
			continue;
		}
		value = device_setting_get(i);
		err = store(device_settings_info[i].name, &value, sizeof(value));
		if (err != 0)
		{
			LOG_ERR("Could not store %s (%d)", device_settings_info[i].name, err);
		}
	}
}

static K_WORK_DEFINE(store_work, on_store_work);

int device_settings_init(device_settings_changed_cb changed)
{
	int err;

	on_changed = changed;
	for (int i = 0; i < SETTING_COUNT; i++)
	{
		values[i] = device_settings_info[i].default_value;
	}

	err = settings_subsys_init();
	if (err == 0)
	{
		err = settings_load_subtree(SUBTREE);
	}
	if (err != 0)
	{
		LOG_ERR("Could not load the settings (%d): using the defaults", err);
	}

	/* A calibration stored before the other half changed can end up the wrong way round. */
	if (values[SETTING_SOIL_DRY_MV] <= values[SETTING_SOIL_WET_MV])
	{
		values[SETTING_SOIL_DRY_MV] = device_settings_info[SETTING_SOIL_DRY_MV].default_value;
		values[SETTING_SOIL_WET_MV] = device_settings_info[SETTING_SOIL_WET_MV].default_value;
	}

	for (int i = 0; i < SETTING_COUNT; i++)
	{
		if ((values[i] != device_settings_info[i].default_value) && (on_changed != NULL))
		{
			LOG_INF("Setting %s = %d", device_settings_info[i].name, values[i]);
			on_changed(i, values[i]);
		}
	}

	return err;
}

int32_t device_setting_get(enum device_setting id)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	int32_t value = values[id];

	k_spin_unlock(&lock, key);
	return value;
}

int device_settings_set(const enum device_setting *ids, const int32_t *values_in, size_t count)
{
	int32_t next[SETTING_COUNT];
	bool changed[SETTING_COUNT] = {false};
	k_spinlock_key_t key;

	key = k_spin_lock(&lock);
	memcpy(next, values, sizeof(next));
	k_spin_unlock(&lock, key);

	for (size_t i = 0U; i < count; i++)
	{
		if (((int)ids[i] < 0) || ((int)ids[i] >= SETTING_COUNT) || !in_range(ids[i], values_in[i]))
		{
			return -EINVAL;
		}
		next[ids[i]] = values_in[i];
	}
	if (next[SETTING_SOIL_DRY_MV] <= next[SETTING_SOIL_WET_MV])
	{
		return -EINVAL;
	}

	key = k_spin_lock(&lock);
	for (int i = 0; i < SETTING_COUNT; i++)
	{
		changed[i] = (next[i] != values[i]);
		values[i] = next[i];
		if (changed[i])
		{
			dirty |= BIT(i);
		}
	}
	k_spin_unlock(&lock, key);

	for (int i = 0; i < SETTING_COUNT; i++)
	{
		if (changed[i])
		{
			LOG_INF("Setting %s = %d", device_settings_info[i].name, next[i]);
			if (on_changed != NULL)
			{
				on_changed(i, next[i]);
			}
		}
	}
	k_work_submit(&store_work);

	return 0;
}

uint32_t device_settings_boots(void)
{
	return boots;
}

int device_settings_count_boot(void)
{
	boots++;
	return store(BOOTS_NAME, &boots, sizeof(boots));
}
