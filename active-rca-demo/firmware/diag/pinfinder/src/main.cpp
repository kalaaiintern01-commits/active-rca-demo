/*
 * Pin finder - shows which ESP32 pin each button and LED is really wired to.
 *
 *  1. OLED   : scans I2C on SDA=D21 / SCL=D22 and draws a test screen at 0x3C.
 *  2. BUTTONS: 15 s window - every free pin is an input with pull-up; pressing a button
 *              pulls its pin LOW and the pin is printed.
 *  3. LEDS   : each free pin is driven HIGH for 1.2 s in turn and printed; note which LED lights.
 *  Repeats forever. Expected wiring: FAULT D32, SOURCE D33, green D25, blue D26, red D27.
 */
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// every GPIO usable for a button or LED on a 30-pin DevKit (not 1/3 = USB serial, 6-11 = flash,
// 21/22 = OLED, 34-39 = input-only without pull-ups)
static const uint8_t PINS[] = {2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 23, 25, 26, 27, 32, 33};
static const uint8_t NPINS = sizeof(PINS);

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
bool oledOk = false;

static String label(uint8_t p) {
  if (p == 16) return "RX2 (GPIO16)";
  if (p == 17) return "TX2 (GPIO17)";
  return "D" + String(p);
}

static const char *expected(uint8_t p) {
  switch (p) {
    case 32: return "  <- FAULT button should be here";
    case 33: return "  <- SOURCE button should be here";
    case 25: return "  <- green PUB LED should be here";
    case 26: return "  <- blue TEST LED should be here";
    case 27: return "  <- red ALARM LED should be here";
    default: return "";
  }
}

static void screen(const String &a, const String &b, const String &c = "") {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(2);
  oled.setCursor(0, 0);
  oled.println(a);
  oled.setTextSize(1);
  oled.setCursor(0, 24);
  oled.println(b);
  oled.setCursor(0, 40);
  oled.println(c);
  oled.display();
}

static void oledCheck() {
  Serial.println("\n=== 1. OLED (I2C on SDA=D21, SCL=D22) ===");
  // idle I2C lines sit HIGH (pull-ups); a line stuck LOW means it touches GND - and would hang the bus
  pinMode(21, INPUT_PULLUP);
  pinMode(22, INPUT_PULLUP);
  delay(5);
  bool sdaLow = digitalRead(21) == LOW, sclLow = digitalRead(22) == LOW;
  Serial.printf("  idle levels: SDA(D21)=%s  SCL(D22)=%s\n", sdaLow ? "LOW (stuck!)" : "high ok", sclLow ? "LOW (stuck!)" : "high ok");
  if (sdaLow || sclLow) {
    Serial.println("  -> an OLED data wire touches GND or the wrong row. Fix it; skipping the OLED, going to the LED test.");
    oledOk = false;
    return;
  }
  Wire.end();
  Wire.begin(21, 22);
  Wire.setTimeOut(30);
  Wire.beginTransmission(0x3C);
  uint8_t err = Wire.endTransmission();
  Serial.printf("  OLED at 0x3C: %s\n", err == 0 ? "answers" : "NO answer - check SDA->D21, SCK->D22, VDD->3V3, GND->GND");
  if (err != 0) { oledOk = false; return; }
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  Serial.printf("  OLED init at 0x3C: %s\n", oledOk ? "ok - the screen should now read PIN FINDER" : "FAILED");
  if (oledOk) {
    screen("PIN FINDER", "If you can read this,", "the OLED works.");
    Serial.println("  If the screen stays BLACK although init is ok: VDD is not reaching 3V3 (re-seat it).");
  }
}

static void buttonCheck(uint32_t ms) {
  Serial.printf("\n=== 2. BUTTONS - press each button now (%lu s) ===\n", ms / 1000);
  screen("BUTTONS", "Press FAULT, then", "SOURCE (15 s)");
  for (uint8_t i = 0; i < NPINS; i++) pinMode(PINS[i], INPUT_PULLUP);
  delay(50);
  bool lowAtStart[NPINS];
  for (uint8_t i = 0; i < NPINS; i++) {
    lowAtStart[i] = digitalRead(PINS[i]) == LOW;
    if (lowAtStart[i]) Serial.printf("  %s reads LOW with nothing pressed - wired straight to GND?\n", label(PINS[i]).c_str());
  }
  uint8_t last[NPINS];
  for (uint8_t i = 0; i < NPINS; i++) last[i] = digitalRead(PINS[i]);
  uint32_t t0 = millis();
  int hits = 0;
  while (millis() - t0 < ms) {
    for (uint8_t i = 0; i < NPINS; i++) {
      uint8_t v = digitalRead(PINS[i]);
      if (v != last[i]) {
        delay(15);                                   // debounce
        v = digitalRead(PINS[i]);
        if (v != last[i]) {
          last[i] = v;
          if (v == LOW) {
            hits++;
            Serial.printf("  BUTTON pressed -> %s%s\n", label(PINS[i]).c_str(), expected(PINS[i]));
            screen("BUTTON", "pressed on", label(PINS[i]));
          }
        }
      }
    }
    delay(5);
  }
  if (!hits) Serial.println("  no button press seen - buttons not connected to any usable pin (or not to GND)");
}

