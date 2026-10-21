// GENERATED FILE - edit firmware/src/*.cpp|h and run tools/make_wokwi_single.py
/*
 * Active-RCA replay node - ESP32 (Wokwi)
 * IoT & LLM-based Predictive Maintenance with Active Root-Cause Analysis
 * PCCoE E&TC | B.Tech MDM IoT | 2026-27 | Mehul Rawat, Atharva Palande | Guide: Prof. Kalpana Patil
 *
 * One simulated node, MOTOR-01, stands in for three real machines. It fetches recorded windows
 * of the chosen machine/condition/operating point from GitHub Pages over HTTPS, computes 18 edge
 * features per 2 s window (pdm_features.h - same maths as training), and publishes
 * pdm.telemetry.v1.1 over MQTT/TLS. The reasoning layer can order an active test on /cmd: the
 * node switches to the recording of the SAME condition at the requested operating point for the
 * hold time, tags those windows with the test id, then returns to where it left off.
 *
 *   /cmd  {"v":1,"cmd":"scenario","src":"S2","cond":"EF","op":"500"}     inject a condition
 *         {"v":1,"cmd":"test","id":"E3-T1","op":"750","hold_s":20}       active test
 *         {"v":1,"cmd":"abort"}                                          end a running test
 *
 * Commands take effect at the next window boundary (<= 2 s). Buttons do the same as "scenario":
 * FAULT cycles the injected condition, SOURCE cycles the machine.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <time.h>
#include <sys/time.h>
#include "mbedtls/ecp.h"

// ============================================================================
//  config.h - INLINED by tools/make_wokwi_single.py (edit src/config.h, not this)
// ============================================================================
/*
 * config.h - Active-RCA replay node (Wokwi ESP32)
 * IoT & LLM-based Predictive Maintenance with Active Root-Cause Analysis
 * PCCoE E&TC | B.Tech MDM IoT | 2026-27
 *
 * Every tunable in one place. Topic root, data URL and broker must match bridge/config.json
 * and site/config.js - tools/set_site.py rewrites all three together.
 */

// ---------------------------------------------------------------- identity
#define FW_VERSION        "arca-1.1.0"
#define DEVICE_ID         "MOTOR-01"
#define SCHEMA_NAME       "pdm.telemetry.v1.1"
// Random per-installation id. Keeps this demo's topics apart from everyone else on the
// public broker (and stops strangers' traffic reaching this node).
#define SITE_ID           "add1f2"

// ---------------------------------------------------------------- network
#define WIFI_SSID         "Wokwi-GUEST"
#define WIFI_PASS         ""
#define WIFI_CHANNEL      6

// ---------------------------------------------------------------- build profile
// Every 2 s window is fetched from GitHub Pages with one HTTPS Range request over a single
// keep-alive connection, so the node needs exactly one TLS handshake for its data.
// WOKWI_BUILD 1 - simulator: telemetry over plain MQTT (1883). Inside Wokwi each TLS handshake costs
//   minutes of real time (the crypto is emulated instruction by instruction), so this saves one, and
//   the node is online at once while the GitHub handshake is still being retried.
// WOKWI_BUILD 0 - real ESP32: MQTT over TLS (8883) with the pinned Amazon root as well.
#define WOKWI_BUILD       1
#if WOKWI_BUILD
  #define MQTT_TLS        0
#else
  #define MQTT_TLS        1
#endif

// Replay slices on GitHub Pages: https://DATA_HOST DATA_BASE <src>/<cond>_<op>.bin
#define DATA_HOST         "kalaaiintern01-commits.github.io"
#define DATA_BASE         "/active-rca-demo/data/"

// broker.hivemq.com is HiveMQ's public broker; for a private HiveMQ Cloud cluster put its host
// here plus a credential limited to this topic root (Cloud clusters are TLS-only: WOKWI_BUILD 0).
#define MQTT_HOST         "broker.hivemq.com"
#if MQTT_TLS
  #define MQTT_PORT       8883
#else
  #define MQTT_PORT       1883
#endif
#define MQTT_USER         ""
#define MQTT_PASS         ""

// 1 = verify servers against the pinned roots in certs.h. 0 = encrypt without verifying
// (only to debug a CA problem - never for a deployment).
#define TLS_VERIFY        1
// Offer only the P-256 curve (mbedTLS 2.x on the ESP32 has an optimised P-256 path).
#define TLS_P256_ONLY     1

#define TOPIC_ROOT        "pccoe/arca/" SITE_ID "/" DEVICE_ID
#define TOPIC_TELEMETRY   TOPIC_ROOT "/telemetry"
#define TOPIC_STATUS      TOPIC_ROOT "/status"    // retained + last will
#define TOPIC_CMD         TOPIC_ROOT "/cmd"       // scenario / test / abort
#define TOPIC_ALERT       TOPIC_ROOT "/alert"     // bridge -> node: current diagnosis (retained)

#define MQTT_BUFFER_BYTES 2048
// Generous keepalive: in Wokwi a TLS handshake or a slow download can stretch simulated seconds
// into much longer real ones, and the broker times clients out in real time (1.5 x keepalive).
#define MQTT_KEEPALIVE_S  120
#define TLS_HANDSHAKE_S   60

// ---------------------------------------------------------------- replay
#define WINDOW_MS         2000UL   // one replay window = 2 s of recorded data
#define REPLAY_REALTIME   1        // 1: never publish faster than one window per WINDOW_MS
#define HTTP_TIMEOUT_MS   20000UL
#define DEFAULT_SRC       0        // 0=S1 Paderborn, 1=S2 CubeMars, 2=S3 CARTIF
#define DEFAULT_COND      0        // 0 = the healthy condition of that source
#define TEST_HOLD_MIN_S   4
#define TEST_HOLD_MAX_S   60

// ---------------------------------------------------------------- pins
#define PIN_I2C_SDA       21       // SSD1306 OLED
#define PIN_I2C_SCL       22
#define OLED_ADDR         0x3C
#define PIN_BTN_FAULT     32       // cycle injected condition within the source
#define PIN_BTN_SOURCE    33       // cycle source S1 -> S2 -> S3
#define PIN_LED_PUB       25       // green: blinks on every publish
#define PIN_LED_TEST      26       // blue:  on while an active test runs
#define PIN_LED_ALARM     27       // red:   on when the reasoning layer reports an alarm

