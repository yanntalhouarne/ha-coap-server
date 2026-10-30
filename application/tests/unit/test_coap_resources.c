/*
 * test_coap_resources.c
 *
 * The CoAP API (src/coap_resources.c): which requests each resource accepts, and the
 * responses it sends.
 */

#include "test.h"

#include "../../src/coap_resources.c"

/* ---------------------------------------------------------------- fake application */

static struct
{
	int pumpdc_gets;
	int pumpdc_puts;
	uint8_t pumpdc_put_value;
	uint8_t pumpdc;
	bool pump_running;
	int pump_puts;
	uint8_t pump_put_command;
	uint8_t data[DATA_PAYLOAD_SIZE];
	struct coap_info info;
	int ping_puts;
	uint8_t ping_command;
	int log_gets;
	uint32_t log_from;
	size_t log_size;
} fake_app;

static uint8_t app_pumpdc_get(void)
{
	fake_app.pumpdc_gets++;
	return fake_app.pumpdc;
}

static uint8_t app_pumpdc_put(uint8_t value)
{
	fake_app.pumpdc_puts++;
	fake_app.pumpdc_put_value = value;
	return fake_app.pumpdc;
}

static bool app_pump_get(void)
{
	return fake_app.pump_running;
}

static void app_pump_put(uint8_t command)
{
	fake_app.pump_puts++;
	fake_app.pump_put_command = command;
}

static void app_data_get(uint8_t payload[DATA_PAYLOAD_SIZE])
{
	memcpy(payload, fake_app.data, DATA_PAYLOAD_SIZE);
}

static struct coap_info app_info_get(void)
{
	return fake_app.info;
}

static void app_ping_put(uint8_t command)
{
	fake_app.ping_puts++;
	fake_app.ping_command = command;
}

static size_t app_log_get(uint32_t from, char *payload, size_t size)
{
	fake_app.log_gets++;
	fake_app.log_from = from;
	fake_app.log_size = size;
	return (size_t)snprintf(payload, size, "0000002a %u\nline\n", (unsigned int)from);
}

/* A device built without HACOAP_REMOTE_LOG: no log_get */
static const struct coap_resources_handlers handlers = {
	.pumpdc_get = app_pumpdc_get,
	.pumpdc_put = app_pumpdc_put,
	.pump_get = app_pump_get,
	.pump_put = app_pump_put,
	.data_get = app_data_get,
	.info_get = app_info_get,
	.ping_put = app_ping_put,
};

static const struct coap_resources_handlers handlers_with_log = {
	.pumpdc_get = app_pumpdc_get,
	.pumpdc_put = app_pumpdc_put,
	.pump_get = app_pump_get,
	.pump_put = app_pump_put,
	.data_get = app_data_get,
	.info_get = app_info_get,
	.ping_put = app_ping_put,
	.log_get = app_log_get,
};

/* ---------------------------------------------------------------- helpers */

static void setup(void)
{
	memset(&fake_app, 0, sizeof(fake_app));
	fake_app.info = (struct coap_info){.fw_version = "abc1234", .hw_version = "v2.0", .device_id = "1a2b3c4d"};
	CHECK_EQ(coap_resources_init(&handlers), 0);
}

static void setup_with_log(void)
{
	memset(&fake_app, 0, sizeof(fake_app));
	CHECK_EQ(coap_resources_init(&handlers_with_log), 0);
}

/* Uri-Query options for the next request() (NULL-terminated), or NULL */
static const char *const *next_queries;

/* Sends a request to the resource at 'uri', as OpenThread would. */
static void request(const char *uri, otCoapType type, otCoapCode code, const char *payload)
{
	otMessage message;
	otMessageInfo info;

	memset(&info, 0, sizeof(info));
	memset(info.mSockAddr.m8, 0xfd, sizeof(info.mSockAddr.m8));
	memset(info.mPeerAddr.m8, 0xab, sizeof(info.mPeerAddr.m8));
	fake_request_init(&message, type, code, payload);
	for (int i = 0; (next_queries != NULL) && (next_queries[i] != NULL); i++)
	{
		fake_request_add_query(&message, next_queries[i]);
	}
	next_queries = NULL;

	for (int i = 0; i < fake_coap_resource_count; i++)
	{
		if (strcmp(fake_coap_resources[i]->mUriPath, uri) == 0)
		{
			fake_coap_resources[i]->mHandler(fake_coap_resources[i]->mContext, &message, &info);
			return;
		}
	}
	printf("  no resource '%s'\n", uri);
	test_failures++;
}

