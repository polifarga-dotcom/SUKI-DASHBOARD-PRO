// SUKI Cabin Watch — Waveshare ESP32-Touch-LCD-3.5 (ESP32-D0WDR2, ST7796 SPI, FT6336, ES8311, AXP2101, TCA9554)
//
// Reiner Anzeiger + Lautsprecher: alle Alarmlogik bleibt in Node-RED (Flow "ESP32 Mini Dashboard").
// GET {DASH_URL}/cabin alle 2 s (~1 KB), POST /ack (Stummschalten), POST /anchor-up (Anker auf).
// Layout 1:1 aus sim/index.html (480 x 320 quer).
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <ESP_I2S.h>
#include <LovyanGFX.hpp>
#define XPOWERS_CHIP_AXP2101
#include <XPowersLib.h>
#include "es8311.h"
#include "fonts.h"
#include "secrets.h"
#include "SukiWifi.h"   // WLAN: 2 Netze, DHCP/feste IP, Abgleich mit Node-RED, Einrichtungs-WLAN
#if __has_include("fw_version.h")
#include "fw_version.h"  // von build.sh erzeugt: #define FW_VERSION "JJJJ-MM-TT-hhmmss"
#endif
#include "ota.h"        // Firmware-Update per WLAN (vom Pi), mit automatischem Rückfall

#ifndef DASH_URL_WIFI1
#define DASH_URL_WIFI1 ""
#endif
#define dashUrl() ((DASH_URL_WIFI1[0] && WiFi.SSID() == WIFI_SSID) ? String(DASH_URL_WIFI1) : String(DASH_URL))

// ── Pins (Waveshare-Demo 01_factory) ─────────────────────────────────────────
#define PIN_SDA 21
#define PIN_SCL 22
#define PIN_SD_CS 15
#define I2S_BCK 2
#define I2S_LRCK 4
#define I2S_DOUT 12
#define I2S_DIN 34
#define TCA_ADDR 0x20   // EXIO0 = LCD-Reset, EXIO1 = Touch-Reset, EXIO2 = Lautsprecher-Verstärker
#define FT_ADDR 0x38

// Touch-Abbildung Rohkoordinaten (Hochformat 320x480) → Querformat 480x320; bei Bedarf anpassen
#ifndef TOUCH_SWAP
#define TOUCH_SWAP 1
#endif
#ifndef TOUCH_INV_X
#define TOUCH_INV_X 0
#endif
#ifndef TOUCH_INV_Y
#define TOUCH_INV_Y 1
#endif
#ifndef LCD_ROTATION
#define LCD_ROTATION 1
#endif

class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ST7796 _panel;
  lgfx::Bus_SPI _bus;
  lgfx::Light_PWM _light;
 public:
  LGFX() {
    {
      auto c = _bus.config();
      c.spi_host = SPI3_HOST; c.spi_mode = 0; c.freq_write = 40000000; c.freq_read = 16000000;
      c.spi_3wire = false; c.use_lock = true; c.dma_channel = SPI_DMA_CH_AUTO;
      c.pin_sclk = 18; c.pin_mosi = 23; c.pin_miso = 19; c.pin_dc = 27;
      _bus.config(c); _panel.setBus(&_bus);
    }
    {
      auto c = _panel.config();
      c.pin_cs = 5; c.pin_rst = -1; c.pin_busy = -1;
      c.panel_width = 320; c.panel_height = 480; c.offset_rotation = 0;
      c.readable = false; c.invert = true; c.rgb_order = false; c.dlen_16bit = false; c.bus_shared = true;
      _panel.config(c);
    }
    {
      auto c = _light.config();
      c.pin_bl = 25; c.invert = false; c.freq = 5000; c.pwm_channel = 7;
      _light.config(c); _panel.setLight(&_light);
    }
    setPanel(&_panel);
  }
};

static LGFX lcd;
static LGFX_Sprite fb(&lcd);
static lgfx::VLWfont fClockF, fBigF, fMidF, fB24F, fB17F, fB13F, fR13F, fR11F;
static XPowersPMU pmu;
static I2SClass i2s;
static es8311_handle_t es = nullptr;
static Preferences prefs;

static const int W = 480, H = 320;

// ── Farben (wie Simulator) ───────────────────────────────────────────────────
struct Pal { uint32_t bg, tile, line, txt, dim, faint, acc, ok, warn, alarm, alarmBg, boat; };
static const Pal DAY = {0x06080B, 0x11151A, 0x232A32, 0xEEF1F4, 0x7F8894, 0x353D47, 0x4FC3F7, 0x00C853, 0xFFAB00, 0xFF1744, 0x4A0012, 0xFFFFFF};
// Nacht: volle Rottöne, die Helligkeit kommt von der Hintergrundbeleuchtung
static const Pal NIGHT = {0x000000, 0x0A0000, 0x3A0404, 0xFF2020, 0xA81414, 0x4A0606, 0xC41818, 0xC41818, 0xFF2020, 0xFF3030, 0x480000, 0xFF2020};
static const Pal* P = &DAY;

// ── Daten vom Node-RED ───────────────────────────────────────────────────────
struct Cabin {
  bool have;
  char time[6], utc[6], date[16], sr[6], ss[6], status[8];
  bool blink, acked;
  char keys[6][14]; uint8_t nKeys;
  char aSt[8]; bool aAct; float aDist, aRad, aDepth, aChain, aHdg;
  bool hasBoff; int16_t boff[2]; int16_t track[60][2]; uint8_t nTrack;
  char wSt[8]; float wKn, wMax, wThr; char wSrc[6]; int wWin; float hist[60]; uint8_t nHist;
  char bSt[8]; float soc; char rSt[8]; float hpa, baroD;
};
static Cabin cab, rx;
static SemaphoreHandle_t mtx;
static volatile uint32_t dataRev = 0, lastOkMs = 0;
static volatile bool wifiUp = false;
static volatile uint32_t epochBase = 0, epochMs = 0;
static volatile int tzOffMin = 0;
static volatile bool ackRequested = false, anchorUpRequested = false;
static volatile int aupResult = 0;   // 0 nichts, 1 ok, -1 Fehler
static uint32_t aupArmedMs = 0, aupMsgUntil = 0;

// ── Einstellungen (lokal im Gerät) ───────────────────────────────────────────
struct Settings { uint8_t night = 2, briDay = 80, briNight = 15, vol = 70, nightShort = 1; } cfg;   // night 0 aus, 1 an, 2 auto
static void saveCfg() {
  prefs.putUChar("night", cfg.night); prefs.putUChar("briD", cfg.briDay); prefs.putUChar("briN", cfg.briNight);
  prefs.putUChar("vol", cfg.vol); prefs.putUChar("nShort", cfg.nightShort);
}
static void loadCfg() {
  cfg.night = prefs.getUChar("night", 2); cfg.briDay = prefs.getUChar("briD", 80); cfg.briNight = prefs.getUChar("briN", 15);
  cfg.vol = prefs.getUChar("vol", 70); cfg.nightShort = prefs.getUChar("nShort", 1);
}

// ── Hilfen ───────────────────────────────────────────────────────────────────
static void cpy(char* d, size_t n, JsonVariantConst v) { const char* s = v.is<const char*>() ? v.as<const char*>() : ""; strlcpy(d, s, n); }
static float num(JsonVariantConst v) { return v.isNull() ? NAN : v.as<float>(); }
static bool isStale() { return !cab.have || millis() - lastOkMs > 15000; }