#define NTP_SERVER_1      "pool.ntp.org"
#define NTP_SERVER_2      "time.google.com"
#define SERIAL_BAUD       115200
// ============================== end of config.h ==============================

// ============================================================================
//  certs.h - INLINED by tools/make_wokwi_single.py (edit src/certs.h, not this)
// ============================================================================
/*
 * certs.h - root CAs pinned by the node.
 *   ISRG Root X1      -> GitHub Pages (*.github.io, Let's Encrypt chain)   valid to 2035-06-04
 *                        sha256 96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6
 *   Amazon Root CA 1  -> broker.hivemq.com:8883 (Amazon RSA 2048 M04 chain)  valid to 2038-01-17
 *                        sha256 8E:CD:E6:88:4F:3D:87:B1:12:5B:A3:1A:C3:FC:B1:3D:70:16:DE:7F:57:CC:90:4F:E1:CB:97:C6:AE:98:19:6E
 * Fetched from letsencrypt.org/certs and amazontrust.com/repository; fingerprints checked with openssl.
 */
#include <pgmspace.h>

static const char CA_ISRG_ROOT_X1[] PROGMEM =
"-----BEGIN CERTIFICATE-----\n"
"MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw\n"
"TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh\n"
"cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4\n"
"WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu\n"
"ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY\n"
"MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc\n"
"h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+\n"
"0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U\n"
"A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW\n"
"T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH\n"
"B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC\n"
"B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv\n"
"KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn\n"
"OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn\n"
"jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw\n"
"qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI\n"
"rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV\n"
"HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq\n"
"hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL\n"
"ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ\n"
"3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK\n"
"NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5\n"
"ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur\n"
"TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC\n"
"jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc\n"
"oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq\n"
"4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA\n"
"mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d\n"
"emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=\n"
"-----END CERTIFICATE-----\n";

static const char CA_AMAZON_ROOT_1[] PROGMEM =
"-----BEGIN CERTIFICATE-----\n"
"MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF\n"
"ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6\n"
"b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL\n"
"MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv\n"
"b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj\n"
"ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM\n"
"9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw\n"
"IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6\n"
"VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L\n"
"93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm\n"
"jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC\n"
"AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA\n"
"A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI\n"
"U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs\n"
"N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv\n"
"o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU\n"
"5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy\n"
"rqXRfboQnoZsG4q5WTP468SQvvG5\n"
"-----END CERTIFICATE-----\n";
// ============================== end of certs.h ==============================

// ============================================================================
//  pdm_features.h - INLINED by tools/make_wokwi_single.py (edit src/pdm_features.h, not this)
// ============================================================================
/*
 * pdm_features.h - edge feature extractor (portable C++, no Arduino dependency).
 *
 * Mirrors common/pdmfeat.py line for line, so the healthy baselines learned in training are
 * computed by the same maths the node runs. Streaming: samples are pushed as they arrive from
 * the network, so the node never holds a whole 2 s window in RAM - only one 1024-sample frame
 * per vibration axis (12 kB) plus the FFT work arrays.
 *
 *   time domain   AC RMS (vector over vib axes), peak, crest, kurtosis/skewness of the primary axis,
 *                 per-axis RMS - from raw power sums in double precision
 *   frequency     Welch PSD: non-overlapping 1024-pt Hann frames, per-frame mean removed,
 *                 summed over vib axes; band energy 0-50/50-200/200-800/800-2500 Hz,
 *                 1-5 kHz when fs >= 10 kHz; amplitude at 1x, 2x and pole-pass; dominant frequency
 *   current       true RMS, mean, peak
 */
#include <stdint.h>
#include <math.h>
#include <string.h>

namespace pdm {

static const int NFFT   = 1024;
static const int NBIN   = NFFT / 2 + 1;
static const int MAXCH  = 4;
static const int MAXVIB = 3;

struct Features {
  float rms, peak, crest, kurt, skew;
  float axRms[MAXVIB];
  uint8_t nAx;
  float band[4];
  float bhf;  bool hasBhf;
  float a1x;  bool hasA1x;
  float a2x;  bool hasA2x;
  float app;  bool hasApp;
  float fdom, df;
  int   frames;
  bool  hasCur;
  float curRms, curMean, curPeak;
};

class Extractor {
 public:
  Extractor() { initTables(); }

  void begin(uint32_t fs, uint32_t n, uint8_t nch, uint16_t vibMask, int curCh, const float *scale) {
    fs_ = fs; n_ = n; nch_ = nch > MAXCH ? MAXCH : nch; curCh_ = curCh;
    nvib_ = 0;
    for (uint8_t c = 0; c < nch_; c++) {
      scale_[c] = scale[c];
      if ((vibMask >> c) & 1 && nvib_ < MAXVIB) vibCh_[nvib_++] = c;
      s1_[c] = s2_[c] = 0.0;
      mn_[c] = 1e30f; mx_[c] = -1e30f;
    }
    s3p_ = s4p_ = 0.0;
    count_ = 0; pos_ = 0; frames_ = 0;
    memset(psd_, 0, sizeof(psd_));
  }

  // count sample-frames, each nch interleaved int16
  void push(const int16_t *q, uint32_t count) {
    for (uint32_t i = 0; i < count; i++, q += nch_) {
      for (uint8_t c = 0; c < nch_; c++) {
        float x = (float)q[c] * scale_[c];
        double xd = x;
        s1_[c] += xd; s2_[c] += xd * xd;
        if (x < mn_[c]) mn_[c] = x;
        if (x > mx_[c]) mx_[c] = x;
      }
      if (nvib_) {
        double p = (float)q[vibCh_[0]] * scale_[vibCh_[0]];
        double p2 = p * p;
        s3p_ += p2 * p; s4p_ += p2 * p2;
        for (uint8_t v = 0; v < nvib_; v++) frame_[v][pos_] = (float)q[vibCh_[v]] * scale_[vibCh_[v]];
        if (++pos_ == NFFT) { processFrame(); pos_ = 0; frames_++; }
      }
      count_++;
    }
  }