static void ledSweep() {
  Serial.println("\n=== LEDS - each pin turns ON for 3 s; note which LED lights ===");
  for (uint8_t i = 0; i < NPINS; i++) pinMode(PINS[i], INPUT);
  for (uint8_t i = 0; i < NPINS; i++) {
    uint8_t p = PINS[i];
    pinMode(p, OUTPUT);
    digitalWrite(p, HIGH);
    Serial.printf("  now ON: %-13s%s\n", label(p).c_str(), expected(p));
    if (oledOk) {                                    // pin name large enough to read while watching the LEDs
      oled.clearDisplay();
      oled.setTextColor(SSD1306_WHITE);
      oled.setTextSize(1);
      oled.setCursor(0, 0);
      oled.printf("LED TEST  %u/%u  now ON:", i + 1, NPINS);
      oled.setTextSize(p == 16 || p == 17 ? 3 : 4);
      oled.setCursor(0, 22);
      oled.print(p == 16 ? "RX2" : p == 17 ? "TX2" : ("D" + String(p)).c_str());
      oled.display();
    }
    delay(3000);
    digitalWrite(p, LOW);
    pinMode(p, INPUT);
    delay(150);
  }
  Serial.println("  sweep done. If no LED ever lit: LEDs/resistors do not reach GND, or LEDs are reversed.");
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n\n##### PIN FINDER - wiring diagnostic #####");
  Serial.println("Expected: FAULT D32, SOURCE D33, green D25, blue D26, red D27, OLED SDA D21 / SCL D22");
}

// every free pin HIGH and the OLED solid white for a minute - any LED on any pin lights.
// D18/D19 (the buttons) stay inputs so pressing a button cannot short a driven pin.
static void allOn(uint32_t ms) {
  Serial.printf("\n=== ALL ON for %lu s: every free pin HIGH, OLED solid white ===\n", ms / 1000);
  for (uint8_t i = 0; i < NPINS; i++) {
    uint8_t p = PINS[i];
    if (p == 18 || p == 19) continue;
    pinMode(p, OUTPUT);
    digitalWrite(p, HIGH);
  }
  if (oledOk) { oled.clearDisplay(); oled.fillRect(0, 0, 128, 64, SSD1306_WHITE); oled.display(); }
  else Serial.println("  OLED not reachable - it stays dark (see the idle-levels line above)");
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    delay(10000);
    Serial.printf("  ... all on, %lu s left\n", (ms - (millis() - t0)) / 1000);
  }
  for (uint8_t i = 0; i < NPINS; i++) { digitalWrite(PINS[i], LOW); pinMode(PINS[i], INPUT); }
  if (oledOk) { oled.clearDisplay(); oled.display(); }
  Serial.println("  all off for 5 s");
}

// automatic scan, no user input: with the internal pull-up a free pin reads HIGH, a pin with an
// LED + resistor to GND reads LOW (the LED clamps it near its forward voltage); with the pull-down
// a pin tied to 3V3 reads HIGH
static void autoScan() {
  Serial.println("\n=== AUTO SCAN (pull-up / pull-down) ===");
  for (uint8_t i = 0; i < NPINS; i++) {
    uint8_t p = PINS[i];
    pinMode(p, INPUT_PULLUP);
    delay(3);
    int up = digitalRead(p);
    pinMode(p, INPUT_PULLDOWN);
    delay(3);
    int down = digitalRead(p);
    pinMode(p, INPUT);
    const char *what = (up == HIGH && down == LOW) ? "free (nothing, or a button not pressed)"
                     : (up == LOW && down == LOW)  ? "pulled to GND -> LED (or a held button)"
                     : (up == HIGH && down == HIGH) ? "tied to 3V3"
                                                    : "?";
    Serial.printf("  SCAN %-13s up=%d down=%d  %s\n", label(p).c_str(), up, down, what);
  }
}

void loop() {
  oledCheck();                                      // re-checked every round, so wiring fixes show up live
  buttonCheck(20000);
  ledSweep();
  Serial.println("\n----- repeating in 3 s -----");
  delay(3000);
}
