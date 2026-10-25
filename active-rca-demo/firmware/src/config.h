/*
 * config.h - Active-RCA replay node (Wokwi ESP32)
 * IoT & LLM-based Predictive Maintenance with Active Root-Cause Analysis
 * PCCoE E&TC | B.Tech MDM IoT | 2026-27
 *
 * Every tunable in one place. Topic root, data URL and broker must match bridge/config.json
 * and site/config.js - tools/set_site.py rewrites all three together.
 */
#pragma once

// ---------------------------------------------------------------- identity
#define FW_VERSION        "arca-1.1.0"
#define DEVICE_ID         "MOTOR-01"
#define SCHEMA_NAME       "pdm.telemetry.v1.1"
// Random per-installation id. Keeps this demo's topics apart from everyone else on the
// public broker (and stops strangers' traffic reaching this node).
#define SITE_ID           "add1f2"

// ---------------------------------------------------------------- network
// A real board reads its Wi-Fi from config.local.h (git-ignored, never pushed):
//   #define WIFI_SSID "my-hotspot"   #define WIFI_PASS "secret"   #define WIFI_CHANNEL 0
// Without that file the defaults below join the Wokwi simulator's open network.
#if __has_include("config.local.h")
  #include "config.local.h"
#endif
#ifndef WIFI_SSID
  #define WIFI_SSID       "Wokwi-GUEST"
  #define WIFI_PASS       ""
#endif
#ifndef WIFI_CHANNEL
  #define WIFI_CHANNEL    6        // Wokwi-GUEST is on channel 6; 0 = scan (any real network)
#endif

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