  void finish(float rpm, int polePairs, Features &f) {
    memset(&f, 0, sizeof(f));
    const double N = count_ ? (double)count_ : 1.0;

    double varSum = 0.0, peak = 0.0;
    f.nAx = nvib_;
    for (uint8_t v = 0; v < nvib_; v++) {
      uint8_t c = vibCh_[v];
      double m1 = s1_[c] / N, m2 = s2_[c] / N;
      double var = m2 - m1 * m1; if (var < 0) var = 0;
      varSum += var;
      f.axRms[v] = (float)sqrt(var);
      double up = mx_[c] - m1, dn = m1 - mn_[c];
      if (up > peak) peak = up;
      if (dn > peak) peak = dn;
    }
    f.rms = (float)sqrt(varSum);
    f.peak = (float)peak;
    f.crest = f.rms > 0 ? (float)(peak / f.rms) : 0.0f;

    if (nvib_) {
      uint8_t c = vibCh_[0];
      double e1 = s1_[c] / N, e2 = s2_[c] / N, e3 = s3p_ / N, e4 = s4p_ / N;
      double mu2 = e2 - e1 * e1;
      double mu3 = e3 - 3 * e1 * e2 + 2 * e1 * e1 * e1;
      double mu4 = e4 - 4 * e1 * e3 + 6 * e1 * e1 * e2 - 3 * e1 * e1 * e1 * e1;
      f.kurt = mu2 > 0 ? (float)(mu4 / (mu2 * mu2)) : 0.0f;
      f.skew = mu2 > 0 ? (float)(mu3 / pow(mu2, 1.5)) : 0.0f;
    }

    // one-sided PSD, averaged over frames
    const double norm = 1.0 / ((frames_ ? frames_ : 1) * (double)fs_ * hannS2_);
    const double df = (double)fs_ / NFFT;
    for (int k = 0; k < NBIN; k++) {
      psd_[k] *= norm;
      if (k > 0 && k < NBIN - 1) psd_[k] *= 2.0;
    }
    static const float BANDS[4][2] = {{0, 50}, {50, 200}, {200, 800}, {800, 2500}};
    for (int b = 0; b < 4; b++) f.band[b] = band(BANDS[b][0], BANDS[b][1], df);
    f.hasBhf = fs_ >= 10000;
    if (f.hasBhf) f.bhf = band(1000, 5000, df);

    double fr = rpm / 60.0;
    f.hasA1x = amp(fr, df, f.a1x);
    f.hasA2x = amp(2 * fr, df, f.a2x);
    f.hasApp = amp(polePairs * fr, df, f.app);

    int kmax = 2;
    for (int k = 3; k < NBIN; k++) if (psd_[k] > psd_[kmax]) kmax = k;
    f.fdom = (float)(kmax * df);
    f.df = (float)df;
    f.frames = frames_;

    f.hasCur = curCh_ >= 0 && curCh_ < nch_;
    if (f.hasCur) {
      f.curRms = (float)sqrt(s2_[curCh_] / N);
      f.curMean = (float)(s1_[curCh_] / N);
      f.curPeak = fabsf(mx_[curCh_]) > fabsf(mn_[curCh_]) ? fabsf(mx_[curCh_]) : fabsf(mn_[curCh_]);
    }
  }

 private:
  uint32_t fs_ = 0, n_ = 0, count_ = 0;
  uint8_t nch_ = 0, nvib_ = 0, vibCh_[MAXVIB] = {0};
  int curCh_ = -1, pos_ = 0, frames_ = 0;
  float scale_[MAXCH] = {0}, mn_[MAXCH] = {0}, mx_[MAXCH] = {0};
  double s1_[MAXCH] = {0}, s2_[MAXCH] = {0}, s3p_ = 0, s4p_ = 0;
  float frame_[MAXVIB][NFFT];
  double psd_[NBIN];
  float re_[NFFT], im_[NFFT];

  static float hann_[NFFT];
  static float cos_[NFFT / 2], sin_[NFFT / 2];
  static double hannS2_;
  static bool tables_;

  static void initTables() {
    if (tables_) return;
    hannS2_ = 0.0;
    for (int i = 0; i < NFFT; i++) {
      hann_[i] = (float)(0.5 - 0.5 * cos(2.0 * M_PI * i / NFFT));
      hannS2_ += (double)hann_[i] * hann_[i];
    }
    for (int i = 0; i < NFFT / 2; i++) {
      cos_[i] = (float)cos(2.0 * M_PI * i / NFFT);
      sin_[i] = (float)sin(2.0 * M_PI * i / NFFT);
    }
    tables_ = true;
  }

  float band(double lo, double hi, double df) const {
    double s = 0.0;
    for (int k = 0; k < NBIN; k++) {
      double fk = k * df;
      if (fk >= lo && fk < hi) s += psd_[k];
    }
    return (float)(s * df);
  }

  bool amp(double f0, double df, float &out) const {
    long k0 = lround(f0 / df);
    if (f0 <= 0 || k0 + 1 >= NBIN - 1) return false;
    double s = 0.0;
    for (long k = (k0 - 1 < 1 ? 1 : k0 - 1); k <= k0 + 1; k++) s += psd_[k];
    out = (float)sqrt(s * df);
    return true;
  }

  void processFrame() {
    for (uint8_t v = 0; v < nvib_; v++) {
      double mean = 0.0;
      for (int i = 0; i < NFFT; i++) mean += frame_[v][i];
      mean /= NFFT;
      for (int i = 0; i < NFFT; i++) {
        re_[i] = (float)((frame_[v][i] - mean) * hann_[i]);
        im_[i] = 0.0f;
      }
      fft();
      for (int k = 0; k < NBIN; k++) psd_[k] += (double)re_[k] * re_[k] + (double)im_[k] * im_[k];
    }
  }

