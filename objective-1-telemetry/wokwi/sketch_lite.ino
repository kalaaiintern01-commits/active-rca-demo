/*
 * ============================================================================
 *  IoT & ML-Based Predictive Maintenance System for Rotating Machinery
 *  OBJECTIVE 1 - Sensing & telemetry layer   (synopsis objectives 1, 2, 3)
 *  *** LITE BUILD for the free Wokwi plan - fast compile, 2 libraries ***
 *
 *  Pimpri Chinchwad College of Engineering, Nigdi, Pune
 *  Dept. of Electronics & Telecommunication | B.Tech MDM IoT | 2026-27
 *  Atharva Palande (123B1C060) - Mehul Rawat (123B1C063)
 *  Guide: Prof. Kalpana Patil
 * ============================================================================
 *
 *  Same four channels, same conditioning, same pdm.telemetry.v1 payload as the
 *  full build. Only the dependencies changed, to cut Wokwi compile time:
 *
 *    Adafruit MPU6050 + Unified Sensor + BusIO  ->  direct I2C register access
 *    DallasTemperature                          ->  OneWire commands directly
 *    ArduinoJson                                ->  bounds-checked snprintf
 *    WiFiClientSecure                           ->  included only if USE_TLS
 *
 *  LIBRARIES TO INSTALL IN THE WOKWI LIBRARY MANAGER - just these two:
 *    OneWire          (1-Wire timing is too tight to hand-roll)
 *    PubSubClient     (MQTT client)
 *
 *  Deliberate difference from the full build: the accelerometer stays in its
 *  power-on +/-2 g range instead of +/-8 g. 2 g is ample for a hobby DC motor
 *  and it is the range every MPU6050 model agrees on. Raise ACCEL_FS_SEL on
 *  the physical testbed if clipping shows up.
 * ============================================================================
 */

#include <WiFi.h>
#include <Wire.h>
#include <OneWire.h>
#include <PubSubClient.h>
#include <sys/time.h>
#include <time.h>
#include <math.h>
#include <stdarg.h>

// ============================================================================
//  Configuration - the lite build keeps it inline so there is one file to paste
// ============================================================================
#define FW_VERSION        "obj1-lite-1.0.0"
#define DEVICE_ID         "MOTOR-01"        // make this unique on a public broker
#define SCHEMA_NAME       "pdm.telemetry.v1"

#define WIFI_SSID         "Wokwi-GUEST"
#define WIFI_PASS         ""
#define WIFI_CHANNEL      6

#define USE_TLS           0                 // 1 => port 8883
#if USE_TLS
  #include <WiFiClientSecure.h>
  #define MQTT_HOST       "test.mosquitto.org"
  #define MQTT_PORT       8883
#else
  #define MQTT_HOST       "broker.hivemq.com"
  #define MQTT_PORT       1883
#endif

#define MQTT_USER         ""
#define MQTT_PASS         ""
#define MQTT_CLIENT_ID    "pdm-" DEVICE_ID
#define TOPIC_TELEMETRY   "pdm/v1/" DEVICE_ID "/telemetry"
#define TOPIC_STATUS      "pdm/v1/" DEVICE_ID "/status"
#define TOPIC_CMD         "pdm/v1/" DEVICE_ID "/cmd"
#define MQTT_QOS          0
#define MQTT_KEEPALIVE_S  30
#define MQTT_BUFFER_BYTES 1024

#define RECONNECT_MIN_MS  1000UL
#define RECONNECT_MAX_MS  30000UL

#define SAMPLE_HZ         200               // vibration + current
#define PUBLISH_MS        2000UL            // telemetry interval
#define TEMP_PERIOD_MS    1000UL
#define DS18B20_CONV_MS   750UL

#define PIN_ONEWIRE       4
#define PIN_I2C_SDA       21
#define PIN_I2C_SCL       22
#define PIN_CURRENT_ADC   34
#define PIN_SPEED_SET     35
#define PIN_RPM_IN        27
#define PIN_RPM_SIM_OUT   26
#define PIN_STATUS_LED    2

