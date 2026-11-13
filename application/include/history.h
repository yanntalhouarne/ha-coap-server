/*
 * Yann T.
 *
 * history.h
 *
 * The latest sensor samples, kept in RAM for the 'hist' CoAP resource: the fleet manager reads
 * the ones it doesn't have yet (after its border router or the network was down, or between two
 * of its refreshes), and is sent the new ones that changed (CoAP Observe, see coap_resources.h).
 * Each sample has a sequence number: the samples taken since boot before it. A reader that keeps
 * the 'next' number of each answer and asks from there gets every sample once, as long as it
 * reads before CONFIG_HACOAP_HISTORY_SIZE more are taken. They're lost at a restart (the boot
 * number in each answer tells a reader to start again from 0).
 */

#ifndef HISTORY_H_
#define HISTORY_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* One sample */
struct history_entry
{
	uint32_t uptime_s;   // when, in seconds since boot
	uint8_t soil;        // %
	uint8_t battery;     // %
	uint8_t air;         // %
	int8_t temperature;  // degC
	uint8_t power;       // enum power_source (power.h): 0 battery, 1 usb, 2 charging, 3 charged
};

/* The 'hist' payload, little-endian:
 *
 *     offset  size
 *     0       1     version (HISTORY_VERSION)
 *     1       1     count: the entries that follow
 *     2       2     the size of each entry (HISTORY_ENTRY_SIZE; a newer version may add fields at the end)
 *     4       4     boot: the boot count (device_settings_boots()), new at every boot
 *     8       4     the device's uptime now (s): an entry's time is now - (uptime now - its uptime)
 *     12      4     first: the sequence number of the first entry
 *     16      4     next: the sequence number of the next sample to be taken
 *     20      ...   the entries: uptime (s, 4 bytes), soil, battery, air humidity, temperature (signed), power
 */
#define HISTORY_VERSION 1
#define HISTORY_HEADER_SIZE 20
#define HISTORY_ENTRY_SIZE 9

/* Adds a sample. The oldest is overwritten once CONFIG_HACOAP_HISTORY_SIZE are kept. */
void history_add(const struct history_entry *entry);

/* The sequence number of the next sample (the samples taken since boot). */
uint32_t history_next(void);

/* Copies the sample with sequence number 'seq'. Returns false if it isn't kept (overwritten, or
 * not taken yet). */
bool history_get(uint32_t seq, struct history_entry *entry);

/* Writes the 'hist' payload for a reader that has every sample before 'from': the samples from
 * 'from' on (from the oldest kept when 'from' was overwritten, or is ahead of them: a reader from
 * before a restart), as many as fit in 'size'. Sets '*next' to the sequence number after the last
 * one written. Returns the payload's length (0 if 'size' can't hold the header). */
size_t history_read(uint32_t from, uint32_t boot, uint32_t uptime_s, uint8_t *payload, size_t size, uint32_t *next);

/* Whether a sample differs enough from the last one the fleet manager was given to be sent to it
 * now: its soil or battery by CONFIG_HACOAP_PUSH_SOIL_DELTA or CONFIG_HACOAP_PUSH_BATTERY_DELTA %
 * or more, or its power source. */
bool history_push_wanted(const struct history_entry *given, const struct history_entry *sample);

#endif // HISTORY_H_