static void check_response(otCoapType type, otCoapCode code, const void *payload, uint16_t length)
{
	CHECK_EQ(fake_responses_sent, 1);
	CHECK_EQ(fake_response.type, type);
	CHECK_EQ(fake_response.code, code);
	CHECK_EQ(fake_response.payload_marker, length > 0);
	CHECK_EQ(fake_response.length, length);
	CHECK((length == 0) || (memcmp(fake_response.bytes, payload, length) == 0));
}

#define CON OT_COAP_TYPE_CONFIRMABLE
#define NON OT_COAP_TYPE_NON_CONFIRMABLE
#define ACK OT_COAP_TYPE_ACKNOWLEDGMENT

/* ---------------------------------------------------------------- tests */

static void test_init_registers_every_resource(void)
{
	static const char *const uris[] = {"pumpdc", "pump", "data", "info", "ping", "log"};

	setup();
	CHECK_EQ(fake_coap_resource_count, ARRAY_SIZE(uris));
	for (size_t i = 0; i < ARRAY_SIZE(uris); i++)
	{
		CHECK_STR(fake_coap_resources[i]->mUriPath, uris[i]);
		CHECK(fake_coap_resources[i]->mHandler != NULL);
		CHECK(fake_coap_resources[i]->mContext == &resources[i]);
	}
	CHECK(fake_coap_default_handler != NULL);
	CHECK_EQ(fake_coap_port, 5683);
}

static void test_init_reports_a_coap_start_failure(void)
{
	fake_coap_start_error = OT_ERROR_FAILED;
	CHECK_EQ(coap_resources_init(&handlers), -EIO);
}

static void test_data_get_returns_the_readings(void)
{
	static const uint8_t expected[DATA_PAYLOAD_SIZE] = {42, 87, 55, (uint8_t)-5};

	setup();
	memcpy(fake_app.data, expected, sizeof(expected));
	request("data", CON, OT_COAP_CODE_GET, NULL);
	check_response(ACK, OT_COAP_CODE_CONTENT, expected, sizeof(expected));
}

static void test_non_confirmable_get_gets_a_non_confirmable_response(void)
{
	setup();
	request("data", NON, OT_COAP_CODE_GET, NULL);
	CHECK_EQ(fake_responses_sent, 1);
	CHECK_EQ(fake_response.type, NON);
}

static void test_response_goes_out_from_any_address_to_the_requester(void)
{
	static const uint8_t zero[16] = {0};
	uint8_t peer[16];

	setup();
	memset(peer, 0xab, sizeof(peer));
	request("data", CON, OT_COAP_CODE_GET, NULL);
	CHECK(memcmp(fake_response_info.mSockAddr.m8, zero, sizeof(zero)) == 0);
	CHECK(memcmp(fake_response_info.mPeerAddr.m8, peer, sizeof(peer)) == 0);
}

static void test_disallowed_requests_get_no_response(void)
{
	setup();
	request("data", CON, OT_COAP_CODE_PUT, "1");
	request("data", CON, OT_COAP_CODE_POST, NULL);
	request("data", CON, OT_COAP_CODE_DELETE, NULL);
	request("data", OT_COAP_TYPE_RESET, OT_COAP_CODE_GET, NULL);
	request("info", NON, OT_COAP_CODE_PUT, "1");
	request("ping", CON, OT_COAP_CODE_GET, NULL);
	request("log", CON, OT_COAP_CODE_PUT, "1");
	CHECK_EQ(fake_responses_sent, 0);
}

