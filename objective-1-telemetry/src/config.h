/*
 * config.h — Objective 1 (sensing & telemetry layer)
 * IoT & ML-Based Predictive Maintenance System for Rotating Machinery
 * PCCoE E&TC | B.Tech MDM IoT | 2026-27
 *
 * All tunables live here so firmware behaviour is documented in one place.
 */
#pragma once

// ---------------------------------------------------------------- identity
#define FW_VERSION        "obj1-1.0.0"
#define DEVICE_ID         "MOTOR-01"
#define SCHEMA_NAME       "pdm.telemetry.v1"

// ---------------------------------------------------------------- network
// Wokwi's virtual access point: SSID "Wokwi-GUEST", no password, channel 6.
#define WIFI_SSID         "Wokwi-GUEST"
#define WIFI_PASS         ""
#define WIFI_CHANNEL      6

// Set to 1 to publish over MQTT+TLS (port 8883). Keep 0 for the fast,
// classroom-demo path (port 1883). The TLS path is the one that ships.
#define USE_TLS           0

#if USE_TLS
  #define MQTT_HOST       "test.mosquitto.org"
  #define MQTT_PORT       8883
#else
  #define MQTT_HOST       "broker.hivemq.com"
  #define MQTT_PORT       1883
#endif

#define MQTT_USER         ""            // broker auth (empty = anonymous)
#define MQTT_PASS         ""
#define MQTT_CLIENT_ID    "pdm-" DEVICE_ID

// Topic tree: pdm/v1/<device>/<leaf>
#define TOPIC_TELEMETRY   "pdm/v1/" DEVICE_ID "/telemetry"
#define TOPIC_STATUS      "pdm/v1/" DEVICE_ID "/status"   // retained + LWT
#define TOPIC_CMD         "pdm/v1/" DEVICE_ID "/cmd"      // inbound control

#define MQTT_QOS          0             // telemetry is periodic; loss tolerable
#define MQTT_KEEPALIVE_S  30
#define MQTT_BUFFER_BYTES 1024          // must exceed max telemetry payload

// Reconnect backoff (exponential, capped)
#define RECONNECT_MIN_MS  1000UL
#define RECONNECT_MAX_MS  30000UL

// ---------------------------------------------------------------- timing
#define SAMPLE_HZ         200           // vibration + current sample rate
#define PUBLISH_MS        2000UL        // telemetry publish interval
#define TEMP_PERIOD_MS    1000UL        // DS18B20 conversion cadence
#define DS18B20_CONV_MS   750UL         // 12-bit conversion time

// ---------------------------------------------------------------- pin map
#define PIN_ONEWIRE       4             // DS18B20 DQ (4.7k pull-up to 3V3)
#define PIN_I2C_SDA       21            // MPU6050
#define PIN_I2C_SCL       22
#define PIN_CURRENT_ADC   34            // ACS712 VIOUT  (input-only ADC1 pin)
#define PIN_SPEED_SET     35            // motor-driver speed command (ADC1)
#define PIN_RPM_IN        27            // RPM sensor pulse input (interrupt)
#define PIN_RPM_SIM_OUT   26            // sim-only: pulse generator -> PIN_RPM_IN
#define PIN_STATUS_LED    2             // on-board/aux status LED

// ---------------------------------------------------- current calibration
// ACS712 20 A module: bidirectional, VCC/2 quiescent output, 100 mV/A.
// The zero point is re-measured at every boot (motor must be off) instead of
// trusting the datasheet number, because the divider and ADC both drift.
#define ACS712_MV_PER_AMP     100.0f
#define ACS712_ZERO_MV_NOM    2500.0f   // datasheet quiescent, reporting only
#define ACS712_ZERO_SAMPLES   256
#define ACS712_DEADBAND_A     0.05f     // suppress ADC noise around 0 A
// Plausibility window for the measured zero. This is a sanity check on the
// front end, not a comparison against the datasheet: a zero outside this band
// means the motor was running at boot or the divider is wrong.
#define ACS712_ZERO_MV_MIN    500.0f
#define ACS712_ZERO_MV_MAX    3000.0f

// ADC front end: 0-3.3 V range, 12-bit. The ACS712 output is scaled by an
// external 2:1 divider (5 V sensor -> 3.3 V ADC), so mV are doubled back.
#define ADC_ATTEN             ADC_11db
#define ADC_BITS              12
// Wokwi: the pot models the ALREADY-DIVIDED sensor output, so the gain is 1.0
// and the full sweep covers roughly -16 A .. +16 A. On the real testbed the
// ACS712 runs at 5 V behind a 2:1 divider - set this to 2.0 there.
#define CURRENT_DIVIDER_GAIN  1.0f

// ------------------------------------------------- vibration conditioning
#define MPU_ACCEL_RANGE       MPU6050_RANGE_8_G
#define MPU_FILTER_BW         MPU6050_BAND_94_HZ  // anti-alias below Fs/2
#define VIB_DC_ALPHA          0.02f    // EMA coeff for gravity/DC removal
#define VIB_SETTLE_SAMPLES    50       // discard while the DC tracker settles

// ------------------------------------------------------ rpm conditioning
#define RPM_PULSES_PER_REV    2        // slots/magnets per revolution
#define RPM_MAX               6000     // testbed ceiling, used for debounce
#define RPM_DEBOUNCE_US       ((60000000UL / ((uint32_t)RPM_MAX * RPM_PULSES_PER_REV)) / 4)

// Simulated tacho: the speed-set pot drives a hardware square wave into
// PIN_RPM_IN, so the interrupt/period maths below is the real thing.
#define SIMULATE_TACHO        1
#define RPM_SIM_MIN           0
#define RPM_SIM_MAX           4000

// ---------------------------------------------------------------- misc
#define NTP_SERVER_1          "pool.ntp.org"
#define NTP_SERVER_2          "time.nist.gov"
#define SERIAL_BAUD           115200
#define DEFAULT_LABEL         "baseline"   // fault-injection label (see /cmd)

// Printing the whole 540-byte JSON document costs ~47 ms at 115200 baud, and
// the sampler is stalled for every one of them - 9 lost samples per window.
// The full document already goes out on MQTT, so the console gets a one-line
// heartbeat instead. Set to 1 when you need to read the raw payload on serial.
#define SERIAL_VERBOSE        0
