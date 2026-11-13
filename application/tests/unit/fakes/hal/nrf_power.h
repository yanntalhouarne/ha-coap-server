/* Fake of nrfx's <hal/nrf_power.h>: the USB power detection, from fake_vbus (see fake.h) */
#include <fake.h>

#define NRF_POWER NULL

static inline bool nrf_power_usbregstatus_vbusdet_get(const void *p_reg)
{
	(void)p_reg;
	return fake_vbus;
}
