/*
 * test.h
 *
 * A minimal test framework: CHECK macros that report and count failures, and RUN_TEST,
 * which resets the fakes before each test. Each test file is its own program: its main()
 * runs its tests and returns TEST_RESULT().
 */

#ifndef TEST_H_
#define TEST_H_

#include <stdio.h>
#include <string.h>

#include <fake.h>

static int test_failures;
static int test_count;

#define CHECK(cond)                                                                    \
	do                                                                             \
	{                                                                              \
		if (!(cond))                                                           \
		{                                                                      \
			printf("  %s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #cond); \
			test_failures++;                                               \
		}                                                                      \
	} while (0)

#define CHECK_EQ(actual, expected)                                                         \
	do                                                                                 \
	{                                                                                  \
		long long actual_ = (long long)(actual);                                   \
		long long expected_ = (long long)(expected);                               \
		if (actual_ != expected_)                                                  \
		{                                                                          \
			printf("  %s:%d: %s is %lld, expected %lld\n", __FILE__, __LINE__, \
			       #actual, actual_, expected_);                               \
			test_failures++;                                                   \
		}                                                                          \
	} while (0)

#define CHECK_STR(actual, expected)                                                            \
	do                                                                                     \
	{                                                                                      \
		const char *actual_ = (actual);                                                \
		const char *expected_ = (expected);                                            \
		if ((actual_ == NULL) || (strcmp(actual_, expected_) != 0))                    \
		{                                                                              \
			printf("  %s:%d: %s is \"%s\", expected \"%s\"\n", __FILE__, __LINE__, \
			       #actual, (actual_ != NULL) ? actual_ : "(null)", expected_);    \
			test_failures++;                                                       \
		}                                                                              \
	} while (0)

#define RUN_TEST(test)                         \
	do                                     \
	{                                      \
		int failures_before = test_failures; \
		fake_reset();                  \
		test();                        \
		test_count++;                  \
		printf("%s %s\n", (test_failures == failures_before) ? "PASS" : "FAIL", #test); \
	} while (0)

#define TEST_RESULT() (printf("%d tests, %d failed checks\n", test_count, test_failures), (test_failures == 0) ? 0 : 1)

#endif // TEST_H_