static void test_pump_put_starts_and_reports_the_pump(void)
{
	static const uint8_t running = 1;

	setup();
	fake_app.pump_running = true;
	request("pump", CON, OT_COAP_CODE_PUT, "1");
	CHECK_EQ(fake_app.pump_puts, 1);
	CHECK_EQ(fake_app.pump_put_command, PUMP_CMD_ON);
	check_response(ACK, OT_COAP_CODE_CONTENT, &running, 1);
}

static void test_pump_put_must_be_confirmable(void)
{
	setup();
	request("pump", NON, OT_COAP_CODE_PUT, "1");
	CHECK_EQ(fake_app.pump_puts, 0);
	CHECK_EQ(fake_responses_sent, 0);
}

static void test_pump_get_only_reports(void)
{
	static const uint8_t stopped = 0;

	setup();
	request("pump", NON, OT_COAP_CODE_GET, NULL);
	CHECK_EQ(fake_app.pump_puts, 0);
	check_response(NON, OT_COAP_CODE_CONTENT, &stopped, 1);
}

static void test_put_without_payload_is_ignored(void)
{
	setup();
	request("pump", CON, OT_COAP_CODE_PUT, NULL);
	request("pumpdc", CON, OT_COAP_CODE_PUT, NULL);
	request("ping", CON, OT_COAP_CODE_PUT, NULL);
	CHECK_EQ(fake_app.pump_puts, 0);
	CHECK_EQ(fake_app.pumpdc_puts, 0);
	CHECK_EQ(fake_app.ping_puts, 0);
	CHECK_EQ(fake_responses_sent, 0);
}

static void test_pumpdc_put_passes_the_raw_byte_and_returns_the_run_time(void)
{
	setup();
	fake_app.pumpdc = 5;
	request("pumpdc", CON, OT_COAP_CODE_PUT, "5");
	CHECK_EQ(fake_app.pumpdc_put_value, '5');
	check_response(ACK, OT_COAP_CODE_CONTENT, &fake_app.pumpdc, 1);
}

static void test_pumpdc_get_returns_the_run_time(void)
{
	setup();
	fake_app.pumpdc = 3;
	request("pumpdc", CON, OT_COAP_CODE_GET, NULL);
	CHECK_EQ(fake_app.pumpdc_gets, 1);
	CHECK_EQ(fake_app.pumpdc_puts, 0);
	check_response(ACK, OT_COAP_CODE_CONTENT, &fake_app.pumpdc, 1);
}

static void test_info_includes_the_nul_terminator(void)
{
	static const char expected[] = "abc1234,v2.0,1a2b3c4d";

	setup();
	request("info", CON, OT_COAP_CODE_GET, NULL);
	check_response(ACK, OT_COAP_CODE_CONTENT, expected, sizeof(expected));
}

static void test_info_is_truncated_to_its_buffer(void)
{
	static const char long_id[] = "0123456789012345678901234567890123456789012345678901234567890123456789";

	setup();
	fake_app.info.device_id = long_id;
	request("info", CON, OT_COAP_CODE_GET, NULL);
	CHECK_EQ(fake_response.length, INFO_PAYLOAD_MAX_SIZE);
	CHECK_EQ(fake_response.bytes[INFO_PAYLOAD_MAX_SIZE - 1], '\0');
	CHECK(memcmp(fake_response.bytes, "abc1234,v2.0,0123", 17) == 0);
}

static void test_ping_accepts_both_put_types(void)
{
	setup();
	request("ping", NON, OT_COAP_CODE_PUT, "1");
	CHECK_EQ(fake_app.ping_command, PING_CMD_BUZZER);
	check_response(NON, OT_COAP_CODE_CHANGED, NULL, 0);

	fake_responses_sent = 0;
	request("ping", CON, OT_COAP_CODE_PUT, "0");
	CHECK_EQ(fake_app.ping_command, PING_CMD_QUIET);
	check_response(ACK, OT_COAP_CODE_CHANGED, NULL, 0);
	CHECK_EQ(fake_app.ping_puts, 2);
}