  // iterative radix-2 Cooley-Tukey, in place on re_/im_
  void fft() {
    for (int i = 1, j = 0; i < NFFT; i++) {
      int bit = NFFT >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        float t = re_[i]; re_[i] = re_[j]; re_[j] = t;
        t = im_[i]; im_[i] = im_[j]; im_[j] = t;
      }
    }
    for (int len = 2; len <= NFFT; len <<= 1) {
      int half = len >> 1, step = NFFT / len;
      for (int i = 0; i < NFFT; i += len) {
        for (int k = 0; k < half; k++) {
          float wr = cos_[k * step], wi = -sin_[k * step];
          int a = i + k, b = a + half;
          float tr = re_[b] * wr - im_[b] * wi;
          float ti = re_[b] * wi + im_[b] * wr;
          re_[b] = re_[a] - tr; im_[b] = im_[a] - ti;
          re_[a] += tr;         im_[a] += ti;
        }
      }
    }
  }
};

float  Extractor::hann_[NFFT];
float  Extractor::cos_[NFFT / 2];
float  Extractor::sin_[NFFT / 2];
double Extractor::hannS2_ = 0.0;
bool   Extractor::tables_ = false;

}  // namespace pdm
// ============================== end of pdm_features.h ==============================


// ============================================================================
//  Scenario catalogue - must match training/build_dataset.py (SOURCES)
// ============================================================================
struct SrcDef {
  const char *id;
  const char *const *conds; uint8_t nConds;
  const char *const *ops;   uint8_t nOps;
  uint8_t defOp, polePairs, nch;
  uint16_t fs;
};
static const char *const S1_CONDS[] = {"K001", "KA01"};
static const char *const S1_OPS[]   = {"N09_M07_F10", "N15_M01_F10", "N15_M07_F04", "N15_M07_F10"};
static const char *const S2_CONDS[] = {"NR", "BF", "EF", "MF", "SF"};
static const char *const S2_OPS[]   = {"500", "750", "1000"};
static const char *const S3_CONDS[] = {"NEW", "RUN"};
static const char *const S3_OPS[]   = {"3V", "5V"};
static const SrcDef SRCS[] = {
  {"S1", S1_CONDS, 2, S1_OPS, 4, 0, 4, 2, 10000},
  {"S2", S2_CONDS, 5, S2_OPS, 3, 0, 14, 3, 5000},
  {"S3", S3_CONDS, 2, S3_OPS, 2, 0, 1, 2, 5000},
};
static const uint8_t NSRC = sizeof(SRCS) / sizeof(SRCS[0]);
static const char *const SRC_IDS[] = {"S1", "S2", "S3"};

struct __attribute__((packed)) WinHdr {
  uint32_t magic; uint16_t nch, flags; uint32_t fs, n;
  float rpm, temp, aux; float scale[4]; uint16_t vibMask, curCh;
};
static_assert(sizeof(WinHdr) == 48, "window header must be 48 bytes");
static const uint32_t WIN_MAGIC = 0x574D4450;  // "PDMW"

static uint32_t winBytes(const SrcDef &s) { return sizeof(WinHdr) + (uint32_t)s.fs * (WINDOW_MS / 1000) * s.nch * 2; }

// ============================================================================
//  State
// ============================================================================
WiFiClientSecure httpsNet;
#if MQTT_TLS
WiFiClientSecure mqttNet;
#else
WiFiClient mqttNet;
#endif
HTTPClient http;
PubSubClient mqtt(mqttNet);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
bool oledOk = false;

pdm::Extractor ext;
pdm::Features feat;
WinHdr hdr;

struct { uint8_t src, cond, baseOp; uint32_t epoch; } scn = {DEFAULT_SRC, DEFAULT_COND, 0, 1};
struct { bool active; char id[32]; uint8_t op; uint16_t hold, done; bool settle; uint32_t resumeWin; } test = {};
struct { bool scn; uint8_t src, cond, op; bool test; char id[32]; uint8_t top; uint16_t hold; bool abort; } pend = {};
struct { uint8_t op; uint32_t win, total; char path[72]; } rp = {};
struct { char id[32]; bool ok; char msg[48]; } ack = {"", true, ""};
struct { char state[12]; char cause[32]; float p; char sev[8]; } dx = {"", "", 0, ""};

uint32_t seq = 0, mqttReconn = 0, httpReconn = 0, pubFails = 0;
uint32_t lastPubMs = 0, nextMqttTry = 0, mqttBackoff = 1000, httpRetryAt = 0;
bool statusDirty = true, tsSynced = false;
const char *lastWinPhase = nullptr;
uint16_t lastWinLeft = 0;
uint32_t lastWinIdx = 0;

static const SrcDef &S() { return SRCS[scn.src]; }

