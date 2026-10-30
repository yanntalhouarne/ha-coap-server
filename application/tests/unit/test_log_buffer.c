/*
 * test_log_buffer.c
 *
 * The latest log output, read by offset (src/log_buffer.c).
 */

#include "test.h"

#include "../../src/log_buffer.c"

static char payload[600];

static void reset_module(void)
{
	memset(ring, 0, sizeof(ring));
	written = 0U;
	boot_id = 0U;
	fake_random = 0x2a;
}

static void write_text(const char *text)
{
	log_buffer_write((const uint8_t *)text, strlen(text));
}

/* Reads from 'from' into 'payload' (NUL-terminated for the checks). */
static const char *read_from(uint32_t from, size_t size)
{
	size_t length = log_buffer_read(from, payload, size);

	payload[length] = '\0';
	return payload;
}

static void test_an_empty_log_has_only_the_header(void)
{
	reset_module();
	CHECK_STR(read_from(0, 512), "0000002b 0\n");
	CHECK_EQ(lock.locked, 0);
}

static void test_reads_from_the_offset(void)
{
	reset_module();
	write_text("<inf> hello\n");
	write_text("<wrn> world\n");
	CHECK_STR(read_from(0, 512), "0000002b 0\n<inf> hello\n<wrn> world\n");
	CHECK_STR(read_from(12, 512), "0000002b 12\n<wrn> world\n");
	CHECK_STR(read_from(24, 512), "0000002b 24\n");
	CHECK_EQ(lock.locked, 0);
}

static void test_a_reader_ahead_of_the_log_starts_again(void)
{
	/* A reader from before a restart asks for an offset the new log hasn't reached. */
	reset_module();
	write_text("boot\n");
	CHECK_STR(read_from(5000, 512), "0000002b 0\nboot\n");
}

static void test_overwritten_bytes_are_skipped(void)
{
	char text[RING_SIZE + 100 + 1];

	reset_module();
	for (size_t i = 0U; i < sizeof(text) - 1; i++)
	{
		text[i] = (char)('a' + (i % 26));
	}
	text[sizeof(text) - 1] = '\0';
	write_text(text);

	/* The oldest kept byte is at offset 100 ('a' + 100 % 26 = 'w'). */
	read_from(0, 20);
	CHECK(strncmp(payload, "0000002b 100\nwxyzabc", 20) == 0);
	read_from(RING_SIZE + 95, 512);
	CHECK_STR(payload + 14, text + RING_SIZE + 95);
}

static void test_the_text_fills_the_payload_at_most(void)
{
	reset_module();
	write_text("0123456789abcdef\n");
	CHECK_EQ(log_buffer_read(0, payload, 20), 20);
	CHECK(memcmp(payload, "0000002b 0\n012345678", 20) == 0);

	/* The rest, from where that answer ended */
	CHECK_STR(read_from(9, 512), "0000002b 9\n9abcdef\n");
}

static void test_a_payload_too_small_for_the_header_is_empty(void)
{
	reset_module();
	write_text("text\n");
	CHECK_EQ(log_buffer_read(0, payload, 8), 0);
	CHECK_EQ(lock.locked, 0);
}

static void test_the_boot_id_is_drawn_once_and_never_0(void)
{
	reset_module();
	fake_random = 0;
	read_from(0, 512);
	CHECK_EQ(boot_id, 1);

	fake_random = 0x1234;
	CHECK_STR(read_from(0, 512), "00000001 0\n");
}

int main(void)
{
	RUN_TEST(test_an_empty_log_has_only_the_header);
	RUN_TEST(test_reads_from_the_offset);
	RUN_TEST(test_a_reader_ahead_of_the_log_starts_again);
	RUN_TEST(test_overwritten_bytes_are_skipped);
	RUN_TEST(test_the_text_fills_the_payload_at_most);
	RUN_TEST(test_a_payload_too_small_for_the_header_is_empty);
	RUN_TEST(test_the_boot_id_is_drawn_once_and_never_0);
	return TEST_RESULT();
}
