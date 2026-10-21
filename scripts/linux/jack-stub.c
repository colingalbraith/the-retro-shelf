/* A stand-in for JACK's library (libjack.so.0), for Linux systems without JACK. RetroArch is linked against it even
   when it plays sound another way (PulseAudio, ALSA), so without it RetroArch can't start at all. Every call here
   fails, so RetroArch's JACK sound driver, if chosen, reports it can't start. Used only where no real libjack is
   installed (see the retroarch script in scripts/fetch-emulators.mjs). Part of The Retro Shelf, GPL-3.0. */
#include <stddef.h>

void *jack_client_open(const char *name, int options, int *status, ...) { if (status) *status = 1; return NULL; }
int jack_client_close(void *client) { return 0; }
int jack_activate(void *client) { return -1; }
int jack_deactivate(void *client) { return -1; }
int jack_connect(void *client, const char *from, const char *to) { return -1; }
void jack_free(void *p) { }
unsigned jack_get_buffer_size(void *client) { return 0; }
const char **jack_get_ports(void *client, const char *name, const char *type, unsigned long flags) { return NULL; }
unsigned jack_get_sample_rate(void *client) { return 0; }
void jack_on_shutdown(void *client, void (*fn)(void *), void *arg) { }
void *jack_port_get_buffer(void *port, unsigned frames) { return NULL; }
void jack_port_get_latency_range(void *port, int mode, void *range) { }
const char *jack_port_name(const void *port) { return ""; }
void *jack_port_register(void *client, const char *name, const char *type, unsigned long flags, unsigned long size) { return NULL; }
void *jack_ringbuffer_create(size_t size) { return NULL; }
void jack_ringbuffer_free(void *rb) { }
void jack_ringbuffer_get_read_vector(const void *rb, void *vec) { }
void jack_ringbuffer_read_advance(void *rb, size_t n) { }
size_t jack_ringbuffer_write(void *rb, const char *src, size_t n) { return 0; }
size_t jack_ringbuffer_write_space(const void *rb) { return 0; }
int jack_set_process_callback(void *client, int (*fn)(unsigned, void *), void *arg) { return -1; }
