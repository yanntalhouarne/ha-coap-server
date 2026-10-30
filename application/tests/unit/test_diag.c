/*
 * test_diag.c
 *
 * Restart and crash records, the link to the parent, and the 'diag' payload (src/diag.c).
 */

#include "test.h"

#include "../../src/diag.c"

/* ---------------------------------------------------------------- fake settings */

static uint32_t fake_boots;
static int fake_boot_counts;

uint32_t device_settings_boots(void)
{
	return fake_boots;
}

int device_settings_count_boot(void)
{
	fake_boots++;
	fake_boot_counts++;
	return 0;
}

/* ---------------------------------------------------------------- helpers */

static char payload[256];

static void reset_module(void)
{
	fake_boots = 11;
	fake_boot_counts = 0;
	memset(&crash, 0, sizeof(crash));
	crashed = false;
}

static const char *format(const struct diag_link *link, int32_t soil_mv)
{
	size_t length = diag_format(payload, sizeof(payload), link, "registered", soil_mv);

	payload[length] = '\0';
	return payload;
}

static const struct diag_link detached = {.role = "detached"};

/* ---------------------------------------------------------------- tests */

static void test_reset_causes(void)
{
	static const struct
	{
		uint32_t flags;
		enum diag_reset cause;
	} cases[] = {
		{0, DIAG_RESET_POWER},
		{RESET_POR, DIAG_RESET_POWER},
		{RESET_BROWNOUT, DIAG_RESET_POWER},
		{RESET_PIN, DIAG_RESET_PIN},
		{RESET_SOFTWARE, DIAG_RESET_SOFT},
		{RESET_WATCHDOG, DIAG_RESET_WATCHDOG},
		{RESET_WATCHDOG | RESET_PIN, DIAG_RESET_WATCHDOG}, // the most telling one
		{RESET_CPU_LOCKUP | RESET_SOFTWARE, DIAG_RESET_LOCKUP},
		{RESET_LOW_POWER_WAKE, DIAG_RESET_OTHER},
	};

	for (size_t i = 0U; i < ARRAY_SIZE(cases); i++)
	{
		reset_module();
		fake_reset_cause = cases[i].flags;
		diag_init();
		CHECK_EQ(diag_reset_cause(), cases[i].cause);
		CHECK_EQ(fake_reset_cause, 0); // cleared, so the next boot sees only its own
	}
}

static void test_each_boot_is_counted(void)
{
	reset_module();
	diag_init();
	CHECK_EQ(fake_boot_counts, 1);
	CHECK_STR(format(&detached, 1696), "boots=12,up=0,reset=power,role=detached,srp=registered,soil_mv=1696");
}

static void test_a_crash_is_recorded_for_the_next_boot(void)
{
	z_arch_esf_t esf = {.basic = {.pc = 0x0001a2b4}};

	reset_module();
	k_sys_fatal_error_handler(3, &esf);
	CHECK_EQ(fake_reboots, 1);

	/* The next boot: a software reset, which the record turns into a crash */
	crashed = false;
	fake_reset_cause = RESET_SOFTWARE;
	diag_init();
	CHECK_EQ(diag_reset_cause(), DIAG_RESET_CRASH);
	CHECK_STR(format(&detached, -1), "boots=12,up=0,reset=crash,fault=3@0001a2b4,role=detached,srp=registered,soil_mv=-1");

	/* Read once: the boot after that is an ordinary one */
	fake_reset_cause = RESET_SOFTWARE;
	diag_init();
	CHECK_EQ(diag_reset_cause(), DIAG_RESET_SOFT);
	CHECK(strstr(format(&detached, -1), "fault") == NULL);
}

static void test_a_damaged_record_is_not_a_crash(void)
{
	reset_module();
	crash = (struct crash_record){.magic = CRASH_MAGIC, .reason = 3, .pc = 0x1234, .check = 0};
	fake_reset_cause = RESET_POR; // RAM after a power loss
	diag_init();
	CHECK_EQ(diag_reset_cause(), DIAG_RESET_POWER);
	CHECK_EQ(crash.magic, 0); // cleared anyway
}

static void test_a_crash_without_a_frame(void)
{
	reset_module();
	k_sys_fatal_error_handler(4, NULL);
	diag_init();
	CHECK_EQ(diag_reset_cause(), DIAG_RESET_CRASH);
	CHECK(strstr(format(&detached, 0), "fault=4@00000000") != NULL);
}

static void test_the_link_to_the_parent(void)
{
	struct diag_link link;

	reset_module();
	fake_device_role = OT_DEVICE_ROLE_CHILD;
	fake_rloc16 = 0x5c01;
	fake_parent = (otRouterInfo){.mRloc16 = 0x5c00, .mLinkQualityIn = 3};
	fake_parent_rssi = -62;
	fake_parent_last_rssi = -60;
	diag_link_read(&fake_ot_instance, &link);
	CHECK(link.attached);
	CHECK_STR(link.role, "child");
	diag_init();
	fake_uptime_ms = 3600500;
	CHECK_STR(format(&link, 1696),
		  "boots=12,up=3600,reset=power,role=child,srp=registered,rloc=5c01,parent=5c00,rssi=-62,last_rssi=-60,lq=3,soil_mv=1696");

	fake_device_role = OT_DEVICE_ROLE_DETACHED;
	diag_link_read(&fake_ot_instance, &link);
	CHECK(!link.attached);
	CHECK_EQ(link.rloc16, 0);
	CHECK_STR(link.role, "detached");
}

static void test_a_small_buffer_gets_whole_fields(void)
{
	size_t length;

	reset_module();
	diag_init();
	length = diag_format(payload, 20, &detached, "off", 1696);
	payload[length] = '\0';
	CHECK_STR(payload, "");                      // the first field doesn't fit at all
	length = diag_format(payload, 52, &detached, "off", 1696);
	payload[length] = '\0';
	CHECK_STR(payload, "boots=12,up=0,reset=power,role=detached,srp=off"); // no half field
	CHECK_EQ(diag_format(payload, 0, &detached, "off", 0), 0);
}

int main(void)
{
	RUN_TEST(test_reset_causes);
	RUN_TEST(test_each_boot_is_counted);
	RUN_TEST(test_a_crash_is_recorded_for_the_next_boot);
	RUN_TEST(test_a_damaged_record_is_not_a_crash);
	RUN_TEST(test_a_crash_without_a_frame);
	RUN_TEST(test_the_link_to_the_parent);
	RUN_TEST(test_a_small_buffer_gets_whole_fields);
	return TEST_RESULT();
}