#define ACS712_MV_PER_AMP     100.0f
#define ACS712_ZERO_SAMPLES   256
#define ACS712_DEADBAND_A     0.05f
#define ACS712_ZERO_MV_MIN    500.0f
#define ACS712_ZERO_MV_MAX    3000.0f
#define ADC_BITS              12
#define CURRENT_DIVIDER_GAIN  1.0f          // 2.0 on hardware (5 V + 2:1 divider)

#define VIB_DC_ALPHA          0.02f
#define VIB_SETTLE_SAMPLES    50

#define RPM_PULSES_PER_REV    2
#define RPM_MAX               6000
#define RPM_DEBOUNCE_US       ((60000000UL / ((uint32_t)RPM_MAX * RPM_PULSES_PER_REV)) / 4)
#define SIMULATE_TACHO        1
#define RPM_SIM_MAX           4000

#define NTP_SERVER_1          "pool.ntp.org"
#define NTP_SERVER_2          "time.nist.gov"
#define SERIAL_BAUD           115200
#define DEFAULT_LABEL         "baseline"
// The full 540-byte JSON costs ~47 ms at 115200 baud and stalls the sampler
// for all of it (9 lost samples/window). Console gets a heartbeat instead.
#define SERIAL_VERBOSE        0

// ============================================================================
//  Bounds-checked text builder - replaces the JSON library
//  Every append is length-checked, so a payload can never be silently
//  truncated into half a document.
// ============================================================================
struct TextBuf {
  char  *buf;
  size_t cap;
  size_t len;
  bool   overflow;

  void begin(char *b, size_t c) { buf = b; cap = c; len = 0; overflow = false;
                                  if (cap) buf[0] = 0; }
  bool addf(const char *fmt, ...) {
    if (overflow || len >= cap) { overflow = true; return false; }
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf + len, cap - len, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= cap - len) { overflow = true; return false; }
    len += (size_t)n;
    return true;
  }
};
static const char *jbool(bool v) { return v ? "true" : "false"; }

// ============================================================================
//  MPU6050 - direct register access
// ============================================================================
#define MPU_ADDR          0x68
#define MPU_WHO_AM_I      0x75
#define MPU_PWR_MGMT_1    0x6B
#define MPU_CONFIG        0x1A
#define MPU_ACCEL_CONFIG  0x1C
#define MPU_ACCEL_XOUT_H  0x3B

#define MPU_DLPF_CFG      2       // 94 Hz accel bandwidth, below Fs/2 = 100 Hz
#define ACCEL_FS_SEL      0       // 0 = +/-2 g
#define ACCEL_LSB_PER_G   16384.0f
#define G_TO_MS2          9.80665f

bool mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool mpuRead(uint8_t reg, uint8_t *dst, uint8_t count) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;      // repeated start
  if (Wire.requestFrom((uint8_t)MPU_ADDR, count) != count) return false;
  for (uint8_t i = 0; i < count; i++) dst[i] = Wire.read();
  return true;
}

bool mpuBegin() {
  uint8_t who = 0;
  if (!mpuRead(MPU_WHO_AM_I, &who, 1)) return false;
  if (who != 0x68 && who != 0x70 && who != 0x71) {         // 6050 / 6500 / 9250
    Serial.printf("[mpu6050] unexpected WHO_AM_I 0x%02X\r\n", who);
    return false;
  }
  if (!mpuWrite(MPU_PWR_MGMT_1, 0x80)) return false;        // device reset
  delay(100);
  if (!mpuWrite(MPU_PWR_MGMT_1, 0x00)) return false;        // wake, internal osc
  delay(10);
  if (!mpuWrite(MPU_CONFIG, MPU_DLPF_CFG)) return false;    // anti-alias filter
  if (!mpuWrite(MPU_ACCEL_CONFIG, ACCEL_FS_SEL << 3)) return false;
  return true;
}

// Raw counts -> m/s^2, big-endian signed 16-bit per axis.
bool mpuReadAccel(float *ax, float *ay, float *az) {
  uint8_t r[6];
  if (!mpuRead(MPU_ACCEL_XOUT_H, r, 6)) return false;
  int16_t x = (int16_t)((r[0] << 8) | r[1]);
  int16_t y = (int16_t)((r[2] << 8) | r[3]);
  int16_t z = (int16_t)((r[4] << 8) | r[5]);
  const float k = G_TO_MS2 / ACCEL_LSB_PER_G;
  *ax = x * k; *ay = y * k; *az = z * k;
  return true;
}