// ============================================================================
//  Utilities
// ============================================================================
static bool isoNow(char *buf, size_t len, uint64_t *epochMs) {
  struct timeval tv; gettimeofday(&tv, nullptr);
  *epochMs = (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000;
  struct tm t; gmtime_r(&tv.tv_sec, &t);
  snprintf(buf, len, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
           t.tm_hour, t.tm_min, t.tm_sec, (int)(tv.tv_usec / 1000));
  return tv.tv_sec > 1700000000;
}

static int findIdx(const char *const *list, uint8_t n, const char *s) {
  for (uint8_t i = 0; i < n; i++) if (strcmp(list[i], s) == 0) return i;
  return -1;
}

static void setAck(const char *id, bool ok, const char *msg) {
  strlcpy(ack.id, id ? id : "", sizeof(ack.id));
  ack.ok = ok;
  strlcpy(ack.msg, msg, sizeof(ack.msg));
  statusDirty = true;
  Serial.printf("[cmd] %s %s %s\n", ack.id, ok ? "ok" : "REJECTED", msg);
}

// ============================================================================
//  OLED - the operator's view of what is injected and what the reasoner concluded
// ============================================================================
static void drawOled() {
  if (!oledOk) return;
  const SrcDef &s = S();
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
  oled.printf("ARCA %s  scn %lu\n", s.id, (unsigned long)scn.epoch);
  oled.printf("inject: %s\n", s.conds[scn.cond]);
  oled.printf("op: %s\n", s.ops[rp.op]);
  if (seq) {
    oled.printf("rms %.3f %s\n", feat.rms, (hdr.flags & 1) ? "m/s2" : "au");
    if (hdr.flags & 2) oled.printf("T %.1fC ", hdr.temp); else oled.print("T --   ");
    if (feat.hasCur) oled.printf("I %.2fA\n", feat.curRms); else oled.print("I --\n");
  } else {
    oled.print("waiting for data\n\n");
  }
  if (test.active) oled.printf("TEST %s %u/%u\n", s.ops[test.op], test.done, test.hold);
  else oled.printf("win %lu/%lu #%lu\n", (unsigned long)lastWinIdx + 1, (unsigned long)rp.total, (unsigned long)seq);
  if (dx.cause[0]) oled.printf("dx %.13s %d%%\n", dx.cause, (int)(dx.p * 100 + 0.5f));
  else if (dx.state[0]) oled.printf("dx %s\n", dx.state);
  else oled.print("dx --\n");
  oled.printf("wifi %s mqtt %s", WiFi.status() == WL_CONNECTED ? "ok" : "--", mqtt.connected() ? "ok" : "--");
  oled.display();
}

// ============================================================================
//  MQTT
// ============================================================================
static void publishStatus() {
  if (!mqtt.connected()) return;
  JsonDocument d;
  const SrcDef &s = S();
  d["online"] = true;
  d["device_id"] = DEVICE_ID;
  d["fw"] = FW_VERSION;
  d["src"] = s.id;
  d["cond"] = s.conds[scn.cond];
  d["op"] = s.ops[rp.op];
  d["base_op"] = s.ops[scn.baseOp];
  d["scn"] = scn.epoch;
  if (test.active) {
    JsonObject t = d["test"].to<JsonObject>();
    t["id"] = test.id; t["op"] = s.ops[test.op]; t["hold"] = test.hold; t["done"] = test.done;
  } else {
    d["test"] = nullptr;
  }
  JsonObject r = d["replay"].to<JsonObject>();
  r["file"] = rp.path; r["win"] = lastWinIdx; r["of"] = rp.total;
  JsonObject a = d["ack"].to<JsonObject>();
  a["id"] = ack.id; a["ok"] = ack.ok; a["msg"] = ack.msg;
  d["ip"] = WiFi.localIP().toString();
  d["rssi"] = WiFi.RSSI();
  d["heap_kb"] = ESP.getFreeHeap() / 1024;
  d["uptime_s"] = millis() / 1000;
  char buf[640];
  size_t n = serializeJson(d, buf, sizeof(buf));
  mqtt.publish(TOPIC_STATUS, (const uint8_t *)buf, n, true);
  statusDirty = false;
}

static void handleCmd(JsonDocument &d) {
  const char *cmd = d["cmd"] | "";
  const char *id = d["id"] | "";
  const SrcDef &s = S();
  if (strcmp(cmd, "scenario") == 0) {
    int si = findIdx(SRC_IDS, NSRC, d["src"] | s.id);
    if (si < 0) return setAck(id, false, "unknown src");
    const SrcDef &t = SRCS[si];
    int ci = d["cond"].is<const char *>() ? findIdx(t.conds, t.nConds, d["cond"].as<const char *>()) : 0;
    int oi = d["op"].is<const char *>() ? findIdx(t.ops, t.nOps, d["op"].as<const char *>()) : t.defOp;
    if (ci < 0) return setAck(id, false, "unknown cond");
    if (oi < 0) return setAck(id, false, "unknown op");
    pend.scn = true; pend.src = si; pend.cond = ci; pend.op = oi;
    setAck(id, true, "scenario queued");
  } else if (strcmp(cmd, "test") == 0) {
    int oi = findIdx(s.ops, s.nOps, d["op"] | "");
    int hold = d["hold_s"] | 20;
    if (!id[0]) return setAck(id, false, "test needs id");
    if (test.active || pend.test) return setAck(id, false, "busy: test running");
    if (oi < 0) return setAck(id, false, "unknown op");
    if (oi == scn.baseOp) return setAck(id, false, "op equals current op");
    hold = constrain(hold, TEST_HOLD_MIN_S, TEST_HOLD_MAX_S);
    pend.test = true; pend.top = oi; pend.hold = (hold + 1) / 2;
    strlcpy(pend.id, id, sizeof(pend.id));
    setAck(id, true, "test queued");
  } else if (strcmp(cmd, "abort") == 0) {
    pend.abort = true;
    setAck(id, true, "abort queued");
  } else {
    setAck(id, false, "unknown cmd");
  }
}

static void onMqtt(char *topic, uint8_t *payload, unsigned int len) {
  // PubSubClient reuses its buffer for outgoing messages: parse here, publish later (statusDirty)
  JsonDocument d;
  if (deserializeJson(d, payload, len)) {
    if (strcmp(topic, TOPIC_CMD) == 0) setAck("", false, "bad json");
    return;
  }
  if (strcmp(topic, TOPIC_CMD) == 0) {
    if ((d["v"] | 0) != 1) return setAck(d["id"] | "", false, "need v:1");
    handleCmd(d);
  } else if (strcmp(topic, TOPIC_ALERT) == 0) {
    strlcpy(dx.state, d["state"] | "", sizeof(dx.state));
    strlcpy(dx.cause, d["cause"] | "", sizeof(dx.cause));
    strlcpy(dx.sev, d["severity"] | "", sizeof(dx.sev));
    dx.p = d["p"] | 0.0f;
    digitalWrite(PIN_LED_ALARM, strcmp(dx.sev, "alarm") == 0 ? HIGH : LOW);
    drawOled();
  }
}

static bool mqttConnectOnce() {
  char cid[40];
  snprintf(cid, sizeof(cid), "arca-%s-%04x", DEVICE_ID, (unsigned)(esp_random() & 0xffff));
  char will[64];
  snprintf(will, sizeof(will), "{\"online\":false,\"device_id\":\"%s\"}", DEVICE_ID);
  Serial.printf("[mqtt] connecting %s:%d %s ... ", MQTT_HOST, MQTT_PORT, MQTT_TLS ? "tls" : "plain");
  bool ok = mqtt.connect(cid, MQTT_USER[0] ? MQTT_USER : nullptr, MQTT_PASS[0] ? MQTT_PASS : nullptr,
                         TOPIC_STATUS, 1, true, will);
  if (!ok) {
    char e[96] = "";
#if MQTT_TLS
    mqttNet.lastError(e, sizeof(e));
#endif
    Serial.printf("failed state=%d %s\n", mqtt.state(), e);
    return false;
  }
  Serial.println("connected");
  mqtt.subscribe(TOPIC_CMD, 1);
  mqtt.subscribe(TOPIC_ALERT, 0);
  statusDirty = true;
  return true;
}

static void mqttEnsure() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED || millis() < nextMqttTry) return;
  if (mqttConnectOnce()) { mqttBackoff = 1000; mqttReconn++; }
  else { nextMqttTry = millis() + mqttBackoff; mqttBackoff = mqttBackoff >= 15000 ? 30000 : mqttBackoff * 2; }
}

