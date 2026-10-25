/*
 * Yann T.
 *
 * buzzer.c
 *
 * Plays beep patterns on the piezo buzzer, stepped by a kernel timer.
 */

#include <zephyr/drivers/pwm.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>

#include "buzzer.h"

/* A pattern is 'beeps' beeps of 'period_ms', separated by pauses of 'period_ms'. */
struct buzzer_pattern
{
	uint32_t frequency_khz;
	uint32_t period_ms;
	uint8_t beeps;
};

static const struct buzzer_pattern patterns[] = {
	[BUZZER_PUMP] = {.frequency_khz = 4, .period_ms = 100, .beeps = 1},
	[BUZZER_CONNECTED] = {.frequency_khz = 6, .period_ms = 100, .beeps = 3},
	[BUZZER_PING] = {.frequency_khz = 10, .period_ms = 75, .beeps = 6},
};

static const struct pwm_dt_spec pwm_buzzer = PWM_DT_SPEC_GET(DT_ALIAS(pwm_buzzer));

static atomic_t active = ATOMIC_INIT(0);    // set while a pattern is playing
static const struct buzzer_pattern *current; // pattern that is playing
static uint8_t step;                         // even steps beep, odd steps are silent

void buzzer_tone(uint32_t frequency_khz, bool on)
{
	uint32_t period = PWM_KHZ(frequency_khz);

	pwm_set_dt(&pwm_buzzer, period, on ? period / 2U : 0);
}

/* Advances the pattern by one step (beep or pause). */
static void on_buzzer_timer_expiry(struct k_timer *timer)
{
	if (step >= 2 * current->beeps)
	{
		buzzer_tone(current->frequency_khz, false);
		k_timer_stop(timer);
		atomic_clear(&active);
		return;
	}

	buzzer_tone(current->frequency_khz, (step % 2) == 0);
	step++;
}

K_TIMER_DEFINE(buzzer_timer, on_buzzer_timer_expiry, NULL);

bool buzzer_play(enum buzzer_sound sound)
{
	if (sound >= ARRAY_SIZE(patterns))
	{
		return false;
	}
	if (!atomic_cas(&active, 0, 1))
	{
		return false;
	}

	current = &patterns[sound];
	step = 0;
	k_timer_start(&buzzer_timer, K_NO_WAIT, K_MSEC(current->period_ms));

	return true;
}