// ============================================================================
//  DS18B20 - OneWire commands directly, with CRC validation
// ============================================================================
#define OW_SKIP_ROM       0xCC
#define OW_CONVERT_T      0x44
#define OW_READ_SCRATCH   0xBE
#define OW_WRITE_SCRATCH  0x4E

OneWire oneWire(PIN_ONEWIRE);

bool dsPresent() {
  return oneWire.reset() != 0;              // any device pulling the bus low
}

void dsSetResolution12bit() {
  if (!oneWire.reset()) return;
  oneWire.write(OW_SKIP_ROM);
  oneWire.write(OW_WRITE_SCRATCH);
  oneWire.write(0x00);                      // TH - unused, alarms disabled
  oneWire.write(0x00);                      // TL
  oneWire.write(0x7F);                      // config: R1R0 = 11 => 12-bit
}

void dsStartConversion() {
  if (!oneWire.reset()) return;
  oneWire.write(OW_SKIP_ROM);
  oneWire.write(OW_CONVERT_T);              // parasite-safe: we poll on time
}

// Returns NAN on a bus fault or a bad CRC, so a corrupt reading can never be
// published as a plausible temperature.
float dsReadTempC() {
  if (!oneWire.reset()) return NAN;
  oneWire.write(OW_SKIP_ROM);
  oneWire.write(OW_READ_SCRATCH);

  uint8_t sp[9];
  for (uint8_t i = 0; i < 9; i++) sp[i] = oneWire.read();
  if (OneWire::crc8(sp, 8) != sp[8]) return NAN;

  int16_t raw = (int16_t)((sp[1] << 8) | sp[0]);
  return raw / 16.0f;                       // 12-bit => 0.0625 C per count
}

// ============================================================================
//  Windowed statistics
// ============================================================================
struct Accum {
  uint32_t n;
  double   sum, sumsq;
  float    peak;
  void reset() { n = 0; sum = 0; sumsq = 0; peak = 0; }
  void add(float v) {
    n++; sum += v; sumsq += (double)v * (double)v;
    float a = fabsf(v);
    if (a > peak) peak = a;
  }
  float rms()  const { return n ? sqrtf((float)(sumsq / n)) : 0.0f; }
  float mean() const { return n ? (float)(sum / n)          : 0.0f; }
};

// ============================================================================
//  Globals
// ============================================================================
#if USE_TLS
  WiFiClientSecure netClient;
#else
  WiFiClient       netClient;
#endif
PubSubClient       mqtt(netClient);

bool     g_mpuOk = false, g_tempOk = false, g_tempValid = false;
float    g_tempC = NAN;
float    g_dcX = 0, g_dcY = 0, g_dcZ = 0;
uint32_t g_dcSettle = 0;
float    g_zeroMv = 0;
bool     g_calOk = true;

Accum    accVibMag, accVibX, accVibY, accVibZ, accCurrent;
uint32_t g_windowStartMs = 0;

volatile uint32_t g_pulses = 0, g_lastEdgeUs = 0, g_lastPeriodUs = 0;

uint32_t g_publishMs = PUBLISH_MS, g_nextSampleUs = 0;
uint32_t g_lastTempReqMs = 0, g_lastPublishMs = 0;
bool     g_tempPending = false;

uint32_t g_seq = 0, g_wifiReconnects = 0, g_mqttReconnects = 0;
uint32_t g_publishFails = 0, g_droppedSamples = 0;
char     g_label[24] = DEFAULT_LABEL;

enum NetState { NET_WIFI_DOWN, NET_WIFI_WAIT, NET_MQTT_DOWN, NET_ONLINE };
NetState g_net = NET_WIFI_DOWN;
uint32_t g_retryAtMs = 0, g_backoffMs = RECONNECT_MIN_MS;