static void test_no_buffers_means_no_response(void)
{
	setup();
	fake_coap_no_bufs = true;
	request("data", CON, OT_COAP_CODE_GET, NULL);
	CHECK_EQ(fake_responses_sent, 0);
	CHECK_EQ(fake_messages_freed, 0);
}

static void test_unknown_resource_gets_no_response(void)
{
	otMessage message;
	otMessageInfo info = {0};

	setup();
	fake_request_init(&message, CON, OT_COAP_CODE_GET, NULL);
	fake_coap_default_handler(NULL, &message, &info);
	CHECK_EQ(fake_responses_sent, 0);
}

static void test_log_without_a_log_answers_not_found(void)
{
	setup();
	request("log", CON, OT_COAP_CODE_GET, NULL);
	check_response(ACK, OT_COAP_CODE_NOT_FOUND, NULL, 0);
}

static void test_log_get_reads_from_the_query_offset(void)
{
	static const char *const queries[] = {"from=1234", NULL};
	static const char expected[] = "0000002a 1234\nline\n";

	setup_with_log();
	next_queries = queries;
	request("log", CON, OT_COAP_CODE_GET, NULL);
	CHECK_EQ(fake_app.log_gets, 1);
	CHECK_EQ(fake_app.log_from, 1234);
	CHECK_EQ(fake_app.log_size, LOG_PAYLOAD_MAX_SIZE);
	check_response(ACK, OT_COAP_CODE_CONTENT, expected, sizeof(expected) - 1);
}

static void test_log_get_without_an_offset_reads_from_0(void)
{
	static const char *const others[] = {"x=1", "fromage", NULL};

	setup_with_log();
	request("log", NON, OT_COAP_CODE_GET, NULL);
	CHECK_EQ(fake_app.log_from, 0);
	CHECK_EQ(fake_response.type, NON);

	fake_app.log_from = 99;
	next_queries = others;
	request("log", CON, OT_COAP_CODE_GET, NULL);
	CHECK_EQ(fake_app.log_gets, 2);
	CHECK_EQ(fake_app.log_from, 0);
}

static void test_log_get_finds_the_offset_among_other_queries(void)
{
	static const char *const queries[] = {"x=1", "from=7", NULL};
	static const char *const too_long[] = {"from=123456789012345678901234567890", NULL};

	setup_with_log();
	next_queries = queries;
	request("log", CON, OT_COAP_CODE_GET, NULL);
	CHECK_EQ(fake_app.log_from, 7);

	next_queries = too_long;
	request("log", CON, OT_COAP_CODE_GET, NULL);
	CHECK_EQ(fake_app.log_from, 0);
}

int main(void)
{
	RUN_TEST(test_init_registers_every_resource);
	RUN_TEST(test_init_reports_a_coap_start_failure);
	RUN_TEST(test_data_get_returns_the_readings);
	RUN_TEST(test_non_confirmable_get_gets_a_non_confirmable_response);
	RUN_TEST(test_response_goes_out_from_any_address_to_the_requester);
	RUN_TEST(test_disallowed_requests_get_no_response);
	RUN_TEST(test_pump_put_starts_and_reports_the_pump);
	RUN_TEST(test_pump_put_must_be_confirmable);
	RUN_TEST(test_pump_get_only_reports);
	RUN_TEST(test_put_without_payload_is_ignored);
	RUN_TEST(test_pumpdc_put_passes_the_raw_byte_and_returns_the_run_time);
	RUN_TEST(test_pumpdc_get_returns_the_run_time);
	RUN_TEST(test_info_includes_the_nul_terminator);
	RUN_TEST(test_info_is_truncated_to_its_buffer);
	RUN_TEST(test_ping_accepts_both_put_types);
	RUN_TEST(test_no_buffers_means_no_response);
	RUN_TEST(test_unknown_resource_gets_no_response);
	RUN_TEST(test_log_without_a_log_answers_not_found);
	RUN_TEST(test_log_get_reads_from_the_query_offset);
	RUN_TEST(test_log_get_without_an_offset_reads_from_0);
	RUN_TEST(test_log_get_finds_the_offset_among_other_queries);
	return TEST_RESULT();
}
