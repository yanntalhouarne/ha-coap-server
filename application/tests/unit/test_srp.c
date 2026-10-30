/*
 * test_srp.c
 *
 * SRP service registration (src/srp.c): the names Home Assistant discovers the device by.
 */

#include "test.h"

#include "../../src/srp.c"

#if !defined(CONFIG_HACOAP_SRP_SUFFIX_DEVICE_ID)
#error "These tests expect the default SRP suffix (the device ID)"
#endif

static int registrations;

static void on_registered(void)
{
	registrations++;
}

static void start(const char *device_id)
{
	registrations = 0;
	started = false;
	last_error = OT_ERROR_NONE;
	srp_start(&fake_ot_instance, device_id, on_registered);
}

/* The TXT records, decoded: "k=v;k=v" */
static const char *txt_records(void)
{
	static char text[128];
	const otDnsTxtEntry *entry = fake_srp_service->mTxtEntries;
	size_t out = 0U;

	for (uint16_t i = 0U; i < entry->mValueLength;)
	{
		uint8_t length = entry->mValue[i++];

		if (out > 0U)
		{
			text[out++] = ';';
		}
		memcpy(&text[out], &entry->mValue[i], length);
		out += length;
		i += length;
	}
	text[out] = '\0';
	return text;
}

static void test_names_end_with_the_device_id(void)
{
	start("1a2b3c4d");
	CHECK_STR(fake_srp_host_name, CONFIG_HACOAP_SRP_HOSTNAME "-1a2b3c4d");
	CHECK(fake_srp_service != NULL);
	if (fake_srp_service != NULL)
	{
		CHECK_STR(fake_srp_service->mInstanceName, CONFIG_HACOAP_SRP_SERVICE_INSTANCE "-1a2b3c4d");
		CHECK_STR(fake_srp_service->mName, CONFIG_HACOAP_SRP_SERVICE_NAME);
	}
}

static void test_service_advertises_the_coap_port(void)
{
	start("1a2b3c4d");
	CHECK(fake_srp_service != NULL);
	if (fake_srp_service != NULL)
	{
		CHECK_EQ(fake_srp_service->mPort, 5683);
		CHECK_EQ(fake_srp_service->mNumTxtEntries, 1);
	}
}

static void test_txt_records_say_what_it_is(void)
{
	start("1a2b3c4d");
	CHECK_STR(txt_records(), "id=1a2b3c4d;fw=" GIT_COMMIT_HASH ";hw=" CONFIG_HACOAP_HW_VERSION ";ver=");
}

static void test_a_short_lease(void)
{
	start("1a2b3c4d");
	CHECK_EQ(fake_srp_lease, CONFIG_HACOAP_SRP_LEASE_S);
}

static void test_registration_state(void)
{
	started = false;
	CHECK_STR(srp_state(&fake_ot_instance), "off"); // not attached yet
	start("1a2b3c4d");
	CHECK_STR(srp_state(&fake_ot_instance), "pending");
	fake_srp_callback(OT_ERROR_FAILED, NULL, NULL, NULL, NULL);
	CHECK_STR(srp_state(&fake_ot_instance), "failed");
	fake_srp_host_info.mState = OT_SRP_CLIENT_ITEM_STATE_REGISTERED;
	fake_srp_callback(OT_ERROR_NONE, NULL, NULL, NULL, NULL);
	CHECK_STR(srp_state(&fake_ot_instance), "registered");
}

static void test_unregistering_keeps_the_key(void)
{
	started = false;
	CHECK(!srp_unregister(&fake_ot_instance)); // never registered
	start("1a2b3c4d");
	CHECK(!srp_unregister(&fake_ot_instance)); // client not running
	fake_srp_running = true;
	CHECK(srp_unregister(&fake_ot_instance));
	CHECK_EQ(fake_srp_removals, 1);
	CHECK(fake_srp_removal_kept_key);
}

static void test_client_registers_on_its_own(void)
{
	start("1a2b3c4d");
	CHECK(fake_srp_auto_host_address);
	CHECK(fake_srp_auto_start);
	CHECK(fake_srp_callback != NULL);
}

static void test_registered_callback_only_on_success(void)
{
	start("1a2b3c4d");
	fake_srp_callback(OT_ERROR_FAILED, NULL, NULL, NULL, NULL);
	CHECK_EQ(registrations, 0);
	fake_srp_callback(OT_ERROR_NONE, NULL, NULL, NULL, NULL);
	fake_srp_callback(OT_ERROR_NONE, NULL, NULL, NULL, NULL);
	CHECK_EQ(registrations, 2);
}

static void test_no_callback_is_fine(void)
{
	srp_start(&fake_ot_instance, "1a2b3c4d", NULL);
	fake_srp_callback(OT_ERROR_NONE, NULL, NULL, NULL, NULL);
}

static void test_long_names_are_truncated(void)
{
	static const char long_id[] = "0123456789012345678901234567890123456789012345678901234567890123456789";

	start(long_id);
	CHECK_EQ(strlen(fake_srp_host_name), SRP_NAME_MAX_SIZE - 1);
	CHECK(strncmp(fake_srp_host_name, CONFIG_HACOAP_SRP_HOSTNAME "-0123", strlen(CONFIG_HACOAP_SRP_HOSTNAME) + 5) == 0);
}

static void test_no_service_buffers_means_no_service(void)
{
	fake_srp_no_buffers = true;
	start("1a2b3c4d");
	CHECK(fake_srp_service == NULL);
	CHECK_STR(fake_srp_host_name, CONFIG_HACOAP_SRP_HOSTNAME "-1a2b3c4d");
}

int main(void)
{
	RUN_TEST(test_txt_records_say_what_it_is);
	RUN_TEST(test_a_short_lease);
	RUN_TEST(test_registration_state);
	RUN_TEST(test_unregistering_keeps_the_key);
	RUN_TEST(test_names_end_with_the_device_id);
	RUN_TEST(test_service_advertises_the_coap_port);
	RUN_TEST(test_client_registers_on_its_own);
	RUN_TEST(test_registered_callback_only_on_success);
	RUN_TEST(test_no_callback_is_fine);
	RUN_TEST(test_long_names_are_truncated);
	RUN_TEST(test_no_service_buffers_means_no_service);
	return TEST_RESULT();
}