// ============================================================================
//  Tacho - ISR with debounce, plus the simulator-only pulse source
// ============================================================================
void IRAM_ATTR onTachoEdge() {
  uint32_t now = micros();
  uint32_t dt  = now - g_lastEdgeUs;
  if (dt < RPM_DEBOUNCE_US) return;
  g_lastEdgeUs   = now;
  g_lastPeriodUs = dt;
  g_pulses++;
}

#if SIMULATE_TACHO
static const uint8_t LEDC_CH = 0;

void tachoSimBegin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_RPM_SIM_OUT, 100, 8);
#else
  ledcSetup(LEDC_CH, 100, 8);
  ledcAttachPin(PIN_RPM_SIM_OUT, LEDC_CH);
#endif
}

void tachoSimTick() {
  static uint32_t lastMs = 0, lastRpm = 0xFFFFFFFF;
  if (millis() - lastMs < 100) return;
  lastMs = millis();

  uint32_t mv  = analogReadMilliVolts(PIN_SPEED_SET);
  uint32_t rpm = (uint32_t)(RPM_SIM_MAX * (mv / 3300.0f));
  if (rpm > (uint32_t)RPM_SIM_MAX) rpm = RPM_SIM_MAX;
  if (rpm / 10 == lastRpm / 10) return;                 // hysteresis
  lastRpm = rpm;

  uint32_t hz = (rpm * RPM_PULSES_PER_REV) / 60;        // pulses per second
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  if (hz == 0) ledcWrite(PIN_RPM_SIM_OUT, 0);
  else         ledcWriteTone(PIN_RPM_SIM_OUT, hz);
#else
  if (hz == 0) ledcWrite(LEDC_CH, 0);
  else         ledcWriteTone(LEDC_CH, hz);
#endif
}
#else
void tachoSimBegin() {}
void tachoSimTick()  {}
#endif

// ============================================================================
//  Current channel - boot auto-zero, then true RMS over the window
// ============================================================================
float readCurrentMv() {
  return analogReadMilliVolts(PIN_CURRENT_ADC) * CURRENT_DIVIDER_GAIN;
}

void calibrateCurrentZero() {
  double acc = 0;
  for (uint16_t i = 0; i < ACS712_ZERO_SAMPLES; i++) {
    acc += readCurrentMv();
    delayMicroseconds(200);
  }
  g_zeroMv = (float)(acc / ACS712_ZERO_SAMPLES);
  g_calOk  = (g_zeroMv > ACS712_ZERO_MV_MIN) && (g_zeroMv < ACS712_ZERO_MV_MAX);
  Serial.printf("[cal] current zero = %.1f mV (plausible %.0f..%.0f) %s\r\n",
                g_zeroMv, (double)ACS712_ZERO_MV_MIN, (double)ACS712_ZERO_MV_MAX,
                g_calOk ? "OK" : "OUT OF RANGE - motor running during boot?");
}

float readCurrentAmps() {
  float a = (readCurrentMv() - g_zeroMv) / ACS712_MV_PER_AMP;
  if (fabsf(a) < ACS712_DEADBAND_A) a = 0.0f;
  return a;
}

// ============================================================================
//  Fixed-rate sampling
// ============================================================================
void sampleOnce() {
  if (g_mpuOk) {
    float x, y, z;
    if (mpuReadAccel(&x, &y, &z)) {
      // Slow EMA per axis tracks gravity + sensor offset; only the AC residual
      // is vibration. 9.8 m/s^2 of DC would otherwise swamp the RMS.
      // Seed on the first reading rather than ramping from zero, or gravity
      // reads as vibration until the EMA catches up and the first published
      // window carries a pure artefact.
      if (g_dcSettle == 0) { g_dcX = x; g_dcY = y; g_dcZ = z; }

      g_dcX += VIB_DC_ALPHA * (x - g_dcX);
      g_dcY += VIB_DC_ALPHA * (y - g_dcY);
      g_dcZ += VIB_DC_ALPHA * (z - g_dcZ);

      if (g_dcSettle < VIB_SETTLE_SAMPLES) {
        g_dcSettle++;
      } else {
        float rx = x - g_dcX, ry = y - g_dcY, rz = z - g_dcZ;
        accVibX.add(rx); accVibY.add(ry); accVibZ.add(rz);
        accVibMag.add(sqrtf(rx * rx + ry * ry + rz * rz));
      }
    } else {
      g_droppedSamples++;
    }
  }
  accCurrent.add(readCurrentAmps());
}

