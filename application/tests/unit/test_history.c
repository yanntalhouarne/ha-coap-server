/*
 * test_history.c
 *
 * The latest samples, read by sequence number, and which ones to push (src/history.c).
 */

#include "test.h"

#include "../../src/history.c"

static uint8_t payload[600];

static void reset_module(void)
{
	memset(ring, 0, sizeof(ring));
	added = 0U;
}

static struct history_entry sample(uint32_t uptime_s, uint8_t soil)
{
	return (struct history_entry){.uptime_s = uptime_s, .soil = soil, .battery = 80, .air = 50, .temperature = -4, .power = 2};
}

static void add_samples(uint32_t count)
{
	for (uint32_t i = 0U; i < count; i++)
	{
		struct history_entry entry = sample(900U * (i + 1U), (uint8_t)(i % 100U));

		history_add(&entry);
	}
}

static uint32_t u32_at(size_t offset)
{
	return (uint32_t)payload[offset] | ((uint32_t)payload[offset + 1] << 8) | ((uint32_t)payload[offset + 2] << 16) |
	       ((uint32_t)payload[offset + 3] << 24);
}

static void test_an_empty_history_has_only_the_header(void)
{
	uint32_t next = 99U;

	reset_module();
	CHECK_EQ(history_read(0, 7, 120, payload, sizeof(payload), &next), HISTORY_HEADER_SIZE);
	CHECK_EQ(payload[0], HISTORY_VERSION);
	CHECK_EQ(payload[1], 0);
	CHECK_EQ(payload[2] | (payload[3] << 8), HISTORY_ENTRY_SIZE);
	CHECK_EQ(u32_at(4), 7);    // boot
	CHECK_EQ(u32_at(8), 120);  // uptime now
	CHECK_EQ(u32_at(12), 0);   // first
	CHECK_EQ(u32_at(16), 0);   // next
	CHECK_EQ(next, 0);
	CHECK_EQ(history_next(), 0);
	CHECK_EQ(lock.locked, 0);
}

static void test_reads_the_samples_from_a_sequence_number(void)
{
	struct history_entry entry;
	uint32_t next;
	size_t length;

	reset_module();
	add_samples(3);
	length = history_read(1, 7, 3000, payload, sizeof(payload), &next);
	CHECK_EQ(length, HISTORY_HEADER_SIZE + 2 * HISTORY_ENTRY_SIZE);
	CHECK_EQ(payload[1], 2);
	CHECK_EQ(u32_at(12), 1);
	CHECK_EQ(u32_at(16), 3);
	CHECK_EQ(next, 3);
	/* The first entry: sample 1, taken at 1800 s, soil 1 */
	CHECK_EQ(u32_at(HISTORY_HEADER_SIZE), 1800);
	CHECK_EQ(payload[HISTORY_HEADER_SIZE + 4], 1);
	CHECK_EQ(payload[HISTORY_HEADER_SIZE + 5], 80);
	CHECK_EQ(payload[HISTORY_HEADER_SIZE + 6], 50);
	CHECK_EQ((int8_t)payload[HISTORY_HEADER_SIZE + 7], -4);
	CHECK_EQ(payload[HISTORY_HEADER_SIZE + 8], 2);
	/* Up to date: nothing more */
	CHECK_EQ(history_read(3, 7, 3000, payload, sizeof(payload), &next), HISTORY_HEADER_SIZE);
	CHECK_EQ(next, 3);
	CHECK(history_get(2, &entry));
	CHECK_EQ(entry.uptime_s, 2700);
	CHECK(!history_get(3, &entry));
	CHECK_EQ(lock.locked, 0);
}

static void test_overwritten_samples_start_from_the_oldest_kept(void)
{
	struct history_entry entry;
	uint32_t next;

	reset_module();
	add_samples(CONFIG_HACOAP_HISTORY_SIZE + 10);
	(void)history_read(0, 7, 0, payload, sizeof(payload), &next);
	CHECK_EQ(u32_at(12), 10);  // the first 10 are gone: the reader sees the gap
	CHECK(!history_get(9, &entry));
	CHECK(history_get(10, &entry));
	CHECK_EQ(entry.uptime_s, 900U * 11U);
}

static void test_a_reader_ahead_starts_again_from_the_oldest(void)
{
	uint32_t next;

	/* A reader from before a restart asks for a number this boot hasn't reached */
	reset_module();
	add_samples(2);
	(void)history_read(5000, 8, 0, payload, sizeof(payload), &next);
	CHECK_EQ(u32_at(12), 0);
	CHECK_EQ(payload[1], 2);
	CHECK_EQ(next, 2);
}

static void test_as_many_as_fit(void)
{
	uint32_t next;
	size_t length;

	reset_module();
	add_samples(100);
	length = history_read(0, 7, 0, payload, 512, &next);
	CHECK_EQ(payload[1], (512 - HISTORY_HEADER_SIZE) / HISTORY_ENTRY_SIZE);  // 54
	CHECK_EQ(length, HISTORY_HEADER_SIZE + 54 * HISTORY_ENTRY_SIZE);
	CHECK_EQ(next, 54);         // where to ask from next
	CHECK_EQ(u32_at(16), 100);  // and there are more
	CHECK_EQ(history_read(0, 7, 0, payload, HISTORY_HEADER_SIZE - 1, &next), 0);
	CHECK_EQ(lock.locked, 0);
}

static void test_push_when_the_soil_battery_or_power_changed(void)
{
	struct history_entry given = sample(0, 40);
	struct history_entry now = given;

	CHECK(!history_push_wanted(&given, &now));
	now.soil = 40 - CONFIG_HACOAP_PUSH_SOIL_DELTA + 1;
	CHECK(!history_push_wanted(&given, &now));         // a little drier: not yet
	now.soil = 40 - CONFIG_HACOAP_PUSH_SOIL_DELTA;
	CHECK(history_push_wanted(&given, &now));
	now = given;
	now.soil = 40 + CONFIG_HACOAP_PUSH_SOIL_DELTA;     // watered
	CHECK(history_push_wanted(&given, &now));
	now = given;
	now.battery = given.battery - CONFIG_HACOAP_PUSH_BATTERY_DELTA;
	CHECK(history_push_wanted(&given, &now));
	now = given;
	now.power = 0;                                      // unplugged
	CHECK(history_push_wanted(&given, &now));
	now = given;
	now.temperature = 30;                               // the air alone isn't worth a message
	now.air = 90;
	CHECK(!history_push_wanted(&given, &now));
}

int main(void)
{
	RUN_TEST(test_an_empty_history_has_only_the_header);
	RUN_TEST(test_reads_the_samples_from_a_sequence_number);
	RUN_TEST(test_overwritten_samples_start_from_the_oldest_kept);
	RUN_TEST(test_a_reader_ahead_starts_again_from_the_oldest);
	RUN_TEST(test_as_many_as_fit);
	RUN_TEST(test_push_when_the_soil_battery_or_power_changed);
	return TEST_RESULT();
}