static void localHM(char* out, bool utc) {
  if (!epochBase) { strcpy(out, "--:--"); return; }
  uint32_t now = epochBase + (millis() - epochMs) / 1000;
  int32_t m = (int32_t)((now / 60) % 1440) + (utc ? 0 : tzOffMin);
  m = ((m % 1440) + 1440) % 1440;
  sprintf(out, "%02d:%02d", m / 60, m % 60);
}
static bool isNight() {
  if (cfg.night != 2) return cfg.night == 1;
  char t[6]; localHM(t, false);
  const char* sr = cab.sr[0] ? cab.sr : "07:00";
  const char* ss = cab.ss[0] ? cab.ss : "19:00";
  return strcmp(t, sr) < 0 || strcmp(t, ss) >= 0;
}

// ── Netz-Task ────────────────────────────────────────────────────────────────
static void parseCabin(const char* body, size_t len) {
  static JsonDocument doc;
  doc.clear();
  if (deserializeJson(doc, body, len)) { Serial.println("JSON-Fehler"); return; }
  if (doc["stale"] | false) return;
  Cabin& n = rx;
  memset(&n, 0, sizeof(n));
  n.have = true;
  cpy(n.time, sizeof(n.time), doc["time"]); cpy(n.utc, sizeof(n.utc), doc["utc"]); cpy(n.date, sizeof(n.date), doc["date"]);
  cpy(n.sr, sizeof(n.sr), doc["sr"]); cpy(n.ss, sizeof(n.ss), doc["ss"]); cpy(n.status, sizeof(n.status), doc["status"]);
  n.blink = doc["blink"] | false; n.acked = doc["acked"] | false;
  for (JsonVariantConst k : doc["keys"].as<JsonArrayConst>()) if (n.nKeys < 6) cpy(n.keys[n.nKeys++], 14, k);
  JsonObjectConst a = doc["anc"];
  cpy(n.aSt, sizeof(n.aSt), a["st"]); n.aAct = a["act"] | false;
  n.aDist = num(a["dist"]); n.aRad = num(a["rad"]); n.aDepth = num(a["depth"]); n.aChain = num(a["chain"]); n.aHdg = num(a["hdg"]);
  if (a["boff"].is<JsonArrayConst>()) { n.hasBoff = true; n.boff[0] = a["boff"][0] | 0; n.boff[1] = a["boff"][1] | 0; }
  for (JsonVariantConst p : a["track"].as<JsonArrayConst>()) if (n.nTrack < 60) { n.track[n.nTrack][0] = p[0] | 0; n.track[n.nTrack][1] = p[1] | 0; n.nTrack++; }
  JsonObjectConst w = doc["wind"];
  cpy(n.wSt, sizeof(n.wSt), w["st"]); n.wKn = num(w["kn"]); n.wMax = num(w["max"]); n.wThr = num(w["thr"]);
  cpy(n.wSrc, sizeof(n.wSrc), w["src"]); n.wWin = w["win"] | 10;
  for (JsonVariantConst v : w["hist"].as<JsonArrayConst>()) if (n.nHist < 60) n.hist[n.nHist++] = v | 0.0f;
  cpy(n.bSt, sizeof(n.bSt), doc["batt"]["st"]); n.soc = num(doc["batt"]["soc"]);
  cpy(n.rSt, sizeof(n.rSt), doc["baro"]["st"]); n.hpa = num(doc["baro"]["hpa"]); n.baroD = num(doc["baro"]["d"]);
  // Uhr: Epoche + Zeitzonen-Versatz aus "time" (lokal) vs. "utc" → läuft auch ohne Daten weiter
  uint32_t ts = doc["ts"] | 0;
  int lh, lm, uh, um;
  int off = tzOffMin;
  if (sscanf(n.time, "%d:%d", &lh, &lm) == 2 && sscanf(n.utc, "%d:%d", &uh, &um) == 2) {
    off = (lh * 60 + lm) - (uh * 60 + um);
    if (off > 840) off -= 1440;
    if (off < -720) off += 1440;
  }
  xSemaphoreTake(mtx, portMAX_DELAY);
  memcpy(&cab, &n, sizeof(cab));
  if (ts) { epochBase = ts; epochMs = millis(); tzOffMin = off; }
  lastOkMs = millis();
  dataRev++;
  xSemaphoreGive(mtx);
}

static int post(const char* path, uint32_t timeout) {
  HTTPClient http;
  http.setConnectTimeout(2000);
  http.setTimeout(timeout);
  int code = -1;
  if (http.begin(dashUrl() + path)) {
    http.addHeader("Content-Type", "application/json");
    code = http.POST("{}");
    http.end();
  }
  Serial.printf("POST %s -> %d\n", path, code);
  return code;
}