void sampleTick() {
  const uint32_t periodUs = 1000000UL / SAMPLE_HZ;
  uint32_t now = micros();
  if ((int32_t)(now - g_nextSampleUs) < 0) return;

  g_nextSampleUs += periodUs;
  if ((int32_t)(now - g_nextSampleUs) > (int32_t)(periodUs * 4)) {
    // Fell behind (blocking Wi-Fi join, TLS handshake): resync rather than
    // burst-sampling, and report the sample slots actually missed so the cloud
    // can judge the window on real coverage.
    g_droppedSamples += (now - g_nextSampleUs) / periodUs;
    g_nextSampleUs = now + periodUs;
  }
  sampleOnce();
}

// ============================================================================
//  Temperature - asynchronous, so a 750 ms conversion never stalls the loop
// ============================================================================
void tempTick() {
  uint32_t now = millis();

  if (!g_tempPending && now - g_lastTempReqMs >= TEMP_PERIOD_MS) {
    dsStartConversion();
    g_lastTempReqMs = now;
    g_tempPending   = true;
    return;
  }

  if (g_tempPending && now - g_lastTempReqMs >= DS18B20_CONV_MS) {
    g_tempPending = false;
    float c = g_tempOk ? dsReadTempC() : NAN;
    // A bad reading is reported as invalid, never forwarded as 0 or -127 for
    // the model to learn as a temperature.
    if (!isnan(c) && c > -55.0f && c < 125.0f) {
      g_tempC = c; g_tempValid = true;
    } else {
      g_tempValid = false;
    }
  }
}

