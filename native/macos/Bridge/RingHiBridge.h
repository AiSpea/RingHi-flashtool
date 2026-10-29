#ifndef RINGHI_BRIDGE_H
#define RINGHI_BRIDGE_H
#include <stdint.h>
#include <stddef.h>
typedef struct { char key[64],parent[64]; int vendor,product,kind,address; } RHDevice;
int rh_usb_scan(RHDevice *devices,int capacity,char *error,int error_size);
void *rh_usb_open(const char *key,int product,int interface_number,char *error,int error_size,int *error_code);
int rh_usb_read(void *wire,unsigned char *data,int capacity,int timeout);
int rh_usb_write(void *wire,const unsigned char *data,int size);
void rh_usb_close(void *wire);
const char *rh_usb_error(int code);
int rh_serial_open(const char *path);
int rh_serial_read(int fd,unsigned char *data,int capacity,int timeout);
int rh_serial_write(int fd,const unsigned char *data,int size);
int rh_spawn(const char *path,char *const argv[],int *output);
int rh_process_poll(int pid,int *exit_code);
void rh_process_stop(int pid);
int rh_legacy_decrypt(const unsigned char *password,int password_size,const unsigned char *cipher,int cipher_size,unsigned char *plain,int *plain_size);
#endif
