/*
 * Yann T.
 *
 * buzzer.h
 *
 * Piezo buzzer on PWM0 (P0.12, Q3).
 */

#ifndef BUZZER_H_
#define BUZZER_H_

#include <stdbool.h>
#include <stdint.h>

enum buzzer_sound
{
	BUZZER_PUMP,      // the pump starts
	BUZZER_CONNECTED, // first successful SRP registration
	BUZZER_PING,      // 'ping' PUT with payload '1'
};

/* Plays 'sound' in the background. Returns false if another sound is already playing. */
bool buzzer_play(enum buzzer_sound sound);

/* Sets a continuous tone on (50% duty cycle) or off. For the boot jingle. */
void buzzer_tone(uint32_t frequency_khz, bool on);

#endif // BUZZER_H_
