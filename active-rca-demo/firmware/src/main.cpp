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

#include "config.h"
#include "certs.h"
#include "pdm_features.h"

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
  if (WiFi.status() != WL_CONNECTED) {
    // show what the radio can actually see - the usual causes are a 5 GHz-only network or a
    // name that differs from WIFI_SSID by one character
    WiFi.disconnect();
    int n = WiFi.scanNetworks();
    Serial.printf("[wifi] status=%d, %d networks visible (2.4 GHz only):\n", (int)WiFi.status(), n);
    for (int i = 0; i < n && i < 15; i++)
      Serial.printf("[wifi]   \"%s\"  ch %d  %d dBm  %s\n", WiFi.SSID(i).c_str(), WiFi.channel(i), WiFi.RSSI(i),
                    WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "secured");
    WiFi.scanDelete();
  }
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