// ============================================================================
//  Time - NTP-backed UTC with an explicit "not synced" flag
// ============================================================================
bool isoTimestamp(char *buf, size_t len, uint64_t *epochMs) {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  if (epochMs) *epochMs = (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000ULL;

  if (tv.tv_sec < 1700000000) {
    snprintf(buf, len, "1970-01-01T00:00:00.000Z");
    return false;
  }
  struct tm t;
  time_t secs = (time_t)tv.tv_sec;
  gmtime_r(&secs, &t);
  size_t n = strftime(buf, len, "%Y-%m-%dT%H:%M:%S", &t);
  snprintf(buf + n, len - n, ".%03luZ", (unsigned long)(tv.tv_usec / 1000));
  return true;
}

// ============================================================================
//  Telemetry - schema "pdm.telemetry.v1", byte-for-byte the full build's
//  contract. Field names, units and nesting mirror docs/telemetry-schema.json.
// ============================================================================
void publishTelemetry() {
  // Close the window FIRST, reset, and only then serialise. Building and
  // publishing costs tens of milliseconds; resetting afterwards would discard
  // every sample taken in that time and divide the pulse count by a window
  // shorter than the one the pulses arrived in - about 3 % of samples lost and
  // 3 % of error in RPM.
  noInterrupts();
  uint32_t pulses   = g_pulses;
  uint32_t periodUs = g_lastPeriodUs;
  uint32_t lastEdge = g_lastEdgeUs;
  g_pulses = 0;
  interrupts();

  uint32_t nowMs    = millis();
  uint32_t windowMs = nowMs - g_windowStartMs;
  if (windowMs == 0) windowMs = 1;

  const float    vibRms  = accVibMag.rms();
  const float    vibPeak = accVibMag.peak;
  const float    vibXr   = accVibX.rms();
  const float    vibYr   = accVibY.rms();
  const float    vibZr   = accVibZ.rms();
  const uint32_t vibN    = accVibMag.n;
  const float    curRms  = accCurrent.rms();
  const float    curMean = accCurrent.mean();
  const float    curPeak = accCurrent.peak;
  const uint32_t curN    = accCurrent.n;
  const uint32_t dropped = g_droppedSamples;

  accVibMag.reset(); accVibX.reset(); accVibY.reset(); accVibZ.reset();
  accCurrent.reset();
  g_droppedSamples = 0;
  g_windowStartMs  = nowMs;

  float rpmAvg  = (pulses * 60000.0f) / ((float)windowMs * RPM_PULSES_PER_REV);
  float rpmInst = 0.0f;
  if (periodUs > 0 && (micros() - lastEdge) < 500000UL) {
    rpmInst = 60000000.0f / ((float)periodUs * RPM_PULSES_PER_REV);
  }

  char ts[40];
  uint64_t epochMs = 0;
  bool tsSynced = isoTimestamp(ts, sizeof(ts), &epochMs);

  float crest = vibRms > 0.001f ? vibPeak / vibRms : 0.0f;

  char payload[MQTT_BUFFER_BYTES];
  TextBuf j;
  j.begin(payload, sizeof(payload));

  j.addf("{\"schema\":\"%s\",\"device_id\":\"%s\",\"fw\":\"%s\",\"seq\":%lu,",
         SCHEMA_NAME, DEVICE_ID, FW_VERSION, (unsigned long)++g_seq);
  j.addf("\"ts\":\"%s\",\"ts_synced\":%s,\"t_edge_ms\":%llu,\"uptime_s\":%lu,",
         ts, jbool(tsSynced), (unsigned long long)epochMs,
         (unsigned long)(millis() / 1000));
  j.addf("\"label\":\"%s\",", g_label);
  j.addf("\"temp\":{\"c\":%.2f,\"valid\":%s},",
         g_tempValid ? g_tempC : 0.0f, jbool(g_tempValid));
  j.addf("\"vib\":{\"rms_ms2\":%.3f,\"peak_ms2\":%.3f,\"crest\":%.2f,"
         "\"x_rms\":%.3f,\"y_rms\":%.3f,\"z_rms\":%.3f,\"valid\":%s},",
         vibRms, vibPeak, crest, vibXr, vibYr, vibZr, jbool(g_mpuOk));
  j.addf("\"cur\":{\"rms_a\":%.3f,\"mean_a\":%.3f,\"peak_a\":%.3f,"
         "\"zero_mv\":%.1f,\"cal_ok\":%s},",
         curRms, curMean, curPeak, g_zeroMv, jbool(g_calOk));
  j.addf("\"rpm\":{\"avg\":%.1f,\"inst\":%.1f,\"pulses\":%lu},",
         rpmAvg, rpmInst, (unsigned long)pulses);
  j.addf("\"win\":{\"ms\":%lu,\"n\":%lu,\"n_cur\":%lu,\"sample_hz\":%d,"
         "\"dropped\":%lu},",
         (unsigned long)windowMs, (unsigned long)vibN,
         (unsigned long)curN, (int)SAMPLE_HZ, (unsigned long)dropped);
  j.addf("\"net\":{\"rssi\":%d,\"ip\":\"%s\",\"tls\":%s,\"wifi_reconn\":%lu,"
         "\"mqtt_reconn\":%lu,\"publish_fails\":%lu}}",
         (int)WiFi.RSSI(), WiFi.localIP().toString().c_str(), jbool(USE_TLS),
         (unsigned long)g_wifiReconnects, (unsigned long)g_mqttReconnects,
         (unsigned long)g_publishFails);

  bool ok = false;
  if (j.overflow) {
    Serial.printf("[pub FAIL] payload exceeds %u B buffer\r\n",
                  (unsigned)sizeof(payload));
  } else {
    if (mqtt.connected()) {
      ok = mqtt.publish(TOPIC_TELEMETRY, (const uint8_t *)payload, j.len, false);
    }
#if SERIAL_VERBOSE
    Serial.printf("%s %s\r\n", ok ? "[pub]" : "[pub FAIL]", payload);
#else
    Serial.printf("%s seq=%lu %-14s T=%.2f vib=%.3f crest=%.2f I=%.3f "
                  "rpm=%.0f n=%lu/%lu drop=%lu\r\n",
                  ok ? "[pub]" : "[pub FAIL]", (unsigned long)g_seq, g_label,
                  g_tempValid ? g_tempC : 0.0f, vibRms, crest, curRms, rpmAvg,
                  (unsigned long)vibN,
                  (unsigned long)((uint32_t)SAMPLE_HZ * windowMs / 1000),
                  (unsigned long)dropped);
#endif
  }
  if (!ok) g_publishFails++;
  // The window was closed and reset at the top, so a failed publish loses
  // exactly one window - it never merges two.
}

void publishTick() {
  if (millis() - g_lastPublishMs < g_publishMs) return;
  g_lastPublishMs = millis();
  publishTelemetry();
}

// ============================================================================
//  Inbound commands - settings only, never actuation
//    {"label":"imbalance"}  {"publish_ms":1000}  {"rezero":true}
//  Parsed by hand here; the cloud side does proper schema validation.
// ============================================================================
static bool findValue(const char *json, const char *key, char *out, size_t cap) {
  char pattern[32];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  const char *k = strstr(json, pattern);
  if (!k) return false;
  const char *colon = strchr(k, ':');
  if (!colon) return false;

  const char *p = colon + 1;
  while (*p == ' ' || *p == '"') p++;
  size_t i = 0;
  while (*p && *p != '"' && *p != ',' && *p != '}' && i < cap - 1) out[i++] = *p++;
  out[i] = 0;
  return i > 0;
}

void onMqttMessage(char *topic, uint8_t *payload, unsigned int len) {
  char json[256];
  size_t n = len < sizeof(json) - 1 ? len : sizeof(json) - 1;
  memcpy(json, payload, n);
  json[n] = 0;

  char val[32];
  if (findValue(json, "label", val, sizeof(val))) {
    strlcpy(g_label, val, sizeof(g_label));
    Serial.printf("[cmd] label = %s\r\n", g_label);
  }
  if (findValue(json, "publish_ms", val, sizeof(val))) {
    uint32_t v = strtoul(val, nullptr, 10);
    if (v >= 500 && v <= 60000) {
      g_publishMs = v;
      Serial.printf("[cmd] publish_ms = %lu\r\n", (unsigned long)g_publishMs);
    } else {
      Serial.println("[cmd] publish_ms out of range 500..60000");
    }
  }
  if (findValue(json, "rezero", val, sizeof(val)) && strncmp(val, "true", 4) == 0) {
    calibrateCurrentZero();
  }
}

// ============================================================================
//  Status LED: slow blink = joining Wi-Fi, fast = broker, solid = online
// ============================================================================
void ledTick() {
  uint32_t period = (g_net == NET_ONLINE)    ? 0
                  : (g_net == NET_MQTT_DOWN) ? 150
                                             : 700;
  if (period == 0) { digitalWrite(PIN_STATUS_LED, HIGH); return; }
  digitalWrite(PIN_STATUS_LED, (millis() / period) % 2);
}

// ============================================================================
//  Connectivity - non-blocking state machine, exponential backoff
// ============================================================================
void mqttSetup() {
#if USE_TLS
  netClient.setInsecure();      // cloud stage pins a CA + device certificate
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  mqtt.setBufferSize(MQTT_BUFFER_BYTES);
  mqtt.setCallback(onMqttMessage);
}

bool mqttConnectOnce() {
  Serial.printf("[mqtt] connecting to %s:%d%s ... ",
                MQTT_HOST, (int)MQTT_PORT, USE_TLS ? " (TLS)" : "");
  // Last will: the broker publishes "offline" on the retained status topic if
  // this node drops, so a stale device shows as stale.
  bool ok = mqtt.connect(MQTT_CLIENT_ID,
                         strlen(MQTT_USER) ? MQTT_USER : nullptr,
                         strlen(MQTT_PASS) ? MQTT_PASS : nullptr,
                         TOPIC_STATUS, MQTT_QOS, true, "offline", true);
  if (!ok) {
    Serial.printf("failed, state=%d\r\n", mqtt.state());
    return false;
  }
  Serial.println("connected");
  mqtt.publish(TOPIC_STATUS, "online", true);
  mqtt.subscribe(TOPIC_CMD, MQTT_QOS);
  return true;
}

void netService() {
  uint32_t now = millis();

  switch (g_net) {
    case NET_WIFI_DOWN:
      Serial.printf("[wifi] joining %s\r\n", WIFI_SSID);
      WiFi.mode(WIFI_STA);
      WiFi.setSleep(false);
      WiFi.begin(WIFI_SSID, WIFI_PASS, WIFI_CHANNEL);
      g_retryAtMs = now + 15000;
      g_net       = NET_WIFI_WAIT;
      break;

    case NET_WIFI_WAIT:
      if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("[wifi] up, ip=%s rssi=%d\r\n",
                      WiFi.localIP().toString().c_str(), WiFi.RSSI());
        configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
        g_backoffMs = RECONNECT_MIN_MS;
        g_retryAtMs = 0;
        g_net       = NET_MQTT_DOWN;
      } else if ((int32_t)(now - g_retryAtMs) >= 0) {
        Serial.println("[wifi] join timed out, retrying");
        WiFi.disconnect(true);
        g_wifiReconnects++;
        g_net = NET_WIFI_DOWN;
      }
      break;

    case NET_MQTT_DOWN:
      if (WiFi.status() != WL_CONNECTED) {
        g_wifiReconnects++;
        g_net = NET_WIFI_DOWN;
        break;
      }
      if ((int32_t)(now - g_retryAtMs) < 0) break;
      if (mqttConnectOnce()) {
        g_backoffMs = RECONNECT_MIN_MS;
        g_net       = NET_ONLINE;
        // Realign the window on the connection: association and the broker
        // handshake block for over a second, so the window spanning them has
        // poor coverage. Start fresh, and the first window we publish is whole.
        accVibMag.reset(); accVibX.reset(); accVibY.reset(); accVibZ.reset();
        accCurrent.reset();
        g_droppedSamples = 0;
        g_windowStartMs  = millis();
        g_lastPublishMs  = millis();
      } else {
        g_mqttReconnects++;
        g_retryAtMs = now + g_backoffMs;
        g_backoffMs = min(g_backoffMs * 2, (uint32_t)RECONNECT_MAX_MS);
        Serial.printf("[mqtt] retry in %lu ms\r\n",
                      (unsigned long)(g_retryAtMs - now));
      }
      break;

    case NET_ONLINE:
      if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[wifi] lost");
        g_wifiReconnects++;
        g_net = NET_WIFI_DOWN;
      } else if (!mqtt.connected()) {
        Serial.println("[mqtt] lost");
        g_retryAtMs = now;
        g_net       = NET_MQTT_DOWN;
      } else {
        mqtt.loop();
      }
      break;
  }
}

