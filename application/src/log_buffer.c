/*
 * Yann T.
 *
 * log_buffer.c
 *
 * The latest log output in a ring buffer, read by offset (see log_buffer.h). Written from
 * the logging thread, read from the OpenThread thread.
 */

#include <zephyr/kernel.h>
#include <zephyr/random/rand32.h>
#include <zephyr/sys/util.h>
#include <stdio.h>

#include "log_buffer.h"

#define RING_SIZE CONFIG_HACOAP_REMOTE_LOG_BUFFER_SIZE

static struct k_spinlock lock;
static uint8_t ring[RING_SIZE];
static uint32_t written; // bytes written since boot; ring[written % RING_SIZE] is the next one
static uint32_t boot_id;

void log_buffer_write(const uint8_t *data, size_t length)
{
	k_spinlock_key_t key = k_spin_lock(&lock);

	for (size_t i = 0U; i < length; i++)
	{
		ring[(written + i) % RING_SIZE] = data[i];
	}
	written += length;

	k_spin_unlock(&lock, key);
}

size_t log_buffer_read(uint32_t from, char *payload, size_t size)
{
	k_spinlock_key_t key;
	uint32_t oldest;
	uint32_t start;
	size_t count;
	int header;

	/* Drawn at the first read rather than at boot, when the entropy source may not be ready.
	 * Never 0, which stands for "not drawn yet". */
	if (boot_id == 0U)
	{
		boot_id = sys_rand32_get() | 1U;
	}

	key = k_spin_lock(&lock);

	oldest = (written > RING_SIZE) ? (written - RING_SIZE) : 0U;
	start = ((from < oldest) || (from > written)) ? oldest : from;

	header = snprintf(payload, size, "%08x %u\n", (unsigned int)boot_id, (unsigned int)start);
	if ((header < 0) || ((size_t)header >= size))
	{
		k_spin_unlock(&lock, key);
		return 0U;
	}

	count = MIN((size_t)(written - start), size - (size_t)header);
	for (size_t i = 0U; i < count; i++)
	{
		payload[header + i] = (char)ring[(start + i) % RING_SIZE];
	}

	k_spin_unlock(&lock, key);

	return (size_t)header + count;
}
