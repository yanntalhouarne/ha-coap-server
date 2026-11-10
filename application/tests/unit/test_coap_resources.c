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
	int hist_gets;
	uint32_t hist_from;
	uint32_t hist_next; // the next sample, as the history says
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

static size_t app_diag_get(char *payload, size_t size)
{
	return (size_t)snprintf(payload, size, "boots=3,up=60,reset=power,role=child");
}

static size_t app_log_get(uint32_t from, char *payload, size_t size)
{
	fake_app.log_gets++;
	fake_app.log_from = from;
	fake_app.log_size = size;
	return (size_t)snprintf(payload, size, "0000002a %u\nline\n", (unsigned int)from);
}

/* The 'hist' payload: "H<from>", and the next sample */
static size_t app_hist_get(uint32_t from, uint8_t *payload, size_t size, uint32_t *next)
{
	fake_app.hist_gets++;
	fake_app.hist_from = from;
	*next = fake_app.hist_next;
	return (size_t)snprintf((char *)payload, size, "H%u", (unsigned int)from);
}

/* A device built without HACOAP_REMOTE_LOG: no log_get (nor hist_get, to see 'hist' answer 4.04) */
static const struct coap_resources_handlers handlers = {
	.pumpdc_get = app_pumpdc_get,
	.pumpdc_put = app_pumpdc_put,
	.pump_get = app_pump_get,
	.pump_put = app_pump_put,
	.data_get = app_data_get,
	.info_get = app_info_get,
	.ping_put = app_ping_put,
	.diag_get = app_diag_get,
};

static const struct coap_resources_handlers handlers_with_log = {
	.pumpdc_get = app_pumpdc_get,
	.pumpdc_put = app_pumpdc_put,
	.pump_get = app_pump_get,
	.pump_put = app_pump_put,
	.data_get = app_data_get,
	.info_get = app_info_get,
	.ping_put = app_ping_put,
	.diag_get = app_diag_get,
	.log_get = app_log_get,
	.hist_get = app_hist_get,
};

/* ---------------------------------------------------------------- helpers */

static void setup(void)
{
	memset(&fake_app, 0, sizeof(fake_app));
	memset(&observer, 0, sizeof(observer));
	fake_app.info = (struct coap_info){.fw_version = "abc1234", .hw_version = "v2.0", .device_id = "1a2b3c4d"};
	CHECK_EQ(coap_resources_init(&handlers), 0);
}

static void setup_with_log(void)
{
	memset(&fake_app, 0, sizeof(fake_app));
	memset(&observer, 0, sizeof(observer));
	CHECK_EQ(coap_resources_init(&handlers_with_log), 0);
}

/* Uri-Query options for the next request() (NULL-terminated), or NULL */
static const char *const *next_queries;
/* An Observe option for the next request() (-1: none), and its sender's port (0: 5683) */
static int next_observe = -1;
static uint16_t next_peer_port;
static const uint8_t TOKEN[] = {0x11, 0x22, 0x33, 0x44};

