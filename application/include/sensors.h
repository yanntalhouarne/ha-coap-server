/*
 * Yann T.
 *
 * sensors.h
 *
 * Soil moisture (ADC on J5), battery (MAX17048) and air temperature/humidity (HDC1080).
 * The sensors are sampled periodically from the system work queue; readers get the
 * latest samples without waiting.
 */

#ifndef SENSORS_H_
#define SENSORS_H_

#include <stdint.h>
#include <zephyr/sys/util.h>

/* Bits returned by sensors_init() for each sensor that is not available */
#define SENSOR_AIR BIT(0)        // HDC1080
#define SENSOR_FUEL_GAUGE BIT(1) // MAX17048
#define SENSOR_SOIL BIT(2)       // ADC or sensor power switch

/* Latest readings. A missing or failing sensor reads 0. */
struct sensors_data
{
	uint8_t soil_moisture; // %, 0 = dry, 100 = wet
	uint8_t battery_soc;   // %
	uint8_t air_humidity;  // %
	int8_t temperature;    // degC
};

/* Checks the sensors and configures the soil sensor power outputs (off).
 * Returns a mask of the SENSOR_* bits that are not available (0 if all are). */
uint32_t sensors_init(void);

/* Takes a first sample now (blocking, about SOIL_POWER_UP_MS), then every
 * HACOAP_SENSOR_SAMPLE_PERIOD_S from the system work queue. */
void sensors_start(void);

/* Returns the latest readings. Safe to call from any thread. */
struct sensors_data sensors_get(void);

#endif // SENSORS_H_
