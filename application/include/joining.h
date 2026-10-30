/*
 * Yann T.
 *
 * joining.h
 *
 * Joining the Thread network. The SDK's joiner tries once at boot
 * (CONFIG_OPENTHREAD_JOINER_AUTOSTART): if no commissioner accepts joiners at that moment,
 * this tries again, every HACOAP_JOIN_RETRY_S at first, then every HACOAP_JOIN_RETRY_SLOW_S,
 * until the device has a network. It also forgets the network on request, so the device
 * can join another one without a chip erase.
 */

#ifndef JOINING_H_
#define JOINING_H_

#include <stdbool.h>

/* Call after openthread_start(). Retries joining until the device has a network. */
void joining_start(void);

/* True once the device has network credentials (it joined, now or earlier). */
bool joining_has_network(void);

/* Forgets the Thread network and resets, after 'delay_ms' (so that an answer to the request
 * can go out first), and after removing its SRP registration when attached. Only the network
 * is erased: the device's settings and its SRP key stay. It then boots without a network, and
 * joins again. Callable from any thread. */
void joining_forget(int delay_ms);

#endif // JOINING_H_