// ---------------------------------------------------------------- buttons
static void pollButtons() {
  static uint8_t last[2] = {HIGH, HIGH};
  static uint32_t at[2] = {0, 0};
  const uint8_t pins[2] = {PIN_BTN_FAULT, PIN_BTN_SOURCE};
  for (int i = 0; i < 2; i++) {
    uint8_t v = digitalRead(pins[i]);
    if (v != last[i] && millis() - at[i] > 60) {
      at[i] = millis(); last[i] = v;
      if (v == LOW) {
        pend.scn = true;
        if (i == 0) { pend.src = scn.src; pend.cond = (scn.cond + 1) % S().nConds; pend.op = scn.baseOp; }
        else { pend.src = (scn.src + 1) % NSRC; pend.cond = 0; pend.op = SRCS[pend.src].defOp; }
        Serial.printf("[btn] %s -> %s %s\n", i ? "SOURCE" : "FAULT", SRCS[pend.src].id, SRCS[pend.src].conds[pend.cond]);
      }
    }
  }
}

// called from every wait loop so commands, keepalives and buttons never stall behind a download
static void service() {
  if (mqtt.connected()) mqtt.loop();
  if (statusDirty) publishStatus();
  pollButtons();
}

static bool dataEverOk = false;

// ============================================================================
//  Replay - one HTTP Range request per window over ONE persistent HTTPS connection
//
//  A TLS handshake is by far the most expensive thing the ESP32 does, so the node does exactly one
//  and then keeps the connection alive: each window is fetched with "Range: bytes=a-b" and its body
//  is always read to the end, which keeps the keep-alive connection reusable across windows, files,
//  tests and scenarios.
// ============================================================================
static void dropConnection() {   // only after an error: the next request re-handshakes
  httpsNet.stop();
  http.end();
}
static void endWindow() { http.end(); }   // body fully read: the connection stays open

// Request window `win` of the current recording at op. On 206 the body (exactly one window) is
// ready to stream. Returns the HTTP status, or a negative HTTPClient error.
static int fetchWindow(uint8_t op, uint32_t win) {
  const SrcDef &s = S();
  snprintf(rp.path, sizeof(rp.path), "%s%s/%s_%s.bin", DATA_BASE, s.id, s.conds[scn.cond], s.ops[op]);
  const uint32_t wb = winBytes(s);
  static const char *KEEP[] = {"Content-Range"};
  http.setReuse(true);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  // HTTPClient already sends "Accept-Encoding: identity;q=1,chunked;q=0.1,*;q=0", so GitHub Pages
  // returns the raw bytes (it would gzip .bin if the client allowed it)
  if (!http.begin(httpsNet, DATA_HOST, 443, rp.path, true)) return -1;
  http.collectHeaders(KEEP, 1);
  char range[40];
  snprintf(range, sizeof(range), "bytes=%lu-%lu", (unsigned long)(win * wb), (unsigned long)((win + 1) * wb - 1));
  http.addHeader("Range", range);
  int code = http.GET();
  if (code == 206) {
    // Content-Range: bytes a-b/TOTAL  -> number of windows in the recording
    String cr = http.header("Content-Range");
    int slash = cr.lastIndexOf('/');
    if (slash > 0) rp.total = (uint32_t)cr.substring(slash + 1).toInt() / wb;
    if (!dataEverOk) Serial.printf("[http] connected to %s, keep-alive range requests\n", DATA_HOST);
    dataEverOk = true;
    return code;
  }
  char tlsErr[96] = "";
  if (code < 0) httpsNet.lastError(tlsErr, sizeof(tlsErr));
  if (code == 200) Serial.println("[http] server ignored Range - dropping connection");
  if (code < 0 || code == 200) dropConnection(); else http.end();   // 404/416 bodies are tiny
  httpReconn++;
  Serial.printf("[http] %s win %lu -> %d %s %s\n", rp.path, (unsigned long)win, code,
                code < 0 ? HTTPClient::errorToString(code).c_str() : "", tlsErr);
  return code;
}

static bool readExact(uint8_t *dst, size_t len) {
  auto *st = http.getStreamPtr();
  size_t got = 0;
  uint32_t t0 = millis();
  while (got < len) {
    int a = st ? st->available() : 0;
    if (a > 0) {
      size_t want = len - got < (size_t)a ? len - got : (size_t)a;
      int r = st->read(dst + got, want);
      if (r > 0) { got += r; t0 = millis(); }
    } else {
      if (!st || (!st->connected() && !st->available())) return false;
      if (millis() - t0 > HTTP_TIMEOUT_MS) return false;
      service();
      delay(1);
    }
  }
  return true;
}

