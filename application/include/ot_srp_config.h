// un-comment macro below to append a random number to the SRP service hostname - CHOOSE ONE OF THE THREE OPTIONS BELOW
//#define SRP_CLIENT_RNG 1
#define SRP_CLIENT_UNIQUE 1
//#define SRP_CLIENT_MANUAL 1

#define SRP_CLIENT_MANUAL_ID "87d7a063" // should not contain 0
#define SRP_CLIENT_MANUAL_SIZE 8

#define SRP_CLIENT_HOSTNAME "ha-coap"
#define SRP_CLIENT_SERVICE_INSTANCE "ha-coap"
#define SRP_CLIENT_RAND_SIZE 8
#define SRP_CLIENT_UNIQUE_SIZE 8
#define SRP_SERVICE_NAME "_ot._udp"