static void netTask(void*) {
  sw::syncExtra = ota::syncExtra; sw::syncReply = ota::syncReply;   // Firmware-Version melden, Update-Angebot lesen
  sw::begin("cabin", "SUKI-CabinWatch");   // WLAN-Verwaltung (SukiWifi.h)
  static char* buf = (char*)heap_caps_malloc(4096, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  uint32_t lastPoll = 0;
  for (;;) {
    sw::loop();
    ota::validate(lastOkMs != 0);   // neue Firmware erst bestätigen, wenn Node-RED erreicht wurde
    if (!sw::connected()) {
      wifiUp = false;
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }
    wifiUp = true;
    sw::sync(dashUrl());
    if (ota::due() && lastOkMs && millis() - lastOkMs < 10000) {
      // nie während eines Alarms; ein quittierter Alarm hält nur das automatische Update auf, nicht „Update now“
      xSemaphoreTake(mtx, portMAX_DELAY);
      bool calm = cab.have && !cab.blink && (strcmp(cab.status, "alarm") || ota::offerForce);
      xSemaphoreGive(mtx);
      if (calm) ota::run(dashUrl(), dataRev);
    }
    if (ackRequested) { post("/ack", 3000); ackRequested = false; lastPoll = 0; }
    if (anchorUpRequested) { aupResult = post("/anchor-up", 10000) == 200 ? 1 : -1; anchorUpRequested = false; lastPoll = 0; dataRev++; }
    if (millis() - lastPoll >= 2000) {
      lastPoll = millis();
      static HTTPClient http;
      static bool init = false;
      if (!init) { http.setReuse(true); http.setConnectTimeout(1500); http.setTimeout(2500); init = true; }
      if (http.begin(dashUrl() + "/cabin")) {
        int code = http.GET();
        if (code == 200) {
          WiFiClient* s = http.getStreamPtr();
          int len = http.getSize(), got = 0;
          if (len > 0 && len < 4096) {
            uint32_t t0 = millis();
            while (got < len && millis() - t0 < 2500) {
              int r = s->read((uint8_t*)buf + got, len - got);
              if (r > 0) got += r; else vTaskDelay(1);
            }
            if (got == len) parseCabin(buf, len);
          } else {
            String b = http.getString();
            parseCabin(b.c_str(), b.length());
          }
        } else {
          Serial.printf("GET cabin -> %d\n", code);
          http.end();
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

// ── Ton (ES8311 + Verstärker an EXIO2) ───────────────────────────────────────
enum SoundMode : uint8_t { SND_NONE, SND_SIREN, SND_TRIPLE, SND_SHORT };
struct Step { uint16_t hz, ms; };
static const Step PAT_SIREN[] = {{880, 280}, {0, 20}, {660, 280}, {0, 20}};
static const Step PAT_TRIPLE[] = {{1000, 140}, {0, 80}, {1000, 140}, {0, 80}, {1000, 140}, {0, 1100}};
static const Step PAT_SHORT[] = {{800, 120}, {0, 1880}};
static const Step PAT_NODATA[] = {{520, 120}, {0, 130}, {520, 120}, {0, 100}};
static const Step PAT_TEST[] = {{880, 250}, {0, 50}, {660, 250}, {0, 100}};
static volatile SoundMode sndMode = SND_NONE;
static volatile uint8_t sndOneShot = 0;   // 1 = keine Daten, 2 = Test
static volatile bool paWanted = false;
static const int SR = 48000;

static void audioTask(void*) {
  static int16_t buf[480 * 2];   // 10 ms Stereo
  SoundMode cur = SND_NONE;
  const Step* pat = nullptr; uint8_t patN = 0, idx = 0; bool loop = false;
  uint32_t left = 0, phase = 0, silentMs = 0;
  for (;;) {
    SoundMode m = sndMode;
    if (sndOneShot && (!pat || !loop)) {
      if (sndOneShot == 1) { pat = PAT_NODATA; patN = 4; } else { pat = PAT_TEST; patN = 4; }
      sndOneShot = 0; loop = false; idx = 0; left = pat[0].ms; cur = SND_NONE;
    } else if (m != cur) {
      cur = m; idx = 0;
      if (m == SND_SIREN) { pat = PAT_SIREN; patN = 4; } else if (m == SND_TRIPLE) { pat = PAT_TRIPLE; patN = 6; }
      else if (m == SND_SHORT) { pat = PAT_SHORT; patN = 2; } else pat = nullptr;
      loop = pat != nullptr;
      if (pat) left = pat[0].ms;
    }
    uint16_t hz = pat ? pat[idx].hz : 0;
    int16_t amp = hz ? 9000 : 0;
    uint32_t half = hz ? SR / (2 * hz) : 1;
    for (int i = 0; i < 480; i++) {
      int16_t v = amp ? ((phase / half) & 1 ? amp : -amp) : 0;
      phase++;
      buf[2 * i] = buf[2 * i + 1] = v;
    }
    if (hz) { paWanted = true; silentMs = 0; } else if ((silentMs += 10) > 1500) paWanted = false;
    i2s.write((uint8_t*)buf, sizeof(buf));
    if (pat) {
      left = left > 10 ? left - 10 : 0;
      if (!left) {
        if (++idx >= patN) { idx = 0; if (!loop) { pat = nullptr; cur = SND_NONE; continue; } }
        left = pat[idx].ms; phase = 0;
      }
    }
  }
}

// ── I2C-Peripherie (nur aus dem Haupt-Task) ──────────────────────────────────
static uint8_t tcaOut = 0x00;
static void tcaWrite(uint8_t reg, uint8_t v) { Wire.beginTransmission(TCA_ADDR); Wire.write(reg); Wire.write(v); Wire.endTransmission(); }
static void setPA(bool on) {
  uint8_t o = on ? (tcaOut | 0x04) : (tcaOut & ~0x04);
  if (o != tcaOut) { tcaOut = o; tcaWrite(0x01, tcaOut); }
}
static void pmuInit() {
  if (!pmu.begin(Wire, AXP2101_SLAVE_ADDRESS, PIN_SDA, PIN_SCL)) { Serial.println("AXP2101 nicht gefunden"); return; }
  pmu.setVbusVoltageLimit(XPOWERS_AXP2101_VBUS_VOL_LIM_4V36);
  pmu.setVbusCurrentLimit(XPOWERS_AXP2101_VBUS_CUR_LIM_1500MA);
  pmu.setSysPowerDownVoltage(2600);
  pmu.setALDO1Voltage(3300); pmu.setALDO2Voltage(3300); pmu.setALDO3Voltage(3300); pmu.setALDO4Voltage(3300);
  pmu.setBLDO1Voltage(1500); pmu.setBLDO2Voltage(2800); pmu.setDLDO1Voltage(3300);
  pmu.enableALDO1(); pmu.enableALDO2(); pmu.enableALDO3(); pmu.enableALDO4();
  pmu.enableBLDO1(); pmu.enableBLDO2(); pmu.enableDLDO1();
  pmu.disableTSPinMeasure();   // kein Akku-Temperaturfühler; Gerät läuft nur an USB
  Serial.println("AXP2101 ok");
}
static void audioInit() {
  es = es8311_create(I2C_NUM_0, ES8311_ADDRRES_0);
  es8311_clock_config_t clk = {};
  clk.mclk_inverted = false; clk.sclk_inverted = false; clk.mclk_from_mclk_pin = false; clk.sample_frequency = SR;
  if (es8311_init(es, &clk, ES8311_RESOLUTION_32, ES8311_RESOLUTION_32) != ESP_OK) Serial.println("ES8311 Init-Fehler");
  es8311_microphone_config(es, false);
  es8311_voice_volume_set(es, cfg.vol, nullptr);
  i2s.setPins(I2S_BCK, I2S_LRCK, I2S_DOUT, I2S_DIN, -1);
  if (!i2s.begin(I2S_MODE_STD, SR, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) Serial.println("I2S-Fehler");
}

static bool touchRead(int& x, int& y) {
  Wire.beginTransmission(FT_ADDR); Wire.write(0x02);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)FT_ADDR, (uint8_t)5) != 5) return false;
  uint8_t n = Wire.read() & 0x0F, xh = Wire.read(), xl = Wire.read(), yh = Wire.read(), yl = Wire.read();
  if (n == 0 || n > 2) return false;
  int rx = ((xh & 0x0F) << 8) | xl, ry = ((yh & 0x0F) << 8) | yl;   // Hochformat 0..319 / 0..479
  int tx = TOUCH_SWAP ? ry : rx, ty = TOUCH_SWAP ? rx : ry;
  if (TOUCH_INV_X) tx = W - 1 - tx;
  if (TOUCH_INV_Y) ty = H - 1 - ty;
  x = constrain(tx, 0, W - 1); y = constrain(ty, 0, H - 1);
  static uint32_t lastLog = 0;
  if (millis() - lastLog > 300) { lastLog = millis(); Serial.printf("touch raw %d,%d -> %d,%d\n", rx, ry, x, y); }
  return true;
}

// ── Zeichnen ─────────────────────────────────────────────────────────────────
using lgfx::textdatum_t;
static void T(const char* s, int x, int y, const lgfx::IFont* f, uint32_t c, textdatum_t d = textdatum_t::baseline_left) {
  fb.setFont(f); fb.setTextDatum(d); fb.setTextColor(c); fb.drawString(s, x, y);
}
static int TW(const char* s, const lgfx::IFont* f) { fb.setFont(f); return fb.textWidth(s); }
static const lgfx::IFont* fitF(const char* s, int maxW, std::initializer_list<const lgfx::IFont*> fs) {
  const lgfx::IFont* last = nullptr;
  for (auto f : fs) { last = f; if (TW(s, f) <= maxW) return f; }
  return last;
}
static void rr(int x, int y, int w, int h, int r, uint32_t fill, uint32_t stroke, int lw = 1, bool doFill = true) {
  if (doFill) fb.fillRoundRect(x, y, w, h, r, fill);
  for (int i = 0; i < lw; i++) fb.drawRoundRect(x + i, y + i, w - 2 * i, h - 2 * i, r > i ? r - i : 0, stroke);
}
static void dashCircle(int cx, int cy, int r, uint32_t c, int thick, int on, int step) {
  if (r < 2) return;
  for (int a = 0; a < 360; a += step) fb.fillArc(cx, cy, r + thick / 2, r - (thick - 1) / 2 - (thick > 1 ? 0 : 0), a, a + on, c);
}
static void dashH(int x0, int x1, int y, uint32_t c) { for (int x = x0; x < x1; x += 8) fb.drawFastHLine(x, y, min(4, x1 - x), c); }
static void dashBar(int cx, int y, int w, uint32_t c) { fb.fillRect(cx - w / 2, y - 3, w, 6, c); }
static uint32_t stCol(const char* st) {
  return !strcmp(st, "alarm") ? P->alarm : !strcmp(st, "warn") ? P->warn : !strcmp(st, "ok") ? P->ok : P->faint;
}
static bool blinkOn() { return millis() % 1000 < 550; }

static void anchorGlyph(int x, int y, float s, uint32_t c) {
  float lw = max(1.5f, s / 6) / 2;
  int rr0 = s * 0.2f;
  fb.fillCircle(x, y - s * 0.78f, rr0 + lw, c); fb.fillCircle(x, y - s * 0.78f, max(1.0f, rr0 - lw), P->bg);
  fb.drawWideLine(x, y - s * 0.58f, x, y + s * 0.8f, lw, c);
  fb.drawWideLine(x - s * 0.38f, y - s * 0.3f, x + s * 0.38f, y - s * 0.3f, lw, c);
  fb.fillArc(x, y + s * 0.15f, s * 0.65f + lw, s * 0.65f - lw, 27, 153, c);
}
static void boatGlyph(float x, float y, float s, float hdg, uint32_t c) {
  float a = (isnan(hdg) ? 0 : hdg) * DEG_TO_RAD, ca = cosf(a), sa = sinf(a);
  auto R = [&](float px, float py, int& ox, int& oy) { ox = lroundf(x + px * ca - py * sa); oy = lroundf(y + px * sa + py * ca); };
  int x0, y0, x1, y1, x2, y2, x3, y3;
  R(0, -s, x0, y0); R(s * 0.62f, s * 0.8f, x1, y1); R(0, s * 0.45f, x2, y2); R(-s * 0.62f, s * 0.8f, x3, y3);
  fb.fillTriangle(x0, y0, x1, y1, x2, y2, c); fb.fillTriangle(x0, y0, x2, y2, x3, y3, c);
}
static void chip(int xr, int y, const char* t, uint32_t c, bool filled) {   // rechtsbündig an xr
  int w = TW(t, &fB13F) + 18;
  if (filled) fb.fillRoundRect(xr - w, y, w, 21, 10, c);
  rr(xr - w, y, w, 21, 10, 0, c, 2, false);
  T(t, xr - w / 2, y + 15, &fB13F, filled ? P->bg : c, textdatum_t::baseline_center);
}
static void speaker(int x, int y, uint32_t c, bool muted) {
  fb.fillRect(x, y + 4, 5, 7, c); fb.fillTriangle(x + 4, y + 7, x + 9, y, x + 9, y + 14, c);
  if (muted) { fb.drawWideLine(x + 12, y + 3, x + 19, y + 11, 0.8f, c); fb.drawWideLine(x + 19, y + 3, x + 12, y + 11, 0.8f, c); }
  else { fb.drawArc(x + 9, y + 7, 5, 4, -50, 50, c); fb.drawArc(x + 9, y + 7, 9, 8, -50, 50, c); }
}

static void radar(const Cabin& d, bool stale, int cx, int cy, int R, bool big) {
  bool on = d.aAct && !stale;
  fb.fillCircle(cx, cy, R, P->bg); fb.drawCircle(cx, cy, R, P->line);
  if (!on) { anchorGlyph(cx, cy, big ? 22 : 13, P->faint); return; }
  float rad = isnan(d.aRad) ? 20 : d.aRad, ext = rad * 1.25f;
  if (d.hasBoff) ext = max(ext, hypotf(d.boff[0], d.boff[1]) * 1.15f);
  for (int i = 0; i < d.nTrack; i++) ext = max(ext, hypotf(d.track[i][0], d.track[i][1]) * 1.08f);
  float k = (R - 6) / ext;
  auto X = [&](float e) { return (int)lroundf(cx + e * k); };
  auto Y = [&](float n) { return (int)lroundf(cy - n * k); };
  if (big) {
    int step = ext > 120 ? 50 : ext > 50 ? 25 : 10;
    char s[10];
    for (int r = step; r < ext; r += step) {
      dashCircle(cx, cy, r * k, P->faint, 1, 2, 6);
      sprintf(s, "%d m", r); T(s, cx + 3, cy - r * k - 3, &fR11F, P->dim);
    }
    T("N", cx, cy - R + 15, &fB13F, P->dim, textdatum_t::baseline_center);
  }
  uint32_t rc = !strcmp(d.aSt, "alarm") ? P->alarm : !strcmp(d.aSt, "warn") ? P->warn : P->acc;
  dashCircle(cx, cy, rad * k, rc, big ? 3 : 2, 6, 10);
  for (int i = 1; i < d.nTrack; i++)
    fb.drawLine(X(d.track[i - 1][0]), Y(d.track[i - 1][1]), X(d.track[i][0]), Y(d.track[i][1]), P->dim);
  if (d.hasBoff) {
    int bx = X(d.boff[0]), by = Y(d.boff[1]);
    float len = hypotf(bx - cx, by - cy);
    for (float t = 0; t < len; t += 6) {
      float t2 = min(len, t + 3);
      fb.drawLine(cx + (bx - cx) * t / len, cy + (by - cy) * t / len, cx + (bx - cx) * t2 / len, cy + (by - cy) * t2 / len, P->faint);
    }
    boatGlyph(bx, by, big ? 11 : 7, d.aHdg, !strcmp(d.aSt, "alarm") ? P->alarm : P->boat);
  }
  anchorGlyph(cx, cy, big ? 14 : 9, P->txt);
}

static const char* alarmName(const char* k) {
  if (!strcmp(k, "anchor")) return "ANCHOR DRAG";
  if (!strcmp(k, "wind")) return "WIND";
  if (!strcmp(k, "batt")) return "BATTERY";
  if (!strcmp(k, "baro")) return "PRESSURE";
  if (!strcmp(k, "water")) return "WATER";
  if (!strcmp(k, "engtemp")) return "ENGINE TEMP";
  if (!strcmp(k, "test")) return "TEST ALARM";
  if (!strncmp(k, "storm", 5)) return "THUNDERSTORM";
  if (!strncmp(k, "rig", 3)) return "RIG LOAD";
  if (!strncmp(k, "ais", 3)) return "AIS TARGET";
  return k;
}

static int page = 0;
static String ackKeys;   // lokal stummgeschaltet für genau diese Alarm-Kombination
static String keyStr(const Cabin& d) { String s; for (int i = 0; i < d.nKeys; i++) { s += d.keys[i]; s += ','; } return s; }
static bool effBlink(const Cabin& d) { return d.blink && !(ackKeys.length() && ackKeys == keyStr(d)); }

static void fmtNum(char* s, float v, int dec) { if (isnan(v)) strcpy(s, "-"); else dtostrf(v, 0, dec, s); }

static void footer(const Cabin& d, bool stale, bool blink) {
  const int y = 300;
  char s[24];
  uint32_t bc = stale ? P->faint : !strcmp(d.bSt, "alarm") ? P->alarm : !strcmp(d.bSt, "warn") ? P->warn : P->dim;
  rr(12, y + 2, 24, 12, 2, 0, bc, 1, false); fb.fillRect(36, y + 5, 3, 6, bc);
  if (!stale && !isnan(d.soc)) fb.fillRect(14, y + 4, max(2, (int)(20 * d.soc / 100)), 8, bc);
  if (stale || isnan(d.soc)) strcpy(s, "-"); else sprintf(s, "%d %%", (int)lroundf(d.soc));
  T(s, 46, y + 14, &fB13F, bc);
  uint32_t rc = stale ? P->faint : !strcmp(d.rSt, "alarm") ? P->alarm : !strcmp(d.rSt, "warn") ? P->warn : P->dim;
  if (stale || isnan(d.hpa)) strcpy(s, "- hPa"); else sprintf(s, "%d hPa", (int)lroundf(d.hpa));
  T(s, 112, y + 14, &fB13F, rc);
  if (!stale && !isnan(d.baroD)) {   // Tendenzpfeil
    int ax = 112 + TW(s, &fB13F) + 10, ay = y + 8;
    float ang = d.baroD <= -1 ? 90 : d.baroD < -0.3f ? 45 : d.baroD >= 1 ? -90 : d.baroD > 0.3f ? -45 : 0;
    float ca = cosf(ang * DEG_TO_RAD), sa = sinf(ang * DEG_TO_RAD);
    int ex = ax + 12 * ca, ey = ay + 12 * sa;
    fb.drawWideLine(ax - 2 * ca, ay - 2 * sa, ex, ey, 0.9f, rc);
    fb.fillTriangle(ex + 3 * ca, ey + 3 * sa, ex - 4 * ca - 4 * sa, ey - 4 * sa + 4 * ca, ex - 4 * ca + 4 * sa, ey - 4 * sa - 4 * ca, rc);
  }
  bool muted = cfg.vol == 0;
  speaker(330, y, blink ? P->alarm : P->dim, muted);
  T(muted ? "OFF" : isNight() ? (cfg.nightShort ? "SHORT" : "FULL") : "ON", 354, y + 13, &fR11F, P->dim);
  fb.fillCircle(408, y + 8, 4, !wifiUp ? P->warn : stale ? P->alarm : P->ok);
  for (int i = 0; i < 4; i++) {
    if (i == page) fb.fillCircle(428 + i * 14, y + 8, 4, P->txt);
    else fb.drawCircle(428 + i * 14, y + 8, 3, P->dim);
  }
}

static void drawClock(const char* t, int x, int y, uint32_t c) {   // Ziffern mit etwas engerer Laufweite
  fb.setFont(&fClockF); fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(c);
  char ch[2] = {0, 0};
  for (const char* p = t; *p; p++) { ch[0] = *p; fb.drawString(ch, x, y); x += fb.textWidth(ch) - 3; }
}

static void drawHome(const Cabin& d, bool stale, bool blink) {
  char s[40], t[6];
  bool alarm = !strcmp(d.status, "alarm") && !stale, on = blinkOn();
  localHM(t, false);
  drawClock(t, 12, 98, stale && !epochBase ? P->dim : P->txt);
  if (alarm) {
    rr(306, 10, 166, 98, 10, blink && on ? P->alarm : P->alarmBg, P->alarm, 2);
    uint32_t fg = blink && on ? P->bg : P->alarm;
    const char* title = d.nKeys ? alarmName(d.keys[0]) : "ALARM";
    T(title, 389, 48, fitF(title, 152, {&fB24F, &fB17F, &fB13F}), fg, textdatum_t::baseline_center);
    if (d.nKeys > 1) {
      String more = "+ ";
      for (int i = 1; i < d.nKeys; i++) { if (i > 1) more += " · "; more += alarmName(d.keys[i]); }
      T(more.c_str(), 389, 68, fitF(more.c_str(), 152, {&fB13F, &fR11F}), fg, textdatum_t::baseline_center);
    }
    T(blink ? "TAP TO SILENCE" : "SILENCED", 389, 96, &fB13F, fg, textdatum_t::baseline_center);
  } else {
    bool ok = !stale && !strcmp(d.status, "ok");
    const char* txt = stale ? "NO DATA" : ok ? "ALL OK" : "NOTICE";
    uint32_t c = stale ? P->warn : ok ? P->ok : P->warn;
    fb.fillCircle(318, 30, 6, c); T(txt, 332, 36, &fB17F, c);
    T(d.date, 318, 70, &fR13F, P->dim);
    localHM(t, true); sprintf(s, "UTC %s", t);
    T(s, 318, 98, &fB24F, P->dim);
  }
  // Anker-Kachel
  const int ax = 8, ay = 118, aw = 228, ah = 172;
  bool aAl = !strcmp(d.aSt, "alarm") && !stale;
  rr(ax, ay, aw, ah, 12, aAl && blink && on ? P->alarmBg : P->tile, aAl ? P->alarm : P->line, aAl ? 3 : 1);
  T("ANCHOR", ax + 12, ay + 23, &fB13F, P->dim);
  const char* chipT; uint32_t chipC;
  if (stale) { chipT = "-"; chipC = P->faint; } else if (!d.aAct) { chipT = "OFF"; chipC = P->faint; }
  else if (aAl) { chipT = "DRAG"; chipC = P->alarm; } else if (!strcmp(d.aSt, "warn")) { chipT = "WATCH"; chipC = P->warn; }
  else { chipT = "ARMED"; chipC = P->ok; }
  chip(ax + aw - 10, ay + 8, chipT, chipC, aAl);
  radar(d, stale, ax + 66, ay + 102, 56, false);
  int nx = ax + 176;
  if (d.aAct && !stale && !isnan(d.aDist)) {
    uint32_t col = aAl ? P->alarm : !strcmp(d.aSt, "warn") ? P->warn : P->txt;
    sprintf(s, "%d", (int)lroundf(d.aDist));
    T(s, nx, ay + 98, fitF(s, 84, {&fBigF, &fMidF}), col, textdatum_t::baseline_center);
    sprintf(s, "m of %d m", (int)lroundf(isnan(d.aRad) ? 0 : d.aRad));
    T(s, nx, ay + 120, &fR13F, P->dim, textdatum_t::baseline_center);
    float pct = min(1.0f, d.aDist / max(1.0f, isnan(d.aRad) ? 1.0f : d.aRad));
    fb.fillRoundRect(nx - 40, ay + 134, 80, 6, 3, P->faint);
    fb.fillRoundRect(nx - 40, ay + 134, max(6, (int)(80 * pct)), 6, 3, aAl ? P->alarm : !strcmp(d.aSt, "warn") ? P->warn : P->acc);
    char dv[10]; fmtNum(dv, d.aDepth, 1); sprintf(s, "DEPTH %s m", dv);
    T(s, nx, ay + 160, &fR11F, P->dim, textdatum_t::baseline_center);
  } else {
    dashBar(nx, ay + 82, 36, P->faint);
    T(stale ? "no data" : "not armed", nx, ay + 122, &fR13F, P->dim, textdatum_t::baseline_center);
  }
  // Wind-Kachel
  const int wx = 244, wy = 118, ww = 228, wh = 172;
  bool wAl = !strcmp(d.wSt, "alarm") && !stale;
  rr(wx, wy, ww, wh, 12, wAl && blink && on ? P->alarmBg : P->tile, wAl ? P->alarm : P->line, wAl ? 3 : 1);
  T("WIND", wx + 12, wy + 23, &fB13F, P->dim);
  sprintf(s, "%s · kn", d.wSrc[0] ? d.wSrc : "AWS");
  T(s, wx + ww - 12, wy + 23, &fR11F, P->dim, textdatum_t::baseline_right);
  uint32_t wcol = stale ? P->faint : wAl ? P->alarm : !strcmp(d.wSt, "warn") ? P->warn : P->txt;
  if (stale || isnan(d.wKn)) dashBar(wx + ww / 2, wy + 76, 48, P->faint);
  else { fmtNum(s, d.wKn, 1); T(s, wx + ww / 2, wy + 98, fitF(s, ww - 30, {&fBigF, &fMidF}), wcol, textdatum_t::baseline_center); }
  const int gx = wx + 12, gy = wy + 114, gw = ww - 24, gh = 30;
  if (!stale && d.nHist > 1) {
    float top = max(10.0f, isnan(d.wThr) ? 0 : d.wThr * 1.05f);
    for (int i = 0; i < d.nHist; i++) top = max(top, d.hist[i]);
    auto PX = [&](int i) { return gx + (gw * i) / (d.nHist - 1); };
    auto PY = [&](float v) { return gy + gh - (int)(gh * v / top); };
    for (int i = 1; i < d.nHist; i++) {
      int x0 = PX(i - 1), x1 = PX(i), y0 = PY(d.hist[i - 1]), y1 = PY(d.hist[i]);
      fb.fillTriangle(x0, y0, x1, y1, x0, gy + gh, P->faint); fb.fillTriangle(x1, y1, x1, gy + gh, x0, gy + gh, P->faint);
    }
    uint32_t lc = wcol == P->txt ? P->acc : wcol;
    for (int i = 1; i < d.nHist; i++) fb.drawWideLine(PX(i - 1), PY(d.hist[i - 1]), PX(i), PY(d.hist[i]), 0.8f, lc);
    if (!isnan(d.wThr) && d.wThr <= top) dashH(gx, gx + gw, PY(d.wThr), P->alarm);
  }
  char mv[10]; if (stale) strcpy(mv, "-"); else fmtNum(mv, d.wMax, 1);
  sprintf(s, "MAX %d'  %s", d.wWin ? d.wWin : 10, mv);
  T(s, wx + 12, wy + 162, &fR13F, P->dim);
  fmtNum(mv, d.wThr, 0); sprintf(s, "ALARM %s", mv);
  T(s, wx + ww - 12, wy + 162, &fR11F, P->dim, textdatum_t::baseline_right);
  footer(d, stale, blink);
}

static void topBar(const Cabin& d, bool stale, bool blink, const char* title) {
  char t[6]; localHM(t, false);
  T(t, 12, 29, &fB24F, P->txt);
  T(title, 240, 27, &fB13F, P->dim, textdatum_t::baseline_center);
  if (!strcmp(d.status, "alarm") && !stale) chip(470, 10, blink ? "TAP TO SILENCE" : "SILENCED", P->alarm, blink && blinkOn());
  fb.drawFastHLine(0, 42, W, P->line);
}

static void drawAnchor(const Cabin& d, bool stale, bool blink) {
  topBar(d, stale, blink, "ANCHOR WATCH");
  bool on = d.aAct && !stale;
  radar(d, stale, 158, 180, 128, true);
  if (!on) T(stale ? "NO DATA" : "ANCHOR NOT ARMED", 158, 232, &fB17F, P->dim, textdatum_t::baseline_center);
  char v[4][10];
  if (on) sprintf(v[0], "%d", (int)lroundf(d.aDist)); else strcpy(v[0], "-");
  fmtNum(v[1], d.aRad, 0); fmtNum(v[2], d.aDepth, 1);
  if (on) fmtNum(v[3], d.aChain, 0); else strcpy(v[3], "-");
  const char* lbl[4] = {"DISTANCE", "RADIUS", "DEPTH", "CHAIN"};
  for (int i = 0; i < 4; i++) {
    int y = 52 + i * 50;
    rr(306, y, 166, 44, 8, P->tile, P->line, 1);
    T(lbl[i], 316, y + 17, &fR11F, P->dim);
    uint32_t c = (i == 0 && !strcmp(d.aSt, "alarm")) ? P->alarm : (i == 0 && !strcmp(d.aSt, "warn")) ? P->warn : P->txt;
    int uw = TW(" m", &fR13F);
    T(v[i], 462 - uw, y + 38, &fMidF, c, textdatum_t::baseline_right);
    T(" m", 462, y + 38, &fR13F, P->dim, textdatum_t::baseline_right);
  }
  const int by = 256;
  bool armed = millis() - aupArmedMs < 4000;
  const char* l; uint32_t c; bool fill = false;
  if (blink && !stale) { l = "SILENCE"; c = P->alarm; fill = true; }
  else if (millis() < aupMsgUntil) { l = aupResult > 0 ? "SENT" : "FAILED"; c = aupResult > 0 ? P->ok : P->alarm; }
  else if (anchorUpRequested) { l = "SENDING..."; c = P->warn; }
  else if (on) { l = armed ? "TAP AGAIN" : "ANCHOR UP"; c = armed ? P->warn : P->txt; fill = armed; }
  else { l = "NOT ARMED"; c = P->faint; }
  if (fill) fb.fillRoundRect(306, by, 166, 54, 10, c); else fb.fillRoundRect(306, by, 166, 54, 10, P->tile);
  rr(306, by, 166, 54, 10, 0, c, 2, false);
  T(l, 389, by + 34, &fB17F, fill ? P->bg : c, textdatum_t::baseline_center);
}

struct SetRow { const char* lbl; uint8_t* val; uint8_t step, mn, mx; const char* const* opts; uint8_t nOpts; bool test; };
static const char* const OPT_NIGHT[] = {"OFF", "ON", "AUTO"};
static const char* const OPT_SOUND[] = {"FULL", "SHORT"};
static SetRow ROWS[] = {
  {"NIGHT MODE", &cfg.night, 0, 0, 2, OPT_NIGHT, 3, false},
  {"BRIGHTNESS DAY", &cfg.briDay, 10, 10, 100, nullptr, 0, false},
  {"BRIGHTNESS NIGHT", &cfg.briNight, 5, 5, 60, nullptr, 0, false},
  {"VOLUME", &cfg.vol, 10, 0, 100, nullptr, 0, true},
  {"ALARM AT NIGHT", &cfg.nightShort, 0, 0, 1, OPT_SOUND, 2, false},
};
static void drawSettings(const Cabin& d, bool stale, bool blink) {
  topBar(d, stale, blink, "SETTINGS");
  char s[24];
  for (int i = 0; i < 5; i++) {
    const SetRow& r = ROWS[i];
    int y = 52 + i * 52;
    rr(8, y, 464, 46, 8, P->tile, P->line, 1);
    T(r.lbl, 20, y + 29, &fB13F, P->dim);
    if (r.opts) {
      for (int j = 0; j < r.nOpts; j++) {
        int bx = 470 - (r.nOpts - j) * 74; bool sel = *r.val == j;
        if (sel) fb.fillRoundRect(bx, y + 7, 68, 32, 6, P->acc);
        rr(bx, y + 7, 68, 32, 6, 0, sel ? P->acc : P->line, 1, false);
        T(r.opts[j], bx + 34, y + 28, &fB13F, sel ? P->bg : P->txt, textdatum_t::baseline_center);
      }
      if (i == 0 && cfg.night == 2) {
        sprintf(s, "%s-%s", d.ss[0] ? d.ss : "19:00", d.sr[0] ? d.sr : "07:00");
        T(s, 186, y + 29, &fR11F, P->dim, textdatum_t::baseline_center);
      }
    } else {
      int bx = r.test ? 252 : 326;
      rr(bx, y + 7, 40, 32, 6, 0, P->line, 1, false); fb.fillRect(bx + 13, y + 22, 14, 3, P->txt);
      sprintf(s, "%d %%", *r.val); T(s, bx + 72, y + 30, &fB17F, P->txt, textdatum_t::baseline_center);
      rr(bx + 104, y + 7, 40, 32, 6, 0, P->line, 1, false);
      fb.fillRect(bx + 117, y + 22, 14, 3, P->txt); fb.fillRect(bx + 122, y + 16, 4, 15, P->txt);
      if (r.test) { rr(402, y + 7, 68, 32, 6, 0, P->line, 1, false); T("TEST", 436, y + 28, &fB13F, P->txt, textdatum_t::baseline_center); }
    }
  }
}

// ── Netzwerk-Seite: QR-Code zu den WLAN-Einstellungen bzw. zum Einrichtungs-WLAN ──
static void drawNetwork(const Cabin& d, bool stale, bool blink) {
  topBar(d, stale, blink, "NETWORK");
  bool setup = sw::apActive() && !sw::connected();
  String qr;
  if (setup) qr = sw::apQr();
  else { qr = DASH_URL; if (qr.endsWith("/api")) qr = qr.substring(0, qr.length() - 4); qr += "/settings"; }
  const int qs = 196, qx = 20, qy = 58;
  fb.fillRect(qx - 8, qy - 8, qs + 16, qs + 16, TFT_WHITE);
  fb.qrcode(qr.c_str(), qx, qy, qs, 4);
  int x = 236;
  if (setup) {
    T("NO WIFI - SETUP", x, 76, &fB17F, P->warn);
    T("1. Scan the code to join", x, 112, &fR13F, P->txt);
    T("   the setup WiFi", x, 132, &fR13F, P->txt);
    T("2. Enter your network on", x, 160, &fR13F, P->txt);
    T("   the page that opens", x, 180, &fR13F, P->txt);
    T(sw::apSsid(), x, 216, &fB13F, P->dim);
    T("password sukisetup", x, 236, &fR13F, P->dim);
    T("http://192.168.4.1", x, 256, &fR13F, P->dim);
  } else {
    T("WIFI SETTINGS", x, 76, &fB17F, P->txt);
    T("Scan with your phone", x, 112, &fR13F, P->txt);
    T("(boat WiFi): settings page", x, 132, &fR13F, P->txt);
    T("with a WiFi section", x, 152, &fR13F, P->txt);
    if (sw::connected()) {
      T(WiFi.SSID().c_str(), x, 196, &fB13F, P->dim);
      char b[40]; snprintf(b, sizeof(b), "%s  %d dBm", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
      T(b, x, 216, &fR13F, P->dim);
    } else T("searching for WiFi ...", x, 196, &fR13F, P->warn);
    T("FW " FW_VERSION, x, 240, &fR11F, P->faint);
  }
  T("swipe for other pages", 240, 306, &fR11F, P->faint, textdatum_t::baseline_center);
}

// ── Touch-Bedienung ──────────────────────────────────────────────────────────
static void applyBrightness() { lcd.setBrightness(map(isNight() ? cfg.briNight : cfg.briDay, 0, 100, 0, 255)); }

static void onTap(int x, int y, const Cabin& d, bool stale) {
  if (effBlink(d) && !stale && (page != 2 || y < 42)) {   // jeder Tipp schaltet den Alarm stumm
    ackKeys = keyStr(d); ackRequested = true; return;
  }
  if (page == 3) return;   // Netzwerk-Seite: nur Anzeige
  if (page == 0) { if (x < 240 && y > 118 && y < 292) page = 1; return; }
  if (page == 1) {
    if (x > 306 && y > 256 && d.aAct && !stale && !anchorUpRequested) {
      if (millis() - aupArmedMs < 4000) { aupArmedMs = 0; anchorUpRequested = true; }
      else aupArmedMs = millis();
    }
    return;
  }
  for (int i = 0; i < 5; i++) {
    SetRow& r = ROWS[i];
    int ry = 52 + i * 52;
    if (y < ry || y > ry + 46) continue;
    if (r.opts) {
      for (int j = 0; j < r.nOpts; j++) { int bx = 470 - (r.nOpts - j) * 74; if (x >= bx && x <= bx + 68) *r.val = j; }
    } else {
      int bx = r.test ? 252 : 326;
      if (x >= bx && x <= bx + 40) *r.val = max((int)r.mn, *r.val - r.step);
      if (x >= bx + 104 && x <= bx + 144) *r.val = min((int)r.mx, *r.val + r.step);
      if (r.test && x >= 402) sndOneShot = 2;
      if (r.val == &cfg.vol && es) es8311_voice_volume_set(es, cfg.vol, nullptr);
    }
    saveCfg(); applyBrightness();
  }
}

// ── Setup / Loop ─────────────────────────────────────────────────────────────
static void splash() {
  lcd.fillScreen(TFT_BLACK);
  lcd.fillRect(40, 200, 120, 60, TFT_RED); lcd.fillRect(180, 200, 120, 60, TFT_GREEN); lcd.fillRect(320, 200, 120, 60, TFT_BLUE);
  lcd.setTextColor(TFT_WHITE); lcd.setFont(&fB24F); lcd.setTextDatum(textdatum_t::middle_center);
  lcd.drawString("SUKI CABIN WATCH", 240, 90);
  lcd.setFont(&fB17F);
  lcd.drawString("RED", 100, 230); lcd.drawString("GREEN", 240, 230); lcd.drawString("BLUE", 380, 230);
  lcd.setFont(&fR13F); lcd.drawString("top left", 40, 14); lcd.drawString("connecting...", 240, 140);
}

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\nSUKI Cabin Watch");
  ota::begin();
  pinMode(PIN_SD_CS, OUTPUT); digitalWrite(PIN_SD_CS, HIGH);   // SD-Karte am selben SPI-Bus abmelden
  Wire.begin(PIN_SDA, PIN_SCL, 400000);
  pmuInit();
  tcaWrite(0x03, 0xF8);                       // EXIO0..2 Ausgänge
  tcaWrite(0x01, 0x00); delay(20);            // LCD + Touch Reset
  tcaOut = 0x03; tcaWrite(0x01, tcaOut); delay(150);
  prefs.begin("cabin", false);
  loadCfg();
  fClockF.loadFont(new lgfx::PointerWrapper(fClock, sizeof(fClock)));
  fBigF.loadFont(new lgfx::PointerWrapper(fBig, sizeof(fBig)));
  fMidF.loadFont(new lgfx::PointerWrapper(fMid, sizeof(fMid)));
  fB24F.loadFont(new lgfx::PointerWrapper(fB24, sizeof(fB24)));
  fB17F.loadFont(new lgfx::PointerWrapper(fB17, sizeof(fB17)));
  fB13F.loadFont(new lgfx::PointerWrapper(fB13, sizeof(fB13)));
  fR13F.loadFont(new lgfx::PointerWrapper(fR13, sizeof(fR13)));
  fR11F.loadFont(new lgfx::PointerWrapper(fR11, sizeof(fR11)));
  lcd.init();
  lcd.setRotation(LCD_ROTATION);
  lcd.setBrightness(map(cfg.briDay, 0, 100, 0, 255));
  splash();
  fb.setPsram(true);
  fb.setColorDepth(16);
  if (!fb.createSprite(W, H)) Serial.println("Sprite-Speicher fehlt!");
  audioInit();
  mtx = xSemaphoreCreateMutex();
  memset(&cab, 0, sizeof(cab));
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 1, nullptr, 0);   // + WLAN-Webseite und Abgleich
  xTaskCreatePinnedToCore(audioTask, "audio", 4096, nullptr, 3, nullptr, 1);
  Serial.printf("Heap intern %u, PSRAM %u\n", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)ESP.getFreePsram());
  delay(1500);
}

void loop() {
  static uint32_t lastRev = 0, lastDraw = 0, lastNoData = 0, lastAlive = 0;
  static int lastPhase = -1, lastPage = -1;
  static bool down = false, lastNight = false; static int sx = 0, sy = 0, lx = 0, ly = 0;
  static char lastMin[6] = "";
  static bool pendTap = false; static uint32_t pendMs = 0; static int px = 0, py = 0;
  bool dirty = false;

  // Touch: Tippen / Wischen
  int tx, ty;
  bool t = touchRead(tx, ty);
  Cabin d;
  xSemaphoreTake(mtx, portMAX_DELAY); memcpy(&d, &cab, sizeof(d)); xSemaphoreGive(mtx);
  bool stale = isStale();
  if (t && !down) { down = true; sx = lx = tx; sy = ly = ty; }
  else if (t) { lx = tx; ly = ty; }
  else if (down) {
    down = false;
    int dx = lx - sx;
    if (abs(dx) > 60) { page = (page + (dx < 0 ? 1 : 3)) % 4; pendTap = false; }
    else if (page == 2 || (effBlink(d) && !stale)) onTap(sx, sy, d, stale);   // sofort: Einstellungen, Alarm stumm
    else if (pendTap && millis() - pendMs < 350) {   // Doppeltipp: Tag ↔ Nacht (überschreibt AUTO)
      pendTap = false;
      cfg.night = isNight() ? 0 : 1;
      saveCfg(); applyBrightness();
    } else { pendTap = true; pendMs = millis(); px = sx; py = sy; }
    dirty = true;
  }
  if (pendTap && millis() - pendMs >= 350) { pendTap = false; onTap(px, py, d, stale); dirty = true; }
  if (ackKeys.length() && ackKeys != keyStr(d)) ackKeys = "";   // neue Alarm-Kombination → wieder laut
  if (aupResult) { aupMsgUntil = millis() + 4000; aupResult = 0; dirty = true; }
  { static bool wasAp = false; bool ap = sw::apActive() && !sw::connected();
    if (ap != wasAp) { wasAp = ap; if (ap) page = 3; dirty = true; } }
  bool blink = effBlink(d) && !stale;

  // Ton
  bool night = isNight();
  SoundMode want = SND_NONE;
  if (blink && cfg.vol > 0) {
    bool anchor = false;
    for (int i = 0; i < d.nKeys; i++) if (!strcmp(d.keys[i], "anchor")) anchor = true;
    want = night && cfg.nightShort ? SND_SHORT : anchor ? SND_SIREN : SND_TRIPLE;
  }
  if (ota::pct >= 0) want = SND_NONE;   // während des Updates still
  sndMode = want;
  if (cab.have && stale && cfg.vol > 0 && millis() - lastNoData > 60000) { lastNoData = millis(); sndOneShot = 1; }
  if (!stale) lastNoData = millis() - 45000;   // nach Datenverlust erster Hinweis nach ~15 s
  setPA(paWanted);

  // Zeichnen nur bei Änderungen (Daten, Blinktakt, Minute, Seite, Nacht)
  char hm[6]; localHM(hm, false);
  int phase = (blink || (millis() - aupArmedMs < 4100)) ? (millis() % 1000 < 550) : -1;
  if (night != lastNight) { lastNight = night; applyBrightness(); dirty = true; }
  if (dataRev != lastRev || phase != lastPhase || page != lastPage || strcmp(hm, lastMin) || millis() - lastDraw > 5000) dirty = true;
  if (dirty && ota::pct >= 0) {   // Firmware-Update läuft: nur Fortschritt anzeigen
    lastRev = dataRev; lastDraw = millis();
    P = night ? &NIGHT : &DAY;
    fb.fillScreen(P->bg);
    T("UPDATING FIRMWARE", 240, 110, &fB24F, P->txt, textdatum_t::baseline_center);
    char b[64]; snprintf(b, sizeof(b), "%s  ->  %s", FW_VERSION, ota::offerVer);
    T(b, 240, 140, &fR13F, P->dim, textdatum_t::baseline_center);
    int p = constrain((int)ota::pct, 0, 100);
    rr(60, 165, 360, 24, 6, P->tile, P->line, 1);
    if (p > 0) fb.fillRoundRect(63, 168, 354 * p / 100, 18, 4, P->acc);
    snprintf(b, sizeof(b), "%d %%", p);
    T(b, 240, 222, &fB17F, P->txt, textdatum_t::baseline_center);
    T("Do not switch off - restarts by itself", 240, 270, &fR11F, P->faint, textdatum_t::baseline_center);
    lcd.startWrite(); fb.pushSprite(0, 0); lcd.endWrite();
    dirty = false;
  }
  if (dirty) {
    lastRev = dataRev; lastPhase = phase; lastPage = page; strcpy(lastMin, hm); lastDraw = millis();
    P = night ? &NIGHT : &DAY;
    fb.fillScreen(P->bg);
    if (page == 0) drawHome(d, stale, blink);
    else if (page == 1) drawAnchor(d, stale, blink);
    else if (page == 2) drawSettings(d, stale, blink);
    else drawNetwork(d, stale, blink);
    lcd.startWrite(); fb.pushSprite(0, 0); lcd.endWrite();
  }
  if (millis() - lastAlive > 60000) {
    lastAlive = millis();
    Serial.printf("alive: wifi=%d stale=%d heap=%u page=%d\n", (int)wifiUp, (int)stale, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), page);
  }
  delay(20);
}
