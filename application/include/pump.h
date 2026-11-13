/*
 * Yann T.
 *
 * pump.h
 *
 * Water pump on J2 (P0.17, Q1), run for a set time by a CoAP request or the S1 button.
 */

#ifndef PUMP_H_
#define PUMP_H_

#include <stdbool.h>
#include <stdint.h>

/* Configures the pump output (off) and S1, which starts the pump when pressed. */
int pump_init(void);

/* Runs the pump for the current run time. Restarts the run if the pump is already running. */
void pump_start(void);

/* Stops the pump before its run time is over. */
void pump_stop(void);

bool pump_is_running(void);

/* True while S1 is pressed. */
bool pump_button_pressed(void);

/* Run time in seconds */
uint8_t pump_get_duration(void);

/* Sets the run time. Returns false (and keeps the old one) if 'seconds' is out of range. */
bool pump_set_duration(uint8_t seconds);

/* The pump's run time started with S1 since boot (s), for the fleet manager ('diag': button_s),
 * which counts it in the plant's water tank. The runs started over CoAP aren't in it. */
uint32_t pump_button_seconds(void);

/* How long the pump actually ran since boot (ms), whatever started it (CoAP, S1) and however it
 * ended (its run time, or stopped early): 'diag' pump_ms, for the water a plant was given. */
uint32_t pump_run_ms(void);

/* 'callback' is called each time a run ends (its run time is over, or it was stopped), maybe from
 * the timer's interrupt: it should only submit work. NULL: no one is told. */
void pump_on_run_end(void (*callback)(void));

#endif // PUMP_H_
