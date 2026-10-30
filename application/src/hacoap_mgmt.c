/*
 * Yann T.
 *
 * hacoap_mgmt.c
 *
 * The 'hacoap' mcumgr group (64), over USB and over the air like the other mcumgr groups:
 *
 *   command 0, read:  {"settings": {"<name>": [value, default, min, max], ...},
 *                      "soil_mv": <latest soil sensor output, mV>, "samples": <samples since boot>}
 *   command 0, write: {"set": {"<name>": value, ...}}: changes and stores them, all or none,
 *                     and answers like a read. MGMT_ERR_EINVAL (nothing changed) for an unknown
 *                     name, a value out of range, or a soil calibration with dry at or below wet.
 *   command 1, write: {}: takes a sensor sample now. {"samples": <the count before it>}: read
 *                     command 0 until 'samples' is higher for the new 'soil_mv'.
 *   command 2, write: {}: forgets the Thread network and resets a second later (joining.h): the
 *                     device then joins again, with a commissioner. Answers {} first.
 *
 * Settings: see device_settings.h.
 */

#include <string.h> // before zcbor_encode.h, which uses strlen()
#include <zephyr/mgmt/mcumgr/mgmt/mgmt.h>
#include <zephyr/mgmt/mcumgr/smp/smp.h>
#include <mgmt/mcumgr/util/zcbor_bulk.h>
#include <zcbor_common.h>
#include <zcbor_decode.h>
#include <zcbor_encode.h>

#include "device_settings.h"
#include "hacoap_mgmt.h"
#include "joining.h"
#include "sensors.h"

#define HACOAP_MGMT_ID_SETTINGS 0
#define HACOAP_MGMT_ID_SAMPLE 1
#define HACOAP_MGMT_ID_FORGET_NETWORK 2
#define FORGET_DELAY_MS 1000 // the answer goes out first

struct settings_change
{
	enum device_setting ids[SETTING_COUNT];
	int32_t values[SETTING_COUNT];
	size_t count;
	bool unknown; // a name that isn't a setting, or one given twice
};

static bool encode_settings(zcbor_state_t *zse)
{
	struct sensors_data data = sensors_get();
	bool ok;

	ok = zcbor_tstr_put_lit(zse, "settings") && zcbor_map_start_encode(zse, SETTING_COUNT);
	for (int i = 0; ok && (i < SETTING_COUNT); i++)
	{
		const struct device_setting_info *info = &device_settings_info[i];

		ok = zcbor_tstr_put_term(zse, info->name) && zcbor_list_start_encode(zse, 4) &&
		     zcbor_int32_put(zse, device_setting_get(i)) && zcbor_int32_put(zse, info->default_value) &&
		     zcbor_int32_put(zse, info->min) && zcbor_int32_put(zse, info->max) && zcbor_list_end_encode(zse, 4);
	}
	return ok && zcbor_map_end_encode(zse, SETTING_COUNT) && zcbor_tstr_put_lit(zse, "soil_mv") &&
	       zcbor_int32_put(zse, data.soil_mv) && zcbor_tstr_put_lit(zse, "samples") &&
	       zcbor_uint32_put(zse, data.samples);
}

static int settings_read(struct smp_streamer *ctxt)
{
	return encode_settings(ctxt->writer->zs) ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

/* zcbor decoder for the "set" map: {"<name>": value, ...} */
static bool decode_set(zcbor_state_t *zsd, void *result)
{
	struct settings_change *change = result;
	struct zcbor_string key;
	int32_t value;
	int id;

	if (!zcbor_map_start_decode(zsd))
	{
		return false;
	}
	/* Like zcbor_map_decode_bulk(): the key fails to decode at the end of the map. */
	while (zcbor_tstr_decode(zsd, &key))
	{
		if (!zcbor_int32_decode(zsd, &value))
		{
			return false;
		}
		id = device_setting_find((const char *)key.value, key.len);
		if (id < 0)
		{
			change->unknown = true;
			continue;
		}
		for (size_t i = 0U; i < change->count; i++)
		{
			change->unknown |= (change->ids[i] == (enum device_setting)id);
		}
		if (change->count < SETTING_COUNT)
		{
			change->ids[change->count] = id;
			change->values[change->count] = value;
			change->count++;
		}
	}
	return zcbor_map_end_decode(zsd);
}

static int settings_write(struct smp_streamer *ctxt)
{
	struct settings_change change = {0};
	struct zcbor_map_decode_key_val request[] = {
		ZCBOR_MAP_DECODE_KEY_DECODER("set", decode_set, &change),
	};
	size_t matched = 0U;

	if ((zcbor_map_decode_bulk(ctxt->reader->zs, request, ARRAY_SIZE(request), &matched) != 0) ||
	    (matched != 1U) || change.unknown)
	{
		return MGMT_ERR_EINVAL;
	}
	if (device_settings_set(change.ids, change.values, change.count) != 0)
	{
		return MGMT_ERR_EINVAL;
	}
	return settings_read(ctxt);
}

static int sample_write(struct smp_streamer *ctxt)
{
	uint32_t samples = sensors_get().samples;

	sensors_sample_now();
	return (zcbor_tstr_put_lit(ctxt->writer->zs, "samples") && zcbor_uint32_put(ctxt->writer->zs, samples))
		       ? MGMT_ERR_EOK
		       : MGMT_ERR_EMSGSIZE;
}

static int forget_network_write(struct smp_streamer *ctxt)
{
	ARG_UNUSED(ctxt);

	joining_forget(FORGET_DELAY_MS);
	return MGMT_ERR_EOK;
}

static const struct mgmt_handler handlers[] = {
	[HACOAP_MGMT_ID_SETTINGS] = {.mh_read = settings_read, .mh_write = settings_write},
	[HACOAP_MGMT_ID_SAMPLE] = {.mh_read = NULL, .mh_write = sample_write},
	[HACOAP_MGMT_ID_FORGET_NETWORK] = {.mh_read = NULL, .mh_write = forget_network_write},
};

static struct mgmt_group group = {
	.mg_handlers = handlers,
	.mg_handlers_count = ARRAY_SIZE(handlers),
	.mg_group_id = HACOAP_MGMT_GROUP,
};

void hacoap_mgmt_init(void)
{
	mgmt_register_group(&group);
}