// ============================================================================
void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(200);
  Serial.println();
  Serial.println("=============================================");
  Serial.println(" PdM Objective 1 - sensing & telemetry (lite)");
  Serial.printf(" device=%s fw=%s schema=%s\r\n",
                DEVICE_ID, FW_VERSION, SCHEMA_NAME);
  Serial.printf(" sample=%d Hz  publish=%lu ms  tls=%d\r\n",
                (int)SAMPLE_HZ, (unsigned long)PUBLISH_MS, (int)USE_TLS);
  Serial.println("=============================================");

  pinMode(PIN_STATUS_LED, OUTPUT);

  analogReadResolution(ADC_BITS);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(400000);
  g_mpuOk = mpuBegin();
  Serial.println(g_mpuOk ? "[mpu6050] found, +/-2g, 94 Hz DLPF"
                         : "[mpu6050] NOT FOUND - check I2C wiring");

  g_tempOk = dsPresent();
  if (g_tempOk) {
    dsSetResolution12bit();
    Serial.println("[ds18b20] found, 12-bit");
  } else {
    Serial.println("[ds18b20] NOT FOUND - check DQ pull-up");
  }

  calibrateCurrentZero();

  pinMode(PIN_RPM_IN, INPUT_PULLDOWN);
  attachInterrupt(digitalPinToInterrupt(PIN_RPM_IN), onTachoEdge, RISING);
  tachoSimBegin();

  mqttSetup();

  accVibMag.reset(); accVibX.reset(); accVibY.reset(); accVibZ.reset();
  accCurrent.reset();

  g_windowStartMs = millis();
  g_lastPublishMs = millis();
  g_nextSampleUs  = micros();
}

void loop() {
  netService();
  sampleTick();
  tempTick();
  tachoSimTick();
  publishTick();
  ledTick();
}