static bool processWindow() {
  if (!readExact((uint8_t *)&hdr, sizeof(hdr))) return false;
  if (hdr.magic != WIN_MAGIC || hdr.nch == 0 || hdr.nch > pdm::MAXCH) {
    Serial.println("[replay] bad window header");
    return false;
  }
  ext.begin(hdr.fs, hdr.n, hdr.nch, hdr.vibMask, hdr.curCh == 0xFFFF ? -1 : hdr.curCh, hdr.scale);
  static int16_t chunk[512 * pdm::MAXCH];
  uint32_t left = hdr.n;
  while (left) {
    uint32_t take = left < 512 ? left : 512;
    if (!readExact((uint8_t *)chunk, take * hdr.nch * 2)) return false;
    ext.push(chunk, take);
    left -= take;
    service();
  }
  ext.finish(hdr.rpm, S().polePairs, feat);
  return true;
}

// ============================================================================
//  Telemetry - pdm.telemetry.v1.1
// ============================================================================
static void publishTelemetry() {
  const SrcDef &s = S();
  JsonDocument d;
  char ts[32]; uint64_t ms;
  tsSynced = isoNow(ts, sizeof(ts), &ms);
  d["schema"] = SCHEMA_NAME;
  d["device_id"] = DEVICE_ID;
  d["src"] = s.id;
  d["fw"] = FW_VERSION;
  d["seq"] = ++seq;
  d["ts"] = ts;
  d["ts_synced"] = tsSynced;
  d["t_edge_ms"] = ms;
  d["uptime_s"] = millis() / 1000;
  d["label"] = s.conds[scn.cond];          // injected ground truth - the bridge never shows it to the LLM
  d["scn"] = scn.epoch;
  d["op"] = s.ops[rp.op];
  if (lastWinPhase) {
    JsonObject t = d["test"].to<JsonObject>();
    t["id"] = test.id; t["phase"] = lastWinPhase; t["left"] = lastWinLeft;
  }
  JsonObject r = d["replay"].to<JsonObject>();
  r["file"] = rp.path; r["win"] = lastWinIdx; r["of"] = rp.total;

  JsonObject te = d["temp"].to<JsonObject>();
  bool tv = (hdr.flags & 2) && isfinite(hdr.temp);
  te["c"] = tv ? hdr.temp : 0.0f; te["valid"] = tv;

  JsonObject v = d["vib"].to<JsonObject>();
  v["rms_ms2"] = feat.rms; v["peak_ms2"] = feat.peak; v["crest"] = feat.crest;
  static const char *AX[3] = {"x_rms", "y_rms", "z_rms"};
  for (uint8_t i = 0; i < feat.nAx; i++) v[AX[i]] = feat.axRms[i];
  v["valid"] = true; v["cal_ok"] = (bool)(hdr.flags & 1);

  JsonObject sp = d["spec"].to<JsonObject>();
  sp["kurt"] = feat.kurt; sp["skew"] = feat.skew;
  sp["b0"] = feat.band[0]; sp["b1"] = feat.band[1]; sp["b2"] = feat.band[2]; sp["b3"] = feat.band[3];
  if (feat.hasBhf) sp["bhf"] = feat.bhf; else sp["bhf"] = nullptr;
  if (feat.hasA1x) sp["a1x"] = feat.a1x; else sp["a1x"] = nullptr;
  if (feat.hasA2x) sp["a2x"] = feat.a2x; else sp["a2x"] = nullptr;
  if (feat.hasApp) sp["app"] = feat.app; else sp["app"] = nullptr;
  sp["fdom"] = feat.fdom; sp["df"] = feat.df; sp["frames"] = feat.frames;

  JsonObject c = d["cur"].to<JsonObject>();
  c["rms_a"] = feat.hasCur ? feat.curRms : 0.0f;
  c["mean_a"] = feat.hasCur ? feat.curMean : 0.0f;
  c["peak_a"] = feat.hasCur ? feat.curPeak : 0.0f;
  c["valid"] = feat.hasCur; c["cal_ok"] = feat.hasCur;

  JsonObject rr = d["rpm"].to<JsonObject>();
  rr["avg"] = hdr.rpm; rr["inst"] = hdr.rpm;
  if (s.id[1] == '1') rr["torque_nm"] = hdr.aux;
  if (s.id[1] == '3') rr["supply_v"] = hdr.aux;

  JsonObject w = d["win"].to<JsonObject>();
  w["ms"] = WINDOW_MS; w["n"] = hdr.n; w["sample_hz"] = hdr.fs; w["dropped"] = 0;
  w["t0_s"] = lastWinIdx * (WINDOW_MS / 1000);

  JsonObject n = d["net"].to<JsonObject>();
  n["rssi"] = WiFi.RSSI(); n["tls"] = (bool)MQTT_TLS; n["mqtt_reconn"] = mqttReconn;
  n["http_reconn"] = httpReconn; n["publish_fails"] = pubFails; n["heap_kb"] = ESP.getFreeHeap() / 1024;

  static char buf[MQTT_BUFFER_BYTES - 128];
  size_t len = serializeJson(d, buf, sizeof(buf));
  bool ok = mqtt.connected() && len > 0 && len < sizeof(buf) - 1 &&
            mqtt.publish(TOPIC_TELEMETRY, (const uint8_t *)buf, len, false);
  if (!ok) pubFails++;
  digitalWrite(PIN_LED_PUB, HIGH);
  Serial.printf("[pub] #%lu %s %s %s rms=%.3f%s %s len=%u heap=%uk%s\n", (unsigned long)seq, s.id,
                s.conds[scn.cond], s.ops[rp.op], feat.rms, (hdr.flags & 1) ? "m/s2" : "au",
                lastWinPhase ? lastWinPhase : "", (unsigned)len, ESP.getFreeHeap() / 1024, ok ? "" : " FAIL");
}

// ============================================================================
//  Scenario / test transitions - only ever applied between windows
// ============================================================================
static void endTest(const char *why) {
  Serial.printf("[test] %s %s\n", test.id, why);
  rp.op = scn.baseOp;
  rp.win = test.resumeWin;          // continue the base recording where it was left
  test.active = false;
  digitalWrite(PIN_LED_TEST, LOW);
  statusDirty = true;
}

