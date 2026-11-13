/*
 * Yann T.
 *
 * hacoap_mgmt.h
 */

#ifndef HACOAP_MGMT_H_
#define HACOAP_MGMT_H_

/* The 'hacoap' mcumgr group's ID: the first one for applications (MGMT_GROUP_ID_PERUSER) */
#define HACOAP_MGMT_GROUP 64

/* Registers the 'hacoap' mcumgr group: the device's settings (see hacoap_mgmt.c). */
void hacoap_mgmt_init(void);

#endif // HACOAP_MGMT_H_