/* Sends a request to the resource at 'uri', as OpenThread would. */
static void request(const char *uri, otCoapType type, otCoapCode code, const char *payload)
{
	otMessage message;
	otMessageInfo info;

	memset(&info, 0, sizeof(info));
	memset(info.mSockAddr.m8, 0xfd, sizeof(info.mSockAddr.m8));
	memset(info.mPeerAddr.m8, 0xab, sizeof(info.mPeerAddr.m8));
	info.mPeerPort = (next_peer_port != 0U) ? next_peer_port : 5683U;
	fake_request_init(&message, type, code, payload);
	fake_request_set_token(&message, TOKEN, sizeof(TOKEN));
	for (int i = 0; (next_queries != NULL) && (next_queries[i] != NULL); i++)
	{
		fake_request_add_query(&message, next_queries[i]);
	}
	if (next_observe >= 0)
	{
		fake_request_set_observe(&message, (uint32_t)next_observe);
	}
	next_queries = NULL;
	next_observe = -1;
	next_peer_port = 0U;

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
	static const char *const uris[] = {"pumpdc", "pump", "data", "info", "ping", "diag", "log", "hist"};

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

static void test_diag_get_answers_with_the_report(void)
{
	static const char expected[] = "boots=3,up=60,reset=power,role=child";

	setup();
	request("diag", CON, OT_COAP_CODE_GET, NULL);
	check_response(ACK, OT_COAP_CODE_CONTENT, expected, sizeof(expected) - 1);
	request("diag", CON, OT_COAP_CODE_PUT, "1");
	CHECK_EQ(fake_responses_sent, 1); // GET only
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

static void test_hist_without_a_history_answers_not_found(void)
{
	setup();
	request("hist", CON, OT_COAP_CODE_GET, NULL);
	check_response(ACK, OT_COAP_CODE_NOT_FOUND, NULL, 0);
}

static void test_hist_get_reads_from_the_query(void)
{
	static const char *const queries[] = {"from=12", NULL};
	uint32_t next;

	setup_with_log();
	next_queries = queries;
	request("hist", CON, OT_COAP_CODE_GET, NULL);
	check_response(ACK, OT_COAP_CODE_CONTENT, "H12", 3);
	CHECK_EQ(fake_app.hist_from, 12);
	CHECK(!fake_response.has_observe);  // not observed: a plain answer
	CHECK(!coap_resources_observed(&next));
	CHECK_EQ(coap_resources_notify(), -ENOTCONN);
	CHECK_EQ(fake_requests_sent, 0);
}

static void test_hist_observe_registers_then_notifies_the_new_samples(void)
{
	static const char *const queries[] = {"from=3", NULL};
	uint32_t next = 0U;

	setup_with_log();
	fake_app.hist_next = 9;
	next_queries = queries;
	next_observe = 0;
	request("hist", CON, OT_COAP_CODE_GET, NULL);
	check_response(ACK, OT_COAP_CODE_CONTENT, "H3", 2);
	CHECK(fake_response.has_observe);   // registered: the answer says so
	CHECK(coap_resources_observed(&next));
	CHECK_EQ(next, 9);                  // it has everything before 9

	/* Two samples later: it's sent them, from 9 */
	fake_app.hist_next = 11;
	CHECK_EQ(coap_resources_notify(), 0);
	CHECK_EQ(fake_requests_sent, 1);
	CHECK_EQ(fake_request_sent.type, NON);
	CHECK_EQ(fake_request_sent.code, OT_COAP_CODE_CONTENT);
	CHECK_EQ(fake_request_sent.token_length, sizeof(TOKEN));
	CHECK(memcmp(fake_request_sent.token, TOKEN, sizeof(TOKEN)) == 0);
	CHECK(fake_request_sent.has_observe);
	CHECK_EQ(fake_request_sent.observe, fake_response.observe + 1);  // newer than the registration's
	CHECK(fake_request_sent.payload_marker);
	CHECK_EQ(fake_request_sent.length, 2);
	CHECK(memcmp(fake_request_sent.bytes, "H9", 2) == 0);
	CHECK_EQ(fake_request_info.mPeerAddr.m8[0], 0xab);   // to the observer
	CHECK_EQ(fake_request_info.mPeerPort, 5683);
	CHECK(coap_resources_observed(&next));
	CHECK_EQ(next, 11);
	/* The next one is newer again */
	CHECK_EQ(coap_resources_notify(), 0);
	CHECK_EQ(fake_request_sent.observe, fake_response.observe + 2);
	CHECK(memcmp(fake_request_sent.bytes, "H11", 3) == 0);
}

static void test_hist_observe_ends_after_its_lease(void)
{
	uint32_t next;

	setup_with_log();
	next_observe = 0;
	request("hist", CON, OT_COAP_CODE_GET, NULL);
	fake_uptime_ms += (int64_t)CONFIG_HACOAP_PUSH_LEASE_S * 1000;
	CHECK(coap_resources_observed(&next));      // just in time
	fake_uptime_ms += 1;
	CHECK(!coap_resources_observed(&next));     // it didn't register again: gone
	CHECK_EQ(coap_resources_notify(), -ENOTCONN);
}

static void test_hist_observe_1_from_the_observer_deregisters(void)
{
	uint32_t next;

	setup_with_log();
	next_observe = 0;
	request("hist", CON, OT_COAP_CODE_GET, NULL);
	fake_responses_sent = 0;
	next_observe = 1;
	next_peer_port = 40000;                      // someone else: no effect
	request("hist", CON, OT_COAP_CODE_GET, NULL);
	CHECK(coap_resources_observed(&next));
	CHECK(!fake_response.has_observe);
	request("hist", CON, OT_COAP_CODE_GET, NULL); // a plain GET from it: still observed
	CHECK(coap_resources_observed(&next));
	next_observe = 1;
	request("hist", CON, OT_COAP_CODE_GET, NULL);
	CHECK(!coap_resources_observed(&next));
}

static void test_a_notification_that_cant_be_sent_keeps_the_samples(void)
{
	uint32_t next;

	setup_with_log();
	fake_app.hist_next = 4;
	next_observe = 0;
	request("hist", CON, OT_COAP_CODE_GET, NULL);
	fake_app.hist_next = 6;
	fake_send_request_error = OT_ERROR_NO_BUFS;
	CHECK_EQ(coap_resources_notify(), -EIO);
	CHECK_EQ(fake_messages_freed, 1);
	CHECK(coap_resources_observed(&next));
	CHECK_EQ(next, 4);                           // sent with the next one
	fake_send_request_error = OT_ERROR_NONE;
	fake_coap_no_bufs = true;
	CHECK_EQ(coap_resources_notify(), -ENOMEM);
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
	RUN_TEST(test_diag_get_answers_with_the_report);
	RUN_TEST(test_log_without_a_log_answers_not_found);
	RUN_TEST(test_log_get_reads_from_the_query_offset);
	RUN_TEST(test_log_get_without_an_offset_reads_from_0);
	RUN_TEST(test_log_get_finds_the_offset_among_other_queries);
	RUN_TEST(test_hist_without_a_history_answers_not_found);
	RUN_TEST(test_hist_get_reads_from_the_query);
	RUN_TEST(test_hist_observe_registers_then_notifies_the_new_samples);
	RUN_TEST(test_hist_observe_ends_after_its_lease);
	RUN_TEST(test_hist_observe_1_from_the_observer_deregisters);
	RUN_TEST(test_a_notification_that_cant_be_sent_keeps_the_samples);
	return TEST_RESULT();
}
