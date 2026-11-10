/*
 * Yann T.
 *
 * history.c
 *
 * The latest sensor samples in a ring, read by sequence number (see history.h). Written from the
 * system work queue (after each sample), read from the OpenThread thread ('hist').
 */

#include <zephyr/kernel.h>
#include <zephyr/spinlock.h>
#include <zephyr/sys/util.h>
#include <stdlib.h>
#include <string.h>

#include "history.h"

#define RING_SIZE CONFIG_HACOAP_HISTORY_SIZE

static struct k_spinlock lock;
static struct history_entry ring[RING_SIZE];
static uint32_t added; // samples added since boot; ring[added % RING_SIZE] is the next one

static void put_u16(uint8_t *at, uint16_t value)
{
	at[0] = (uint8_t)value;
	at[1] = (uint8_t)(value >> 8);
}

static void put_u32(uint8_t *at, uint32_t value)
{
	for (int i = 0; i < 4; i++)
	{
		at[i] = (uint8_t)(value >> (8 * i));
	}
}

void history_add(const struct history_entry *entry)
{
	k_spinlock_key_t key = k_spin_lock(&lock);

	ring[added % RING_SIZE] = *entry;
	added++;

	k_spin_unlock(&lock, key);
}

uint32_t history_next(void)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	uint32_t next = added;

	k_spin_unlock(&lock, key);
	return next;
}

static uint32_t oldest_kept(void)
{
	return (added > RING_SIZE) ? (added - RING_SIZE) : 0U;
}

bool history_get(uint32_t seq, struct history_entry *entry)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	bool kept = (seq >= oldest_kept()) && (seq < added);

	if (kept)
	{
		*entry = ring[seq % RING_SIZE];
	}
	k_spin_unlock(&lock, key);
	return kept;
}

size_t history_read(uint32_t from, uint32_t boot, uint32_t uptime_s, uint8_t *payload, size_t size, uint32_t *next)
{
	k_spinlock_key_t key;
	uint32_t oldest;
	uint32_t start;
	size_t count;

	if (size < HISTORY_HEADER_SIZE)
	{
		return 0U;
	}

	key = k_spin_lock(&lock);

	oldest = oldest_kept();
	start = ((from < oldest) || (from > added)) ? oldest : from;
	count = MIN((size_t)(added - start), (size - HISTORY_HEADER_SIZE) / HISTORY_ENTRY_SIZE);
	count = MIN(count, (size_t)UINT8_MAX);

	payload[0] = HISTORY_VERSION;
	payload[1] = (uint8_t)count;
	put_u16(&payload[2], HISTORY_ENTRY_SIZE);
	put_u32(&payload[4], boot);
	put_u32(&payload[8], uptime_s);
	put_u32(&payload[12], start);
	put_u32(&payload[16], added);
	for (size_t i = 0U; i < count; i++)
	{
		const struct history_entry *entry = &ring[(start + i) % RING_SIZE];
		uint8_t *at = &payload[HISTORY_HEADER_SIZE + i * HISTORY_ENTRY_SIZE];

		put_u32(at, entry->uptime_s);
		at[4] = entry->soil;
		at[5] = entry->battery;
		at[6] = entry->air;
		at[7] = (uint8_t)entry->temperature;
		at[8] = entry->power;
	}
	*next = start + (uint32_t)count;

	k_spin_unlock(&lock, key);

	return HISTORY_HEADER_SIZE + count * HISTORY_ENTRY_SIZE;
}

bool history_push_wanted(const struct history_entry *given, const struct history_entry *sample)
{
	return (abs((int)sample->soil - (int)given->soil) >= CONFIG_HACOAP_PUSH_SOIL_DELTA) ||
	       (abs((int)sample->battery - (int)given->battery) >= CONFIG_HACOAP_PUSH_BATTERY_DELTA) ||
	       (sample->power != given->power);
}
