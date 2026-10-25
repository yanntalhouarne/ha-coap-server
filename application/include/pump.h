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

/* Run time in seconds */
uint8_t pump_get_duration(void);

/* Sets the run time. Returns false (and keeps the old one) if 'seconds' is out of range. */
bool pump_set_duration(uint8_t seconds);

#endif // PUMP_H_