static void applyPending() {
  if (pend.scn) {
    pend.scn = false;
    if (test.active) endTest("cancelled by scenario change");
    scn.src = pend.src; scn.cond = pend.cond; scn.baseOp = pend.op; scn.epoch++;
    rp.op = scn.baseOp; rp.win = 0; rp.total = 0;
    pend.test = false;
    statusDirty = true;
    Serial.printf("[scn] #%lu %s %s %s\n", (unsigned long)scn.epoch, S().id, S().conds[scn.cond], S().ops[scn.baseOp]);
    drawOled();
  }
  if (pend.abort) {
    pend.abort = false;
    if (test.active) endTest("aborted");
  }
  if (pend.test) {
    pend.test = false;
    test.active = true;
    strlcpy(test.id, pend.id, sizeof(test.id));
    test.op = pend.top; test.hold = pend.hold; test.done = 0; test.settle = true;
    test.resumeWin = rp.win;        // next unread window of the base recording
    rp.op = test.op; rp.win = 0; rp.total = 0;
    digitalWrite(PIN_LED_TEST, HIGH);
    statusDirty = true;
    Serial.printf("[test] %s -> %s for %u windows\n", test.id, S().ops[test.op], test.hold);
  }
}

// ============================================================================
//  Setup / loop
// ============================================================================
static void wifiUp() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[wifi] joining %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS, WIFI_CHANNEL);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(250); Serial.print('.'); }
  Serial.printf(" %s ip=%s\n", WiFi.status() == WL_CONNECTED ? "up" : "FAILED", WiFi.localIP().toString().c_str());
}

static void timeSync() {
  configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
  uint32_t t0 = millis();
  while (time(nullptr) < 1700000000 && millis() - t0 < 15000) delay(200);
  tsSynced = time(nullptr) > 1700000000;
  Serial.printf("[ntp] %s\n", tsSynced ? "synced" : "NOT synced - TLS certificate dates cannot be checked");
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(200);
  Serial.println("\n=============================================");
  Serial.println(" Active-RCA replay node  " FW_VERSION);
  Serial.println(" device=" DEVICE_ID "  schema=" SCHEMA_NAME);
  Serial.println(" topics " TOPIC_ROOT "/{telemetry,status,cmd,alert}");
  Serial.println("=============================================");
  pinMode(PIN_BTN_FAULT, INPUT_PULLUP);
  pinMode(PIN_BTN_SOURCE, INPUT_PULLUP);
  pinMode(PIN_LED_PUB, OUTPUT);
  pinMode(PIN_LED_TEST, OUTPUT);
  pinMode(PIN_LED_ALARM, OUTPUT);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(400000);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  Serial.printf("[oled] %s\n", oledOk ? "ok" : "not found (continuing)");

  rp.op = scn.baseOp = S().defOp;
  drawOled();
  wifiUp();
  timeSync();
#if TLS_P256_ONLY
  // mbedtls_ssl_config_defaults() takes its curve offer from this static list, so trimming it
  // here applies to every TLS connection the node opens afterwards.
  {
    mbedtls_ecp_group_id *curves = (mbedtls_ecp_group_id *)mbedtls_ecp_grp_id_list();
    curves[0] = MBEDTLS_ECP_DP_SECP256R1;
    curves[1] = MBEDTLS_ECP_DP_NONE;
    Serial.println("[tls] offering curve P-256 only");
  }
#endif
#if TLS_VERIFY
  httpsNet.setCACert(CA_ISRG_ROOT_X1);
#else
  httpsNet.setInsecure();
#endif
  httpsNet.setHandshakeTimeout(TLS_HANDSHAKE_S);
#if MQTT_TLS
#if TLS_VERIFY
  mqttNet.setCACert(CA_AMAZON_ROOT_1);
#else
  mqttNet.setInsecure();
#endif
  mqttNet.setHandshakeTimeout(TLS_HANDSHAKE_S);
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(MQTT_BUFFER_BYTES);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  mqtt.setSocketTimeout(30);
  mqtt.setCallback(onMqtt);
  // MQTT connects after the first HTTPS handshake (see loop) so the slow GitHub handshake
  // cannot stall an open MQTT session past the broker's keepalive
  drawOled();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { dropConnection(); wifiUp(); return; }
  // Plain MQTT connects at once. With MQTT over TLS, wait for the (slow) first GitHub handshake so
  // a second handshake in flight cannot push the open MQTT session past the broker's keepalive.
  if (!MQTT_TLS || dataEverOk || millis() > 120000) mqttEnsure();
  service();
  applyPending();
  if (millis() < httpRetryAt) { delay(10); return; }

  if (rp.total && rp.win >= rp.total) rp.win = 0;          // loop the recording
  int code = fetchWindow(rp.op, rp.win);
  if (code == 416 && rp.win) { rp.win = 0; return; }        // past the end -> wrap next pass
  if (code == 404 && test.active) {
    setAck(test.id, false, "unavailable: no recording at that op");
    endTest("unavailable");
    return;
  }
  if (code != 206) { httpRetryAt = millis() + (code < 0 ? 2000 : 5000); return; }

  // phase of this window (for the telemetry tag)
  lastWinPhase = nullptr;
  if (test.active && rp.op == test.op) {
    lastWinPhase = test.settle ? "settle" : "run";
    lastWinLeft = test.hold - test.done - (test.settle ? 0 : 1);
  }
  lastWinIdx = rp.win;

  bool ok = processWindow();
  if (!ok) {
    Serial.println("[replay] window read failed - reconnecting");
    dropConnection();
    httpRetryAt = millis() + 1000;
    return;
  }
  endWindow();
  rp.win++;

#if REPLAY_REALTIME
  while (millis() - lastPubMs < WINDOW_MS) { service(); delay(5); }
#endif
  lastPubMs = millis();
  if (!mqtt.connected()) mqttEnsure();
  publishTelemetry();

  if (test.active && lastWinPhase) {
    if (test.settle) test.settle = false; else test.done++;
    statusDirty = true;
    if (test.done >= test.hold) endTest("done");
  }
  drawOled();
  delay(30);
  digitalWrite(PIN_LED_PUB, LOW);
}
