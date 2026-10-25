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
	srp_start(&fake_ot_instance, device_id, on_registered);
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
		CHECK_EQ(fake_srp_service->mNumTxtEntries, 0);
	}
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
	RUN_TEST(test_names_end_with_the_device_id);
	RUN_TEST(test_service_advertises_the_coap_port);
	RUN_TEST(test_client_registers_on_its_own);
	RUN_TEST(test_registered_callback_only_on_success);
	RUN_TEST(test_no_callback_is_fine);
	RUN_TEST(test_long_names_are_truncated);
	RUN_TEST(test_no_service_buffers_means_no_service);
	return TEST_RESULT();
}
