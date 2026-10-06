// SUKI Mini Dashboard — Waveshare ESP32-S3-Touch-LCD-7 (800x480)
//
// Reines Anzeige-Gerät: holt jede Sekunde den fertig ausgewerteten State vom
// Node-RED-Flow "ESP32 Mini Dashboard" (GET {DASH_URL}/state). Schwellwerte,
// Hysterese, Ankerstatus (Supabase) und Quittierung leben komplett in Node-RED,
// konfigurierbar unter http://192.168.0.100:1880/esp-dash/settings.
//
// Board: ESP32S3 Dev Module, PSRAM: OPI PSRAM, Flash: 8MB, Partition: 8M with spiffs
// Libs:  LovyanGFX 1.2.x, ArduinoJson 7.x

#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include "display.h"
#include "logo_vp.h"
#include "secrets.h"

// Alarm-Summer am "Sensor AD"-Stecker (PH2.0: 3V3 / GND / Signal). Über ein MOSFET-Modul
// wird ein 12-V-Piezo geschaltet. In secrets.h überschreibbar, -1 = kein Summer.
#ifndef BUZZER_PIN
#define BUZZER_PIN 6
#endif
#ifndef BUZZER_ACTIVE_HIGH
#define BUZZER_ACTIVE_HIGH 1
#endif

static LGFX lcd;
static LGFX_Sprite fb(&lcd);  // Vollbild-Framebuffer in PSRAM → kein Flackern

// ── Farben ──────────────────────────────────────────────────────────────────
// C_WHITE = Haupttext, C_ONRED = Vordergrund in der roten Blinkphase
static uint16_t C_BLACK, C_RED_BG, C_ONRED, C_WHITE, C_GREEN, C_AMBER, C_RED, C_GREY, C_DIM, C_BORDER, C_BLUE,
    C_TFACE, C_TBEZEL, C_TTRACK, C_TVAL, C_TNDL, C_TZG, C_TPILL, C_FUELBAR,  // Drehzahlmesser
    C_WSUN, C_WCLOUD, C_WCLOUD2, C_WRAIN, C_WMOON, C_WMDARK,  // Wetter-Icons
    C_CHFILL, C_CHLINE, C_CHFILL_AL, C_CHLINE_AL,  // Baro-Diagramm
    C_BOX, C_BOXON, C_BOXBRD, C_BOXBRDC, C_FLOW, C_FLOWOFF, C_ARROW, C_ETXT, C_ESUB;  // Energy-Flow-Screen


// ── State (vom Poll-Task geschrieben, vom Render-Loop gelesen) ─────────────
#define NA_I (-32768)
struct ABtn { const char* act; const char* lbl; uint8_t kind; bool confirm; };  // Anker-Aktionsknopf; kind 0 normal, 1 primär, 2 gefahr
struct WxDay {
  char dow[4] = "", date[8] = "", ic[8] = "", txt[16] = "", wd[3] = "";
  char sr[6] = "--", ss[6] = "--", mr[6] = "--", ms[6] = "--";
  int max = NA_I, min = NA_I, ws = NA_I, wg = NA_I, pp = NA_I, mp = NA_I;
  float ps = NAN;
};
struct DashState {
  bool valid = false;
  char status[8] = "warn";
  bool blink = false, acked = false, night = false;
  char beep[6] = "off";
  char time[8] = "--:--";
  char utc[8] = "";
  char msg[200] = "";
  char battSt[8] = "na";
  int battSoc = -1, battThr = -1;
  float battV = NAN, battA = NAN;
  char waterSt[8] = "na";
  int waterPct = -1, waterL = -1, waterCap = -1, waterThr = -1;
  char windSt[8] = "na";
  char windSrc[6] = "";
  float windKn = NAN, windMax = NAN;
  int windThr = -1, windWin = 0, windN = 0;
  float windHist[60];
  char ancSt[8] = "na";
  bool ancAct = false, ancCloud = false;
  int ancDist = -1, ancRad = -1;
  char baroSt[8] = "na";
  float baroHpa = NAN, baroD = NAN;
  int baroThr = -1, baroWin = 0, baroN = 0;
  float baroHist[60];
  // Wetter (Screen 3)
  bool wOk = false, wOld = false, cNight = false;
  char wUpd[6] = "", cIc[8] = "", cTxt[16] = "", cWd[3] = "", mpn[18] = "";
  int cT = NA_I, cWs = NA_I, cWg = NA_I, mp = NA_I, nDays = 0;
  WxDay today, days[3];
  // Anker-Screen (Screen 5)
  int aChainDb = NA_I, aBrgDb = NA_I, aHdg = NA_I, aBtoa = NA_I, aTrackN = 0;
  float aDepth = NAN, aScope = NAN, aLat = NAN, aLon = NAN, aBlat = NAN;
  bool aAlarming = false, aMuted = false, aHasLast = false, aHasBoff = false;
  int aBoffE = 0, aBoffN = 0;
  int16_t aTrack[120][2];
  // Motor (Screen 4)
  bool mOn = false, mTempLive = false, mEst = false;
  int mRpm = NA_I, mMax = 3000, mRed = 2500, mG0 = 1800, mG1 = 2200, mTemp = NA_I, mFuelPct = NA_I, mFuelL = NA_I, mFuelCap = NA_I, mRangeNm = NA_I;
  float mHrs = NAN, mLph = NAN, mRangeH = NAN, mSog = NAN;
  // Victron Energy Flow (NA_I = kein Wert)
  bool eOk = false, shoreOn = false;
  int shoreW, shoreV, invW, acW, pvW, batSoc, batW, dcW;
  float pvToday = NAN, batV = NAN, batA = NAN;
  char invSt[16] = "--", batSt[14] = "--", batTtg[12] = "";
};
static DashState S;
static SemaphoreHandle_t sMutex;
static volatile uint32_t lastOkMs = 0;
static volatile uint32_t dataRev = 0;
static volatile bool ackRequested = false;
static volatile int8_t nightRequest = -1;  // -1 = nichts, 0/1 = an Node-RED senden
static uint32_t localNightMs = 0;          // lokale Vorschau bis Node-RED bestätigt
static bool localNightVal = false;
// ANCHOR UP: 1. Tipp = bestätigen, 2. Tipp innerhalb 4 s = systemweit einholen (Supabase silence_alarm)
enum { AUP_IDLE, AUP_CONFIRM, AUP_BUSY, AUP_ERR };
static volatile uint8_t aupState = AUP_IDLE;
static volatile uint32_t aupUntil = 0;
static volatile bool anchorUpRequested = false;
#define AUP_X0 556
#define AUP_X1 772
#define AUP_Y0 180
#define AUP_Y1 214
static bool showSettings = false;
// Anker-Screen: lokale Einstellungen (Vorschau) + ausstehende Aktion an Node-RED
static int aRad = -1, aChain = 0, aBrg = 0;
static bool aBrgManual = false, aLocalInit = false;
static float aZoom = 1.0f;
static char aConfirm[10] = "";          // Aktion, die auf den 2. Tipp wartet
static uint32_t aConfirmUntil = 0;
static uint32_t aSaveAt = 0;             // verzögertes Speichern bei aktivem Anker
static char aSaveKind[8] = "";
static char aMsg[32] = "";
static uint32_t aMsgUntil = 0;
static volatile bool aReqPending = false, aReqBusy = false;
static char aReqBody[160] = "";
static uint32_t settingsOpenedMs = 0;  // QR-Code-Seite mit Link zu den Node-RED-Settings
static uint8_t page = 1;         // 1 = Übersicht, 2 = Victron Energy Flow, 3 = Wetter, 4 = Motor, 5 = Anker (per Wischen)
static uint32_t localAckMs = 0;  // unterdrückt Blinken kurz bis zur Bestätigung von Node-RED

// Tag: schwarz/weiß/grün — Nacht: schwarz/rot (Nachtsicht schonen), Alarm blinkt dunkelrot
static void applyPalette(bool night) {
  auto c = [](uint8_t r, uint8_t g, uint8_t b) { return lgfx::color565(r, g, b); };
  C_BLACK = c(0, 0, 0);
  if (!night) {
    C_RED_BG = c(208, 0, 0);   C_ONRED = c(255, 255, 255); C_WHITE = c(255, 255, 255);
    C_GREEN = c(0, 208, 0);    C_AMBER = c(255, 160, 0);   C_RED = c(255, 48, 48);
    C_GREY = c(170, 170, 170); C_DIM = c(110, 110, 110);   C_BORDER = c(51, 51, 51);
    C_BLUE = c(42, 157, 244);
    C_TFACE = c(16, 16, 16);   C_TBEZEL = c(58, 58, 58);   C_TTRACK = c(28, 28, 28);  C_TVAL = c(79, 195, 247);
    C_TNDL = c(255, 59, 48);   C_TZG = c(0, 200, 83);      C_TPILL = c(17, 17, 17);   C_FUELBAR = c(255, 196, 0);
    C_WSUN = c(255, 196, 0);   C_WCLOUD = c(200, 205, 210); C_WCLOUD2 = c(138, 144, 150);
    C_WRAIN = c(42, 157, 244); C_WMOON = c(232, 228, 200); C_WMDARK = c(42, 42, 42);
    C_CHFILL = c(10, 30, 48);  C_CHLINE = c(30, 95, 150);  C_CHFILL_AL = c(48, 8, 8); C_CHLINE_AL = c(150, 40, 40);
    // Victron-VRM-Blau wie VictronCard.svelte der Pro App
    C_BOX = c(13, 45, 74);     C_BOXON = c(21, 101, 192);  C_BOXBRD = c(30, 68, 102);
    C_BOXBRDC = c(61, 111, 158); C_FLOW = c(100, 170, 255); C_FLOWOFF = c(28, 36, 44);
    C_ARROW = c(140, 200, 255); C_ETXT = c(255, 255, 255); C_ESUB = c(160, 175, 190);
  } else {
    C_RED_BG = c(144, 0, 0);   C_ONRED = c(0, 0, 0);       C_WHITE = c(192, 0, 0);
    C_GREEN = c(208, 0, 0);    C_AMBER = c(208, 64, 0);    C_RED = c(255, 32, 32);
    C_GREY = c(150, 0, 0);     C_DIM = c(112, 0, 0);       C_BORDER = c(64, 0, 0);
    C_BLUE = c(176, 0, 0);
    C_TFACE = c(8, 0, 0);      C_TBEZEL = c(48, 0, 0);     C_TTRACK = c(26, 0, 0);    C_TVAL = c(144, 0, 0);
    C_TNDL = c(224, 0, 0);     C_TZG = c(96, 0, 0);        C_TPILL = c(10, 0, 0);     C_FUELBAR = c(160, 0, 0);
    C_WSUN = c(192, 0, 0);     C_WCLOUD = c(112, 0, 0);     C_WCLOUD2 = c(80, 0, 0);
    C_WRAIN = c(192, 0, 0);    C_WMOON = c(192, 0, 0);      C_WMDARK = c(32, 0, 0);
    C_CHFILL = c(24, 0, 0);    C_CHLINE = c(96, 0, 0);     C_CHFILL_AL = c(48, 0, 0); C_CHLINE_AL = c(150, 0, 0);
    C_BOX = c(26, 0, 0);       C_BOXON = c(74, 0, 0);      C_BOXBRD = c(64, 0, 0);
    C_BOXBRDC = c(96, 0, 0);   C_FLOW = c(160, 0, 0);      C_FLOWOFF = c(32, 0, 0);
    C_ARROW = c(208, 0, 0);    C_ETXT = c(192, 0, 0);      C_ESUB = c(144, 0, 0);
  }
}

// ── CH422G IO-Expander + GT911 Touch ────────────────────────────────────────
static uint8_t gtAddr = 0;

static void ch422Write(uint8_t addr, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(val);
  Wire.endTransmission();
}

static void boardInit() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  // Sequenz aus dem Waveshare-Demo: Ausgänge aktivieren, Touch-Reset mit INT=LOW
  // (→ GT911-Adresse 0x5D), Backlight + LCD-Reset high.
  ch422Write(0x24, 0x01);
  ch422Write(0x38, 0x2C);
  delay(100);
  pinMode(PIN_TOUCH_INT, OUTPUT);
  digitalWrite(PIN_TOUCH_INT, LOW);
  delay(100);
  ch422Write(0x38, 0x2E);
  delay(200);
  pinMode(PIN_TOUCH_INT, INPUT);

  for (uint8_t a : {0x5D, 0x14}) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { gtAddr = a; break; }
  }
  Serial.printf("GT911 touch: %s (0x%02X)\n", gtAddr ? "gefunden" : "NICHT gefunden", gtAddr);
}

static bool touchRead(int& tx, int& ty) {
  if (!gtAddr) return false;
  Wire.beginTransmission(gtAddr);
  Wire.write(0x81); Wire.write(0x4E);
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom(gtAddr, (uint8_t)1) != 1) return false;
  uint8_t st = Wire.read();
  if (!(st & 0x80)) return false;  // noch keine neuen Daten
  bool down = (st & 0x0F) > 0;
  if (down) {  // erster Touchpunkt: X/Y ab Register 0x8150
    Wire.beginTransmission(gtAddr);
    Wire.write(0x81); Wire.write(0x50);
    Wire.endTransmission();
    if (Wire.requestFrom(gtAddr, (uint8_t)4) == 4) {
      tx = Wire.read(); tx |= Wire.read() << 8;
      ty = Wire.read(); ty |= Wire.read() << 8;
    }
  }
  Wire.beginTransmission(gtAddr);  // Status-Register zurücksetzen
  Wire.write(0x81); Wire.write(0x4E); Wire.write(0x00);
  Wire.endTransmission();
  return down;
}

// ── Summer ─────────────────────────────────────────────────────────────────
static void buzzer(bool on) {
  if (BUZZER_PIN < 0) return;
  static int8_t last = -1;
  if (last == (int8_t)on) return;
  last = on;
  digitalWrite(BUZZER_PIN, on == (bool)BUZZER_ACTIVE_HIGH ? HIGH : LOW);
}

// full: an während der roten Blinkphase — short: 80 ms Pieps alle 2 s
static void updateBuzzer(const char* mode, uint32_t now) {
  if (!strcmp(mode, "full")) buzzer((now / 500) % 2);
  else if (!strcmp(mode, "short")) buzzer(now % 2000 < 80);
  else buzzer(false);
}

// ── Netzwerk (eigener Task auf Core 0, blockiert das Rendering nicht) ──────
static void parseState(const String& body) {
  JsonDocument doc;
  if (deserializeJson(doc, body)) return;
  DashState n;
  n.valid = true;
  strlcpy(n.status, doc["status"] | "warn", sizeof(n.status));
  n.blink = doc["blink"] | false;
  n.acked = doc["acked"] | false;
  n.night = doc["night"] | false;
  strlcpy(n.beep, doc["beep"] | "off", sizeof(n.beep));
  strlcpy(n.time, doc["time"] | "--:--", sizeof(n.time));
  strlcpy(n.utc, doc["utc"] | "", sizeof(n.utc));
  strlcpy(n.msg, doc["msg"] | "", sizeof(n.msg));

  JsonObject b = doc["batt"];
  strlcpy(n.battSt, b["st"] | "na", sizeof(n.battSt));
  n.battSoc = b["soc"] | -1;
  n.battV = b["v"] | NAN;
  n.battA = b["a"] | NAN;
  n.battThr = b["thr"] | -1;

  JsonObject f = doc["water"];
  strlcpy(n.waterSt, f["st"] | "na", sizeof(n.waterSt));
  n.waterPct = f["pct"] | -1;
  n.waterL = f["l"] | -1;
  n.waterCap = f["cap"] | -1;
  n.waterThr = f["thr"] | -1;

  JsonObject w = doc["wind"];
  strlcpy(n.windSt, w["st"] | "na", sizeof(n.windSt));
  strlcpy(n.windSrc, w["src"] | "", sizeof(n.windSrc));
  n.windKn = w["kn"] | NAN;
  n.windMax = w["max"] | NAN;
  n.windThr = w["thr"] | -1;
  n.windWin = w["win"] | 0;
  n.windN = 0;
  for (JsonVariant v : w["hist"].as<JsonArray>()) {
    if (n.windN >= 60) break;
    n.windHist[n.windN++] = v.isNull() ? NAN : v.as<float>();
  }

  JsonObject a = doc["anchor"];
  strlcpy(n.ancSt, a["st"] | "na", sizeof(n.ancSt));
  n.ancAct = a["act"] | false;
  n.ancCloud = a["cloud"] | false;
  n.ancDist = a["dist"] | -1;
  n.ancRad = a["rad"] | -1;

  JsonObject p = doc["baro"];
  strlcpy(n.baroSt, p["st"] | "na", sizeof(n.baroSt));
  n.baroHpa = p["hpa"] | NAN;
  n.baroD = p["d"] | NAN;
  n.baroThr = p["thr"] | -1;
  n.baroWin = p["win"] | 0;
  n.baroN = 0;
  for (JsonVariant v : p["hist"].as<JsonArray>()) {
    if (n.baroN >= 60) break;
    n.baroHist[n.baroN++] = v.isNull() ? NAN : v.as<float>();
  }

  JsonObject am = a["map"];
  n.aChainDb = am["chain"] | NA_I; n.aBrgDb = am["brg"] | NA_I; n.aHdg = am["hdg"] | NA_I; n.aBtoa = am["btoa"] | NA_I;
  n.aDepth = am["depth"] | NAN; n.aScope = am["scope"] | NAN;
  n.aLat = am["lat"] | NAN; n.aLon = am["lon"] | NAN; n.aBlat = am["blat"] | NAN;
  n.aHasLast = !isnan(n.aLat);
  n.aAlarming = am["alarming"] | false; n.aMuted = am["muted"] | false;
  n.aHasBoff = !am["boff"].isNull();
  if (n.aHasBoff) { n.aBoffE = am["boff"][0] | 0; n.aBoffN = am["boff"][1] | 0; }
  n.aTrackN = 0;
  for (JsonVariant v : am["track"].as<JsonArray>()) {
    if (n.aTrackN >= 120) break;
    n.aTrack[n.aTrackN][0] = v[0] | 0; n.aTrack[n.aTrackN][1] = v[1] | 0; n.aTrackN++;
  }

  JsonObject m = doc["engine"];
  n.mOn = m["on"] | false;
  n.mRpm = m["rpm"] | NA_I;
  n.mMax = m["max"] | 3000;
  n.mRed = m["red"] | 2500;
  n.mG0 = m["g0"] | 1800;
  n.mG1 = m["g1"] | 2200;
  n.mTemp = m["temp"] | NA_I;
  n.mTempLive = m["tempLive"] | false;
  n.mHrs = m["hrs"] | NAN;
  n.mLph = m["lph"] | NAN;
  n.mEst = m["est"] | false;
  n.mFuelPct = m["fuelPct"] | NA_I;
  n.mFuelL = m["fuelL"] | NA_I;
  n.mFuelCap = m["fuelCap"] | NA_I;
  n.mRangeH = m["rangeH"] | NAN;
  n.mRangeNm = m["rangeNm"] | NA_I;
  n.mSog = m["sog"] | NAN;

  JsonObject wx = doc["weather"];
  n.wOk = wx["ok"] | false;
  if (n.wOk) {
    n.wOld = wx["old"] | false;
    strlcpy(n.wUpd, wx["upd"] | "", sizeof(n.wUpd));
    JsonObject c = wx["cur"];
    n.cT = c["t"] | NA_I; n.cWs = c["ws"] | NA_I; n.cWg = c["wg"] | NA_I;
    n.cNight = c["night"] | false;
    strlcpy(n.cIc, c["ic"] | "", sizeof(n.cIc));
    strlcpy(n.cTxt, c["txt"] | "", sizeof(n.cTxt));
    strlcpy(n.cWd, c["wd"] | "", sizeof(n.cWd));
    n.mp = wx["mp"] | NA_I;
    strlcpy(n.mpn, wx["mpn"] | "", sizeof(n.mpn));
    auto rd = [](JsonObject o, WxDay& d) {
      strlcpy(d.dow, o["dow"] | "", sizeof(d.dow));   strlcpy(d.date, o["date"] | "", sizeof(d.date));
      strlcpy(d.ic, o["ic"] | "", sizeof(d.ic));      strlcpy(d.txt, o["txt"] | "", sizeof(d.txt));
      strlcpy(d.wd, o["wd"] | "", sizeof(d.wd));
      strlcpy(d.sr, o["sr"] | "--", sizeof(d.sr));    strlcpy(d.ss, o["ss"] | "--", sizeof(d.ss));
      strlcpy(d.mr, o["mr"] | "--", sizeof(d.mr));    strlcpy(d.ms, o["ms"] | "--", sizeof(d.ms));
      d.max = o["max"] | NA_I; d.min = o["min"] | NA_I; d.ws = o["ws"] | NA_I; d.wg = o["wg"] | NA_I;
      d.pp = o["pp"] | NA_I; d.mp = o["mp"] | NA_I; d.ps = o["ps"] | NAN;
    };
    rd(wx["today"], n.today);
    n.nDays = 0;
    for (JsonObject o : wx["days"].as<JsonArray>()) { if (n.nDays >= 3) break; rd(o, n.days[n.nDays++]); }
  }

  JsonObject e = doc["energy"];
  n.eOk = e["ok"] | false;
  n.shoreOn = e["shore"]["on"] | false;
  n.shoreW = e["shore"]["w"] | NA_I;
  n.shoreV = e["shore"]["v"] | NA_I;
  strlcpy(n.invSt, e["inv"]["st"] | "--", sizeof(n.invSt));
  n.invW = e["inv"]["w"] | NA_I;
  n.acW = e["ac"]["w"] | NA_I;
  n.pvW = e["pv"]["w"] | NA_I;
  n.pvToday = e["pv"]["today"] | NAN;
  n.batSoc = e["bat"]["soc"] | NA_I;
  n.batV = e["bat"]["v"] | NAN;
  n.batA = e["bat"]["a"] | NAN;
  n.batW = e["bat"]["w"] | NA_I;
  strlcpy(n.batSt, e["bat"]["st"] | "--", sizeof(n.batSt));
  strlcpy(n.batTtg, e["bat"]["ttg"] | "", sizeof(n.batTtg));
  n.dcW = e["dc"]["w"] | NA_I;

  xSemaphoreTake(sMutex, portMAX_DELAY);
  S = n;
  xSemaphoreGive(sMutex);
  lastOkMs = millis();
  dataRev++;
}

static void netTask(void*) {
  // Mehrere WLANs: WiFiMulti verbindet mit dem stärksten verfügbaren und wechselt bei Ausfall
  static WiFiMulti multi;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  multi.addAP(WIFI_SSID, WIFI_PASS);
#ifdef WIFI_SSID2
  if (strlen(WIFI_SSID2)) multi.addAP(WIFI_SSID2, WIFI_PASS2);
#endif
  uint32_t lastPoll = 0;
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      if (multi.run(5000) == WL_CONNECTED) Serial.printf("WLAN: %s (%d dBm)\n", WiFi.SSID().c_str(), WiFi.RSSI());
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }

    if (ackRequested) {
      HTTPClient http;
      http.setConnectTimeout(1500);
      http.setTimeout(2000);
      if (http.begin(String(DASH_URL) + "/ack")) {
        http.addHeader("Content-Type", "application/json");
        int code = http.POST("{}");
        Serial.printf("ack -> %d\n", code);
        http.end();
      }
      ackRequested = false;
      lastPoll = 0;  // sofort neuen State holen
    }

    if (anchorUpRequested) {
      HTTPClient http;
      http.setConnectTimeout(2000);
      http.setTimeout(10000);  // Node-RED → Supabase Edge Function
      int code = -1;
      if (http.begin(String(DASH_URL) + "/anchor-up")) {
        http.addHeader("Content-Type", "application/json");
        code = http.POST("{}");
        http.end();
      }
      Serial.printf("anchor-up -> %d\n", code);
      if (code == 200) { aupState = AUP_IDLE; }
      else { aupState = AUP_ERR; aupUntil = millis() + 5000; }
      anchorUpRequested = false;
      dataRev++;
      lastPoll = 0;
    }

    if (aReqPending) {
      aReqBusy = true;
      HTTPClient http;
      http.setConnectTimeout(2000);
      http.setTimeout(10000);
      int code = -1;
      if (http.begin(String(DASH_URL) + "/anchor")) {
        http.addHeader("Content-Type", "application/json");
        code = http.POST(aReqBody);
        http.end();
      }
      Serial.printf("anchor %s -> %d\n", aReqBody, code);
      strlcpy(aMsg, code == 200 ? "Saved" : "Failed", sizeof(aMsg));
      aMsgUntil = millis() + 4000;
      aReqPending = false; aReqBusy = false;
      aLocalInit = false;  // lokale Werte nach Bestätigung neu aus der DB übernehmen
      dataRev++;
      lastPoll = 0;
    }

    if (nightRequest >= 0) {
      HTTPClient http;
      http.setConnectTimeout(1500);
      http.setTimeout(2000);
      if (http.begin(String(DASH_URL) + "/config")) {
        http.addHeader("Content-Type", "application/json");
        int code = http.POST(nightRequest ? "{\"night\":true}" : "{\"night\":false}");
        Serial.printf("night -> %d\n", code);
        http.end();
      }
      nightRequest = -1;
      lastPoll = millis() - 800;  // State nach Node-RED-Tick holen
    }

    if (millis() - lastPoll >= 1000) {
      lastPoll = millis();
      HTTPClient http;
      http.setConnectTimeout(1500);
      http.setTimeout(2000);
      if (http.begin(String(DASH_URL) + "/state")) {
        int code = http.GET();
        if (code == 200) parseState(http.getString());
        else Serial.printf("state -> %d\n", code);
        http.end();
      }
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

// ── Zeichnen ────────────────────────────────────────────────────────────────
static uint16_t stColor(const char* st, bool red) {
  if (red) return C_ONRED;
  if (!strcmp(st, "alarm")) return C_RED;
  if (!strcmp(st, "ok")) return C_GREEN;
  if (!strcmp(st, "off")) return C_WHITE;
  return C_AMBER;
}

// Großer Wert + kleine Einheit, gemeinsam horizontal zentriert auf Grundlinie
static bool gTransp = false;  // Texte ohne Hintergrund (über Diagrammen)

static void bigValue(const char* val, const char* unit, int cx, int baseY, uint16_t col, uint16_t bg) {
  fb.setFont(&fonts::DejaVu72);
  int wv = fb.textWidth(val);
  fb.setFont(&fonts::DejaVu24);
  int wu = unit && *unit ? fb.textWidth(unit) + 6 : 0;
  int x = cx - (wv + wu) / 2;
  fb.setTextDatum(textdatum_t::baseline_left);
  if (gTransp) fb.setTextColor(col); else fb.setTextColor(col, bg);
  fb.setFont(&fonts::DejaVu72);
  fb.drawString(val, x, baseY);
  if (wu) {
    fb.setFont(&fonts::DejaVu24);
    fb.drawString(unit, x + wv + 6, baseY);
  }
}

static void centerText(const char* s, int cx, int y, const lgfx::IFont* font, uint16_t col, uint16_t bg) {
  fb.setFont(font);
  fb.setTextDatum(textdatum_t::middle_center);
  if (gTransp) fb.setTextColor(col); else fb.setTextColor(col, bg);
  fb.drawString(s, cx, y);
}

static void tileFrame(int x, const char* title, bool alarm, bool red, uint16_t bg) {
  const int y = 72, w = 248, h = 320;
  uint16_t border = red ? C_ONRED : (alarm ? C_RED : C_BORDER);
  int thick = alarm ? 5 : 2;
  for (int i = 0; i < thick; i++) fb.drawRoundRect(x + i, y + i, w - 2 * i, h - 2 * i, 14 - i, border);
  centerText(title, x + w / 2, y + 26, &fonts::DejaVu18, red ? C_ONRED : C_GREY, bg);
}

// Halbe Kachel (linke Spalte): Titel links, Schwelle rechts, Wert, Balken, Zusatzzeile
static void halfTile(int y, const char* title, const char* st, bool online, int pct, int thr,
                     const char* subLine, uint16_t barCol, bool red, uint16_t bg) {
  const int x = 12, w = 248, h = 154, cx = x + w / 2;
  bool al = online && !strcmp(st, "alarm");
  uint16_t border = red ? C_ONRED : (al ? C_RED : C_BORDER);
  int thick = al ? 5 : 2;
  for (int i = 0; i < thick; i++) fb.drawRoundRect(x + i, y + i, w - 2 * i, h - 2 * i, 14 - i, border);
  char buf[24];
  fb.setFont(&fonts::DejaVu18);
  fb.setTextColor(red ? C_ONRED : C_GREY, bg);
  fb.setTextDatum(textdatum_t::middle_left);
  fb.drawString(title, x + 16, y + 20);
  if (thr >= 0) {
    snprintf(buf, sizeof(buf), "< %d %%", thr);
    fb.setTextColor(red ? C_ONRED : C_DIM, bg);
    fb.setTextDatum(textdatum_t::middle_right);
    fb.drawString(buf, x + w - 16, y + 20);
  }
  if (online && pct >= 0) snprintf(buf, sizeof(buf), "%d", pct); else strcpy(buf, "--");
  fb.setFont(&fonts::DejaVu56);
  int wv = fb.textWidth(buf);
  fb.setFont(&fonts::DejaVu24);
  int wu = fb.textWidth("%") + 6;
  int bx = cx - (wv + wu) / 2;
  // Im Normalzustand Wert in der Balkenfarbe (Batterie grün, Water blau)
  uint16_t col = !online ? C_AMBER : (!red && !strcmp(st, "ok")) ? barCol : stColor(st, red);
  fb.setTextDatum(textdatum_t::baseline_left);
  fb.setTextColor(col, bg);
  fb.setFont(&fonts::DejaVu56);
  fb.drawString(buf, bx, y + 92);
  fb.setFont(&fonts::DejaVu24);
  fb.drawString("%", bx + wv + 6, y + 92);
  int p = online && pct >= 0 ? constrain(pct, 0, 100) : 0;
  fb.fillRoundRect(x + 24, y + 104, 200, 8, 4, red ? C_ONRED : C_BORDER);
  if (p) fb.fillRoundRect(x + 24, y + 104, 2 * p, 8, 4, red ? C_RED_BG : (al ? C_RED : barCol));
  centerText(subLine, cx, y + 132, &fonts::DejaVu18, red ? C_ONRED : C_GREY, bg);
}

// ── Screen 2: Victron Energy Flow ──────────────────────────────────────────
//   Shore ──► Inverter ──► AC Loads
//                 ↕
//   Solar ──► Battery  ──► DC Loads
static void eBox(int x, int y, const char* label, bool on, bool center, bool red, uint16_t bg) {
  const int w = 220, h = 132;
  if (!red) fb.fillRoundRect(x, y, w, h, 8, on ? C_BOXON : C_BOX);
  fb.drawRoundRect(x, y, w, h, 8, red ? C_ONRED : (center ? C_BOXBRDC : C_BOXBRD));
  fb.setFont(&fonts::DejaVu18);
  fb.setTextDatum(textdatum_t::top_left);
  fb.setTextColor(red ? C_ONRED : C_ESUB, red ? bg : (on ? C_BOXON : C_BOX));
  fb.drawString(label, x + 14, y + 12);
}

static void eText(int x, int y, const char* val, const char* unit, const lgfx::IFont* font, bool on, bool red, uint16_t bg) {
  uint16_t b = red ? bg : (on ? C_BOXON : C_BOX);
  fb.setTextDatum(textdatum_t::baseline_left);
  fb.setFont(font);
  fb.setTextColor(red ? C_ONRED : C_ETXT, b);
  fb.drawString(val, x, y);
  if (unit && *unit) {
    int wv = fb.textWidth(val);
    fb.setFont(&fonts::DejaVu18);
    fb.setTextColor(red ? C_ONRED : C_ESUB, b);
    fb.drawString(unit, x + wv + 6, y);
  }
}

static void eSub(int x, int y, const char* txt, bool on, bool red, uint16_t bg) {
  fb.setTextDatum(textdatum_t::baseline_left);
  fb.setFont(&fonts::DejaVu18);
  fb.setTextColor(red ? C_ONRED : C_ESUB, red ? bg : (on ? C_BOXON : C_BOX));
  fb.drawString(txt, x, y);
}

// Verbindungslinie mit wanderndem Pfeil (dir: 0 = rechts, 1 = hoch, 2 = runter)
static void eConn(int x0, int y0, int len, bool vertical, bool on, int dir, bool red, uint32_t now) {
  uint16_t lc = red ? C_ONRED : (on ? C_FLOW : C_FLOWOFF);
  if (vertical) fb.fillRect(x0 - 1, y0, 3, len, lc);
  else fb.fillRect(x0, y0 - 1, len, 3, lc);
  if (!on) return;
  int p = (int)((now % 1100) * (len + 12) / 1100) - 10;  // -10 .. len+2
  if (p < -2 || p > len - 6) return;                      // nur innerhalb der Linie zeichnen
  uint16_t ac = red ? C_ONRED : C_ARROW;
  if (!vertical) fb.fillTriangle(x0 + p, y0 - 6, x0 + p, y0 + 6, x0 + p + 10, y0, ac);
  else if (dir == 2) fb.fillTriangle(x0 - 6, y0 + p, x0 + 6, y0 + p, x0, y0 + p + 10, ac);
  else { int q = len - p; fb.fillTriangle(x0 - 6, y0 + q, x0 + 6, y0 + q, x0, y0 + q - 10, ac); }
}

static void energyPage(const DashState& s, bool online, bool red, uint16_t bg, uint32_t now) {
  char v[24], u[24];
  const bool ok = online && s.eOk;
  auto W = [&](int w) { if (ok && w != NA_I) snprintf(v, sizeof(v), "%d", w); else strcpy(v, "--"); };
  bool solarOn = ok && s.pvW != NA_I && s.pvW > 5;
  bool acOn = ok && s.acW != NA_I && s.acW > 5;
  bool dcOn = ok && s.dcW != NA_I && s.dcW > 5;
  bool shoreOn = ok && s.shoreOn;
  bool charging = ok && s.invW != NA_I && s.invW > 5;
  bool inverting = ok && s.invW != NA_I && s.invW < -5;

  const int X1 = 20, X2 = 290, X3 = 560, Y1 = 78, Y2 = 254;

  eBox(X1, Y1, "Shore", shoreOn, false, red, bg);
  if (shoreOn) {
    W(s.shoreW); eText(X1 + 14, Y1 + 88, v, "W", &fonts::DejaVu40, true, red, bg);
    if (s.shoreV != NA_I) { snprintf(u, sizeof(u), "%d V", s.shoreV); eSub(X1 + 14, Y1 + 116, u, true, red, bg); }
  } else {
    eText(X1 + 14, Y1 + 84, ok ? "Disconnected" : "--", nullptr, &fonts::DejaVu24, false, red, bg);
  }

  eBox(X2, Y1, "Inverter / Charger", false, true, red, bg);
  fb.setFont(&fonts::DejaVu40);
  const char* st = ok ? s.invSt : "--";
  eText(X2 + 14, Y1 + 88, st, nullptr, fb.textWidth(st) > 192 ? (const lgfx::IFont*)&fonts::DejaVu24 : &fonts::DejaVu40, false, red, bg);
  if (ok && s.invW != NA_I && s.invW != 0) { snprintf(u, sizeof(u), "%d W DC", abs(s.invW)); eSub(X2 + 14, Y1 + 116, u, false, red, bg); }

  eBox(X3, Y1, "AC Loads", acOn, false, red, bg);
  W(s.acW); eText(X3 + 14, Y1 + 88, v, "W", &fonts::DejaVu40, acOn, red, bg);

  eBox(X1, Y2, "Solar yield", solarOn, false, red, bg);
  W(s.pvW); eText(X1 + 14, Y2 + 88, v, "W", &fonts::DejaVu40, solarOn, red, bg);
  if (ok && !isnan(s.pvToday)) { snprintf(u, sizeof(u), "Today %.2f kWh", s.pvToday); eSub(X1 + 14, Y2 + 116, u, solarOn, red, bg); }

  eBox(X2, Y2, "Battery", false, true, red, bg);
  if (ok && s.batSoc != NA_I) snprintf(v, sizeof(v), "%d", s.batSoc); else strcpy(v, "--");
  eText(X2 + 14, Y2 + 80, v, "%", &fonts::DejaVu40, false, red, bg);
  if (ok) {
    char a[10], w[10];
    if (!isnan(s.batA)) snprintf(a, sizeof(a), "%.1f", s.batA); else strcpy(a, "--");
    if (s.batW != NA_I) snprintf(w, sizeof(w), "%d", s.batW); else strcpy(w, "--");
    snprintf(u, sizeof(u), "%.2fV %sA %sW", isnan(s.batV) ? 0.0f : s.batV, a, w);
    eSub(X2 + 14, Y2 + 102, u, false, red, bg);
    snprintf(u, sizeof(u), "%s  %s", s.batSt, s.batTtg);
    eSub(X2 + 14, Y2 + 124, u, false, red, bg);
  }

  eBox(X3, Y2, "DC Loads", dcOn, false, red, bg);
  W(s.dcW); eText(X3 + 14, Y2 + 88, v, "W", &fonts::DejaVu40, dcOn, red, bg);

  eConn(240, Y1 + 66, 50, false, shoreOn, 0, red, now);
  eConn(510, Y1 + 66, 50, false, acOn, 0, red, now);
  eConn(240, Y2 + 66, 50, false, solarOn, 0, red, now);
  eConn(510, Y2 + 66, 50, false, dcOn, 0, red, now);
  eConn(400, Y1 + 132, Y2 - Y1 - 132, true, charging || inverting, inverting ? 1 : 2, red, now);
}

// ── Settings-Seite: QR-Code zur Node-RED-Einstellungsseite ─────────────────
static void settingsPage(bool red, uint16_t bg) {
  String url = String(DASH_URL);
  if (url.endsWith("/api")) url = url.substring(0, url.length() - 4);
  url += "/settings";
  centerText("SETTINGS", 400, 96, &fonts::DejaVu24, red ? C_ONRED : C_WHITE, bg);
  centerText("Scan with your phone (boat WiFi)", 400, 128, &fonts::DejaVu18, red ? C_ONRED : C_GREY, bg);
  const int qs = 220, qx = 400 - qs / 2, qy = 146;
  fb.fillRect(qx - 10, qy - 10, qs + 20, qs + 20, lgfx::color565(255, 255, 255));  // Ruhezone
  fb.qrcode(url.c_str(), qx, qy, qs, 4);
  centerText(url.c_str(), 400, 392, &fonts::DejaVu18, red ? C_ONRED : C_DIM, bg);
}

// Verlauf als Hintergrund-Fläche (60 Punkte). Baro: Skala mind. 1 hPa um den Mittelwert.
// zero (Wind): Skala ab 0, mindestens bis 10 kn, damit Böen in echter Größe erscheinen.
static void histChart(const float* hist, int n, int x0, int cw, int top, int bot, bool zero, bool al, bool red, uint16_t bg) {
  if (n < 2) return;
  float mn = 1e9, mx = -1e9;
  for (int i = 0; i < n; i++) if (!isnan(hist[i])) { mn = min(mn, hist[i]); mx = max(mx, hist[i]); }
  if (mx < mn) return;
  if (zero) { mn = 0; mx = max(10.0f, mx * 1.1f); }
  else if (mx - mn < 1) { float c = (mx + mn) / 2; mn = c - 0.5f; mx = c + 0.5f; }
  uint16_t fillC = al ? C_CHFILL_AL : C_CHFILL;
  uint16_t lineC = red ? C_ONRED : (al ? C_CHLINE_AL : C_CHLINE);
  int px = -1, py = -1;
  for (int i = 0; i < n; i++) {
    if (isnan(hist[i])) continue;
    int qx = x0 + i * (cw - 1) / (n - 1);
    int qy = bot - (int)((hist[i] - mn) / (mx - mn) * (bot - top));
    if (px >= 0) {
      if (!red)
        for (int xx = px; xx <= qx; xx++) {  // Fläche unter der Linie
          int yy = py + (qy - py) * (xx - px) / max(1, qx - px);
          fb.drawFastVLine(xx, yy, bot - yy, fillC);
        }
      fb.drawWideLine(px, py, qx, qy, 1, lineC);
    }
    px = qx; py = qy;
  }
}

// ── Screen 3: Wetter ────────────────────────────────────────────────────────
// Icons aus Grundformen auf 64er-Raster (wie die SVGs im Simulator), k = Pixel pro Einheit
static void wxCloud(int ox, int oy, float k, uint16_t c) {
  fb.fillCircle(ox + 25 * k, oy + 36 * k, 11 * k, c);
  fb.fillCircle(ox + 38 * k, oy + 30 * k, 14 * k, c);
  fb.fillRoundRect(ox + 14 * k, oy + 36 * k, 40 * k, 13 * k, 6.5f * k, c);
}
static void wxSun(int cx, int cy, float r, float k, uint16_t c) {
  fb.fillCircle(cx, cy, r, c);
  for (int i = 0; i < 8; i++) {
    float a = i * PI / 4;
    fb.drawWideLine(cx + cosf(a) * r * 1.45f, cy + sinf(a) * r * 1.45f, cx + cosf(a) * r * 1.95f, cy + sinf(a) * r * 1.95f,
                    max(1.0f, 1.7f * k), c);
  }
}
static void wxCrescent(int ox, int oy, float k, uint16_t c, uint16_t bg) {
  fb.fillCircle(ox + 30 * k, oy + 34 * k, 19 * k, c);
  fb.fillCircle(ox + 41 * k, oy + 27 * k, 16 * k, bg);
}
static void wxIcon(const char* ic, bool night, int cx, int cy, int size, bool red, uint16_t bg) {
  float k = size / 64.0f;
  int ox = cx - size / 2, oy = cy - size / 2;
  uint16_t sun = red ? C_ONRED : C_WSUN, cl = red ? C_ONRED : C_WCLOUD, cl2 = red ? C_ONRED : C_WCLOUD2;
  uint16_t rain = red ? C_ONRED : C_WRAIN, moon = red ? C_ONRED : C_WMOON;
  if (!strcmp(ic, "sun")) {
    if (night) wxCrescent(ox, oy, k, moon, bg); else wxSun(cx, cy, 12 * k, k, sun);
  } else if (!strcmp(ic, "partly")) {
    if (night) wxCrescent(ox - 8 * k, oy - 10 * k, k * 0.8f, moon, bg); else wxSun(ox + 22 * k, oy + 22 * k, 8 * k, k, sun);
    wxCloud(ox + 6 * k, oy + 6 * k, k * 0.9f, cl);
  } else if (!strcmp(ic, "cloud")) {
    fb.fillCircle(ox + (38 * 0.75f - 6) * k, oy + (30 * 0.75f - 4) * k, 14 * 0.75f * k, cl2);
    fb.fillCircle(ox + (25 * 0.75f - 6) * k, oy + (36 * 0.75f - 4) * k, 11 * 0.75f * k, cl2);
    wxCloud(ox + 4 * k, oy + 4 * k, k, cl);
  } else if (!strcmp(ic, "rain") || !strcmp(ic, "storm") || !strcmp(ic, "snow")) {
    wxCloud(ox, oy - 8 * k, k, cl);
    if (!strcmp(ic, "rain")) {
      for (int i = 0; i < 3; i++)
        fb.drawWideLine(ox + (24 + 10 * i) * k, oy + 48 * k, ox + (20 + 10 * i) * k, oy + 58 * k, max(1.0f, 1.7f * k), rain);
    } else if (!strcmp(ic, "storm")) {
      fb.fillTriangle(ox + 34 * k, oy + 42 * k, ox + 24 * k, oy + 54 * k, ox + 32 * k, oy + 54 * k, sun);
      fb.fillTriangle(ox + 32 * k, oy + 49 * k, ox + 28 * k, oy + 63 * k, ox + 42 * k, oy + 49 * k, sun);
      fb.fillTriangle(ox + 34 * k, oy + 42 * k, ox + 38 * k, oy + 42 * k, ox + 32 * k, oy + 54 * k, sun);
    } else {
      fb.fillCircle(ox + 22 * k, oy + 52 * k, 3 * k, rain);
      fb.fillCircle(ox + 33 * k, oy + 57 * k, 3 * k, rain);
      fb.fillCircle(ox + 44 * k, oy + 52 * k, 3 * k, rain);
    }
  } else if (!strcmp(ic, "fog")) {
    fb.drawWideLine(ox + 12 * k, oy + 24 * k, ox + 52 * k, oy + 24 * k, 2 * k, cl);
    fb.drawWideLine(ox + 8 * k, oy + 34 * k, ox + 48 * k, oy + 34 * k, 2 * k, cl);
    fb.drawWideLine(ox + 16 * k, oy + 44 * k, ox + 56 * k, oy + 44 * k, 2 * k, cl);
  } else {
    wxCloud(ox, oy, k, cl);
  }
}
// Mondphase (met.no: 0 Neumond, 90 erstes Viertel, 180 Vollmond, 270 letztes Viertel)
static void moonPhase(int cx, int cy, int R, int phase, bool red) {
  fb.fillCircle(cx, cy, R, red ? C_RED_BG : C_WMDARK);
  if (red) fb.drawCircle(cx, cy, R, C_ONRED);
  if (phase == NA_I) return;
  float c = cosf(phase * PI / 180);
  bool wax = phase < 180;
  for (int y = -R; y <= R; y++) {
    float w = sqrtf((float)(R * R - y * y)), t = w * c;
    int x0 = wax ? cx + t : cx - w, x1 = wax ? cx + w : cx - t;
    if (x1 > x0) fb.drawFastHLine(x0, cy + y, x1 - x0 + 1, red ? C_ONRED : C_WMOON);
  }
}
// Zahl + Grad-Kringel (DejaVu-Fonts haben kein °); gibt x-Ende zurück
static int drawDeg(int x, int baseY, int t, const lgfx::IFont* font, int cap, uint16_t col, uint16_t bg) {
  char b[8];
  if (t == NA_I) strcpy(b, "--"); else snprintf(b, sizeof(b), "%d", t);
  fb.setFont(font);
  fb.setTextDatum(textdatum_t::baseline_left);
  fb.setTextColor(col, bg);
  fb.drawString(b, x, baseY);
  int w = fb.textWidth(b), rr = max(2, cap / 7);
  fb.drawCircle(x + w + rr + 2, baseY - cap + rr, rr, col);
  if (rr > 3) fb.drawCircle(x + w + rr + 2, baseY - cap + rr, rr - 1, col);
  return x + w + 2 * rr + 4;
}
// "↑ 07:01  ↓ 18:38" mit gezeichneten Pfeilen
static void riseSet(int x, int midY, const char* up, const char* dn, const lgfx::IFont* font, uint16_t col, uint16_t bg) {
  fb.setFont(font);
  fb.setTextDatum(textdatum_t::middle_left);
  fb.setTextColor(col, bg);
  fb.fillTriangle(x, midY + 3, x + 10, midY + 3, x + 5, midY - 6, col);
  fb.drawString(up, x + 14, midY);
  int x2 = x + 14 + fb.textWidth(up) + 12;
  fb.fillTriangle(x2, midY - 5, x2 + 10, midY - 5, x2 + 5, midY + 4, col);
  fb.drawString(dn, x2 + 14, midY);
}

// Kleine Zeilen-Icons: Wind (drei Linien mit Kringel) und Regentropfen
static void iconWind(int cx, int cy, int sz, uint16_t c) {
  int h = sz / 2;
  fb.drawWideLine(cx - h, cy - h / 2, cx + h / 4, cy - h / 2, 1, c);
  fb.drawCircle(cx + h / 4, cy - h / 2 - h / 4, h / 4, c);
  fb.drawWideLine(cx - h, cy, cx + h / 2, cy, 1, c);
  fb.drawCircle(cx + h / 2, cy + h / 4, h / 4, c);
  fb.drawWideLine(cx - h, cy + h / 2, cx - h / 4, cy + h / 2, 1, c);
}
static void iconDrop(int cx, int cy, int sz, uint16_t c) {
  int r = sz / 3;
  fb.fillCircle(cx, cy + r / 2, r, c);
  fb.fillTriangle(cx - r, cy + r / 3, cx + r, cy + r / 3, cx, cy - sz / 2, c);
}
// Wert groß + Zusatz klein grau, z. B. "3 kn S" + "gust 9 - max 8"
static void valueSmall(int x, int midY, const char* big, const char* small, uint16_t fg, uint16_t grey, uint16_t bg) {
  fb.setTextDatum(textdatum_t::middle_left);
  fb.setFont(&fonts::DejaVu24);
  fb.setTextColor(fg, bg);
  fb.drawString(big, x, midY);
  if (small && *small) {
    int w = fb.textWidth(big);
    fb.setFont(&fonts::DejaVu18);
    fb.setTextColor(grey, bg);
    fb.drawString(small, x + w + 10, midY + 2);
  }
}

static void weatherPage(const DashState& s, bool online, bool red, uint16_t bg) {
  char b[48], b2[48];
  const uint16_t brd = red ? C_ONRED : C_BORDER, fg = red ? C_ONRED : C_WHITE;
  const uint16_t grey = red ? C_ONRED : C_GREY, dim = red ? C_ONRED : C_DIM;
  const uint16_t windC = red ? C_ONRED : C_ESUB, dropC = red ? C_ONRED : C_WRAIN;
  for (int i = 0; i < 2; i++) fb.drawRoundRect(12 + i, 72 + i, 776 - 2 * i, 190 - 2 * i, 14 - i, brd);
  if (!online || !s.wOk) {
    centerText(online ? "No weather data" : "--", 400, 166, &fonts::DejaVu24, grey, bg);
  } else {
    const WxDay& t = s.today;
    // Links: großes Icon, darunter Aktualisierungszeit
    wxIcon(s.cIc, s.cNight, 100, 160, 132, red, bg);
    snprintf(b, sizeof(b), "updated %s", s.wUpd);
    centerText(b, 100, 244, &fonts::DejaVu12, red ? C_ONRED : (s.wOld ? C_AMBER : C_DIM), bg);
    // Mitte: Tag, Temperatur, Min/Max, Zustand
    char dow[4]; strlcpy(dow, t.dow, sizeof(dow));
    for (char* q = dow; *q; q++) *q = toupper(*q);
    snprintf(b, sizeof(b), "TODAY - %s %s", dow, t.date);
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(grey, bg);
    fb.drawString(b, 192, 100);
    drawDeg(190, 176, s.cT, &fonts::DejaVu72, 52, fg, bg);
    fb.fillTriangle(192, 214, 202, 214, 197, 205, grey);
    int xe = drawDeg(208, 216, t.max, &fonts::DejaVu18, 13, grey, bg);
    fb.fillTriangle(xe + 10, 206, xe + 20, 206, xe + 15, 215, grey);
    drawDeg(xe + 26, 216, t.min, &fonts::DejaVu18, 13, grey, bg);
    fb.setFont(&fonts::DejaVu24); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(fg, bg);
    fb.drawString(s.cTxt, 192, 238);
    // Trennlinie + rechte Spalte mit Icon-Zeilen
    fb.drawFastVLine(482, 92, 150, brd);
    const int ix = 520, tx = 548;
    iconWind(ix, 109, 26, windC);
    snprintf(b, sizeof(b), "%d kn %s", s.cWs, s.cWd);
    snprintf(b2, sizeof(b2), "gust %d - max %d", s.cWg, t.ws);
    valueSmall(tx, 109, b, b2, fg, grey, bg);
    iconDrop(ix, 147, 24, dropC);
    snprintf(b, sizeof(b), "%d %%", t.pp);
    if (!isnan(t.ps)) snprintf(b2, sizeof(b2), "%.1f mm", t.ps); else b2[0] = 0;
    valueSmall(tx, 147, b, b2, fg, grey, bg);
    wxSun(ix, 185, 6, 0.5f, red ? C_ONRED : C_WSUN);
    riseSet(tx, 185, t.sr, t.ss, &fonts::DejaVu24, fg, bg);
    moonPhase(ix, 223, 12, s.mp, red);
    riseSet(tx, 223, t.mr, t.ms, &fonts::DejaVu24, fg, bg);
  }
  // Nächste 3 Tage: Temperatur, Wind, Regen
  for (int i = 0; i < 3; i++) {
    const int x = 12 + i * 264, y = 274;
    for (int j = 0; j < 2; j++) fb.drawRoundRect(x + j, y + j, 248 - 2 * j, 118 - 2 * j, 14 - j, brd);
    if (!online || !s.wOk || i >= s.nDays) continue;
    const WxDay& d = s.days[i];
    char dow[4]; strlcpy(dow, d.dow, sizeof(dow));
    for (char* q = dow; *q; q++) *q = toupper(*q);
    snprintf(b, sizeof(b), "%s %s", dow, d.date);
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(grey, bg);
    fb.drawString(b, x + 18, y + 22);
    wxIcon(d.ic, false, x + 40, y + 70, 56, red, bg);
    int xe = drawDeg(x + 80, y + 58, d.max, &fonts::DejaVu24, 17, fg, bg);
    drawDeg(xe + 6, y + 58, d.min, &fonts::DejaVu18, 13, grey, bg);
    iconWind(x + 89, y + 78, 16, windC);
    snprintf(b, sizeof(b), "%d kn %s", d.ws, d.wd);
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(fg, bg);
    fb.drawString(b, x + 102, y + 78);
    snprintf(b2, sizeof(b2), "G%d", d.wg);
    fb.setTextColor(dim, bg);
    fb.drawString(b2, x + 102 + fb.textWidth(b) + 8, y + 78);
    iconDrop(x + 89, y + 100, 15, dropC);
    if (d.pp != NA_I) snprintf(b, sizeof(b), "%d %%", d.pp); else strcpy(b, "--");
    fb.setTextColor(fg, bg);
    fb.drawString(b, x + 102, y + 100);
  }
}

// ── Screen 4: Motor ─────────────────────────────────────────────────────────
// Drehzahlmesser: 240°-Bogen (150° … 390°, 0° = 3 Uhr, im Uhrzeigersinn), 0 … mMax
static void thickArc(int cx, int cy, int r, float a0, float a1, int w, uint16_t c) {
  if (a1 <= a0) return;
  float step = 2;
  float pa = a0 * PI / 180;
  for (float a = a0 + step; ; a += step) {
    if (a > a1) a = a1;
    float t = a * PI / 180;
    fb.drawWideLine(cx + cosf(pa) * r, cy + sinf(pa) * r, cx + cosf(t) * r, cy + sinf(t) * r, w / 2.0f, c);
    pa = t;
    if (a >= a1) break;
  }
}
// 4-Bit-Alpha-Bitmap mit Kantenglättung auf einfarbigen Hintergrund zeichnen
static void drawAlpha4(const uint8_t* bmp, int w, int h, int x0, int y0, uint16_t fg, uint16_t bg) {
  auto ch = [](uint16_t c, int sh, int mask) { return (c >> sh) & mask; };
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      int i = y * w + x;
      uint8_t a = (pgm_read_byte(&bmp[i >> 1]) >> ((i & 1) ? 0 : 4)) & 0x0F;
      if (!a) continue;
      uint16_t c = fg;
      if (a < 15) {
        int r = (ch(fg, 11, 31) * a + ch(bg, 11, 31) * (15 - a)) / 15;
        int g = (ch(fg, 5, 63) * a + ch(bg, 5, 63) * (15 - a)) / 15;
        int b = (ch(fg, 0, 31) * a + ch(bg, 0, 31) * (15 - a)) / 15;
        c = (r << 11) | (g << 5) | b;
      }
      fb.drawPixel(x0 + x, y0 + y, c);
    }
}

static void tacho(const DashState& s, bool online, bool red, uint16_t bg) {
  // Sportlicher Rundinstrument-Look: dunkles Zifferblatt, Außenband mit grünem (Reise-) und
  // rotem Bereich, breiter Fortschrittsbogen innen, spitzer roter Zeiger, Digitalanzeige im Feld
  const int cx = 200, cy = 232, R = 140;
  const int maxR = s.mMax > 0 ? s.mMax : 3000;
  auto ang = [&](float v) { return 150.0f + 240.0f * constrain(v / maxR, 0.0f, 1.0f); };
  auto P = [&](float r, float a, int& x, int& y) { float t = a * PI / 180; x = cx + cosf(t) * r; y = cy + sinf(t) * r; };
  uint16_t on1 = red ? C_ONRED : 0;
  if (!red) fb.fillCircle(cx, cy, R + 4, C_TFACE);
  fb.drawCircle(cx, cy, R + 4, red ? C_ONRED : C_TBEZEL);
  fb.drawCircle(cx, cy, R + 3, red ? C_ONRED : C_TBEZEL);
  uint16_t face = red ? bg : C_TFACE;
  if (s.mG1 > s.mG0) thickArc(cx, cy, R - 4, ang(s.mG0), ang(s.mG1), 8, red ? on1 : C_TZG);
  thickArc(cx, cy, R - 4, ang(s.mRed), 390, 8, red ? on1 : C_RED);
  if (!red) thickArc(cx, cy, R - 20, 150, 390, 14, C_TTRACK);
  bool on = online && s.mOn && s.mRpm != NA_I;
  if (on && s.mRpm > 0) thickArc(cx, cy, R - 20, 150, ang(s.mRpm), 14, red ? on1 : (s.mRpm >= s.mRed ? C_TNDL : C_TVAL));
  char b[12];
  for (int v = 0; v <= maxR; v += 100) {
    bool mj = v % 500 == 0;
    int x0, y0, x1, y1;
    P(R - (mj ? 46 : 34), ang(v), x0, y0);
    P(R - 30, ang(v), x1, y1);
    fb.drawWideLine(x0, y0, x1, y1, mj ? 2.0f : 0.7f, red ? C_ONRED : (mj ? C_WHITE : C_DIM));
    if (mj) {
      int nx, ny; P(R - 60, ang(v), nx, ny);
      snprintf(b, sizeof(b), "%d", v / 100);
      centerText(b, nx, ny, &fonts::DejaVu18, red ? C_ONRED : C_WHITE, face);
    }
  }
  centerText("RPM x 100", cx, cy + 30, &fonts::DejaVu12, red ? C_ONRED : C_DIM, face);
  drawAlpha4(LOGO_VP, LOGO_VP_W, LOGO_VP_H, cx - LOGO_VP_W / 2, cy + 58, red ? C_ONRED : C_GREY, face);
  // Zeiger
  float na = ang(on ? s.mRpm : 0);
  int tx, ty, lx, ly, rx, ry, bx, by;
  P(R - 26, na, tx, ty); P(7, na - 90, lx, ly); P(7, na + 90, rx, ry); P(22, na + 180, bx, by);
  uint16_t ndl = red ? C_ONRED : C_TNDL;
  fb.fillTriangle(tx, ty, lx, ly, rx, ry, ndl);
  fb.fillTriangle(bx, by, lx, ly, rx, ry, ndl);
  fb.fillCircle(cx, cy, 10, red ? bg : C_TPILL);
  fb.drawCircle(cx, cy, 10, ndl); fb.drawCircle(cx, cy, 9, ndl);
  // Digitalanzeige
  const int px = cx - 74, py = 72 + 248;
  if (!red) fb.fillRoundRect(px, py, 148, 56, 12, C_TPILL);
  fb.drawRoundRect(px, py, 148, 56, 12, red ? C_ONRED : C_BORDER);
  if (on) snprintf(b, sizeof(b), "%d", s.mRpm); else strcpy(b, "--");
  fb.setFont(&fonts::DejaVu40); fb.setTextDatum(textdatum_t::baseline_center);
  fb.setTextColor(red ? C_ONRED : C_WHITE, red ? bg : C_TPILL);
  fb.drawString(b, cx, py + 40);
  centerText(on ? "RPM" : "ENGINE OFF", cx, py + 50, &fonts::DejaVu12, red ? C_ONRED : C_GREY, red ? bg : C_TPILL);
}
static void engTile(int x, int y, int w, const char* label, bool red, uint16_t bg) {
  for (int i = 0; i < 2; i++) fb.drawRoundRect(x + i, y + i, w - 2 * i, 100 - 2 * i, 14 - i, red ? C_ONRED : C_BORDER);
  fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(red ? C_ONRED : C_GREY, bg);
  fb.drawString(label, x + 16, y + 20);
}
static void engValue(int x, int y, const char* v, const char* unit, const char* sub, bool red, uint16_t bg) {
  fb.setFont(&fonts::DejaVu40); fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(red ? C_ONRED : C_WHITE, bg);
  fb.drawString(v, x, y + 66);
  if (unit && *unit) {
    int w = fb.textWidth(v);
    fb.setFont(&fonts::DejaVu18); fb.setTextColor(red ? C_ONRED : C_GREY, bg);
    fb.drawString(unit, x + w + 6, y + 66);
  }
  if (sub && *sub) {
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(red ? C_ONRED : C_DIM, bg);
    fb.drawString(sub, x, y + 86);
  }
}
static void enginePage(const DashState& s, bool online, bool red, uint16_t bg) {
  for (int i = 0; i < 2; i++) fb.drawRoundRect(12 + i, 72 + i, 376 - 2 * i, 320 - 2 * i, 14 - i, red ? C_ONRED : C_BORDER);
  tacho(s, online, red, bg);
  char v[16], sub[48];
  engTile(400, 72, 189, "TEMP", red, bg);
  if (online && s.mTemp != NA_I) snprintf(v, sizeof(v), "%d", s.mTemp); else strcpy(v, "--");
  engValue(416, 72, "", "", online && s.mTemp != NA_I ? (s.mTempLive ? "coolant" : "last known") : "", red, bg);
  {
    int xe = drawDeg(416, 72 + 66, online ? s.mTemp : NA_I, &fonts::DejaVu40, 29, red ? C_ONRED : C_WHITE, bg);
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(red ? C_ONRED : C_GREY, bg);
    fb.drawString("C", xe, 72 + 66);
  }
  engTile(599, 72, 189, "HOURS", red, bg);
  if (online && !isnan(s.mHrs)) snprintf(v, sizeof(v), "%.1f", s.mHrs); else strcpy(v, "--");
  engValue(615, 72, v, "h", "engine hours", red, bg);
  engTile(400, 182, 189, "FUEL RATE", red, bg);
  if (online && !isnan(s.mLph)) snprintf(v, sizeof(v), "%.1f", s.mLph); else strcpy(v, "--");
  engValue(416, 182, v, "l/h", !isnan(s.mLph) ? (s.mEst ? "estimated from rpm" : "sensor") : (s.mOn ? "" : "engine off"), red, bg);
  engTile(599, 182, 189, "DIESEL", red, bg);
  if (online && s.mFuelPct != NA_I) snprintf(v, sizeof(v), "%d", s.mFuelPct); else strcpy(v, "--");
  engValue(615, 182 - 4, v, "%", "", red, bg);
  if (online && s.mFuelL != NA_I) {
    snprintf(sub, sizeof(sub), "%d l", s.mFuelL);
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::baseline_right); fb.setTextColor(red ? C_ONRED : C_GREY, bg);
    fb.drawString(sub, 772, 182 + 62);
  }
  fb.fillRoundRect(615, 182 + 76, 157, 8, 4, red ? C_ONRED : C_BORDER);
  if (online && s.mFuelPct != NA_I && s.mFuelPct > 0)
    fb.fillRoundRect(615, 182 + 76, 157 * constrain(s.mFuelPct, 0, 100) / 100, 8, 4, red ? C_RED_BG : C_FUELBAR);
  engTile(400, 292, 388, "RANGE AT CURRENT RPM", red, bg);
  bool rOk = online && !isnan(s.mRangeH);
  if (rOk) snprintf(v, sizeof(v), "%.1f", s.mRangeH); else strcpy(v, "--");
  if (!rOk) strcpy(sub, "engine off");
  else if (s.mRangeNm != NA_I) snprintf(sub, sizeof(sub), "at %.1f l/h and %.1f kn SOG", s.mLph, s.mSog);
  else snprintf(sub, sizeof(sub), "at %.1f l/h (no SOG)", s.mLph);
  engValue(416, 292, v, "h", sub, red, bg);
  if (rOk && s.mRangeNm != NA_I) { snprintf(v, sizeof(v), "%d", s.mRangeNm); engValue(600, 292, v, "nm", "", red, bg); }
}

// ── Screen 5: Anker (Radar-Ansicht, Nord oben, Mitte = Anker) ─────────────
static const char* card8(int d) {
  static const char* C[] = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"};
  return C[((int)lroundf(((d % 360) + 360) % 360 / 45.0f)) % 8];
}
static void dashedCircle(int cx, int cy, int r, uint16_t c, int on, int off) {
  float circ = 2 * PI * r; int n = max(8, (int)(circ / (on + off)));
  for (int i = 0; i < n; i++) {
    float a0 = i * 2 * PI / n, a1 = a0 + 2 * PI / n * on / (on + off);
    fb.drawLine(cx + cosf(a0) * r, cy + sinf(a0) * r, cx + cosf(a1) * r, cy + sinf(a1) * r, c);
  }
}
static void dashedLine(int x0, int y0, int x1, int y1, uint16_t c) {
  float d = hypotf(x1 - x0, y1 - y0); int n = max(1, (int)(d / 8));
  for (int i = 0; i < n; i++) {
    float t0 = (float)i / n, t1 = t0 + 0.5f / n;
    fb.drawLine(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0, x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1, c);
  }
}
static void anchorGlyph(int x, int y, uint16_t c) {
  fb.drawCircle(x, y - 8, 3, c);
  fb.drawWideLine(x, y - 5, x, y + 11, 1, c);
  fb.drawWideLine(x - 6, y - 1, x + 6, y - 1, 1, c);
  fb.drawArc(x, y + 4, 10, 9, 20, 160, c);
}
static void btn(int x, int y, int w, int h, const char* lbl, uint16_t brd, uint16_t txt, uint16_t fill, bool red, uint16_t bg) {
  if (!red) fb.fillRoundRect(x, y, w, h, 9, fill);
  fb.drawRoundRect(x, y, w, h, 9, red ? C_ONRED : brd);
  fb.drawRoundRect(x + 1, y + 1, w - 2, h - 2, 8, red ? C_ONRED : brd);
  centerText(lbl, x + w / 2, y + h / 2, &fonts::DejaVu18, red ? C_ONRED : txt, red ? bg : fill);
}
// Aktionsknöpfe je nach Zustand (gleich in Zeichnen und Touch)
static int anchorButtons(const DashState& s, ABtn* out) {
  int n = 0;
  if (s.ancAct) {
    out[n++] = {"up", "ANCHOR UP", 2, true};
    if (s.aAlarming) out[n++] = {"mute", s.aMuted ? "MUTED" : "MUTE", 0, false};
  } else {
    out[n++] = {"drop_now", "DROP NOW", 1, true};
    out[n++] = {"set", "SET", 1, true};
    if (s.aHasLast) out[n++] = {"restore", "RESTORE", 0, true};
  }
  return n;
}
static void anchorLocalSync(const DashState& s) {
  if (!aLocalInit && s.valid) {
    aRad = s.ancRad > 0 ? s.ancRad : 50;
    aChain = s.aChainDb != NA_I ? s.aChainDb : 0;
    aBrg = s.ancAct && s.aBrgDb != NA_I ? s.aBrgDb : (s.aHdg != NA_I ? s.aHdg : (s.aBrgDb != NA_I ? s.aBrgDb : 0));
    aBrgManual = false; aLocalInit = true;
  }
  if (!s.ancAct && !aBrgManual && s.aHdg != NA_I) aBrg = s.aHdg;  // Peilung folgt dem Kurs bis manuell geändert
}

static void anchorPage(const DashState& s, bool online, bool red, uint16_t bg) {
  anchorLocalSync(s);
  const bool act = online && s.ancAct, al = online && s.aAlarming;
  char b[48];
  // ── Radar
  const int MX = 12, MY = 72, MW = 476, MH = 320, cx = MX + 238, cy = MY + 164;
  for (int i = 0; i < 2; i++) fb.drawRoundRect(MX + i, MY + i, MW - 2 * i, MH - 2 * i, 14 - i, red ? C_ONRED : C_BORDER);
  fb.setClipRect(MX + 2, MY + 2, MW - 4, MH - 4);
  int rad = act ? max(10, s.ancRad) : max(10, aRad);
  float ppm = 118.0f / rad * aZoom;
  static const int steps[] = {5, 10, 20, 25, 50, 100, 200, 500};
  int ringM = 1000;
  for (int v : steps) if (v * ppm >= 45) { ringM = v; break; }
  uint16_t ringC = red ? C_ONRED : C_BORDER;
  for (int k = 1; k * ringM * ppm < MW; k++) {
    int rr = k * ringM * ppm;
    dashedCircle(cx, cy, rr, ringC, 3, 5);
    if (cy - rr > MY + 14) {
      snprintf(b, sizeof(b), "%d m", k * ringM);
      fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::bottom_left); fb.setTextColor(red ? C_ONRED : C_DIM);
      fb.drawString(b, cx + 4, cy - rr - 2);
    }
  }
  uint16_t col = red ? C_ONRED : (al ? C_RED : act ? C_GREEN : C_AMBER);
  int rpx = rad * ppm;
  dashedCircle(cx, cy, rpx, col, act ? 1000 : 8, act ? 0 : 6);
  if (act) { fb.drawCircle(cx, cy, rpx, col); fb.drawCircle(cx, cy, rpx - 1, col); }
  // Track
  if (act && s.aTrackN > 1) {
    uint16_t tc = red ? C_ONRED : C_TVAL;
    for (int i = 1; i < s.aTrackN; i++)
      fb.drawLine(cx + s.aTrack[i - 1][0] * ppm, cy - s.aTrack[i - 1][1] * ppm, cx + s.aTrack[i][0] * ppm, cy - s.aTrack[i][1] * ppm, tc);
  }
  // Boot: aktiv = echte Position relativ zum Anker, sonst Vorschau (Anker = Boot + Peilung × Kette)
  bool haveBoat = online && (act ? s.aHasBoff : !isnan(s.aBlat));
  if (haveBoat) {
    float be, bn;
    if (act) { be = s.aBoffE; bn = s.aBoffN; }
    else { float t = aBrg * PI / 180; be = -sinf(t) * aChain; bn = -cosf(t) * aChain; }
    int bx = cx + be * ppm, by = cy - bn * ppm;
    dashedLine(cx, cy, bx, by, red ? C_ONRED : C_GREY);
    bx = constrain(bx, MX + 12, MX + MW - 12); by = constrain(by, MY + 12, MY + MH - 12);
    float h = (s.aHdg != NA_I ? s.aHdg : 0) * PI / 180;
    auto R = [&](float x, float y, int& ox, int& oy) { ox = bx + x * cosf(h) - y * sinf(h); oy = by + x * sinf(h) + y * cosf(h); };
    int x0, y0, x1, y1, x2, y2, x3, y3;
    R(0, -14, x0, y0); R(8, 10, x1, y1); R(0, 5, x2, y2); R(-8, 10, x3, y3);
    uint16_t bc = red ? C_ONRED : C_TVAL;
    fb.fillTriangle(x0, y0, x1, y1, x2, y2, bc);
    fb.fillTriangle(x0, y0, x2, y2, x3, y3, bc);
  }
  anchorGlyph(cx, cy, col);
  // Nordpfeil
  fb.fillTriangle(MX + 26, MY + 16, MX + 32, MY + 34, MX + 20, MY + 34, red ? C_ONRED : C_GREY);
  centerText("N", MX + 26, MY + 44, &fonts::DejaVu12, red ? C_ONRED : C_GREY, bg);
  // Zoom-Knöpfe
  const char* zl[] = {"+", "-", ""};
  for (int i = 0; i < 3; i++) {
    int zx = MX + 456, zy = MY + 28 + i * 48;
    fb.fillCircle(zx, zy, 20, red ? bg : C_BLACK);
    fb.drawCircle(zx, zy, 20, red ? C_ONRED : C_DIM); fb.drawCircle(zx, zy, 19, red ? C_ONRED : C_DIM);
    if (i < 2) centerText(zl[i], zx, zy, &fonts::DejaVu24, red ? C_ONRED : C_WHITE, red ? bg : C_BLACK);
    else { uint16_t c = red ? C_ONRED : C_WHITE;
      fb.drawFastHLine(zx - 8, zy - 8, 5, c); fb.drawFastVLine(zx - 8, zy - 8, 5, c); fb.drawFastHLine(zx + 4, zy - 8, 5, c); fb.drawFastVLine(zx + 8, zy - 8, 5, c);
      fb.drawFastHLine(zx - 8, zy + 8, 5, c); fb.drawFastVLine(zx - 8, zy + 4, 5, c); fb.drawFastHLine(zx + 4, zy + 8, 5, c); fb.drawFastVLine(zx + 8, zy + 4, 5, c); }
  }
  if (act) snprintf(b, sizeof(b), "Anchor %.5f, %.5f - radius %d m", s.aLat, s.aLon, rad);
  else snprintf(b, sizeof(b), "Preview - radius %d m - chain %d m", aRad, aChain);
  fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::bottom_left); fb.setTextColor(red ? C_ONRED : C_GREY);
  fb.drawString(b, MX + 12, MY + MH - 8);
  fb.clearClipRect();

  // ── Panel rechts
  const int PX = 500;
  uint16_t brd = red ? C_ONRED : (al ? C_RED : C_BORDER);
  for (int i = 0; i < (al ? 4 : 2); i++) fb.drawRoundRect(PX + i, 72 + i, 288 - 2 * i, 46 - 2 * i, 12 - i, brd);
  fb.setFont(&fonts::DejaVu24); fb.setTextDatum(textdatum_t::middle_left);
  fb.setTextColor(red ? C_ONRED : (al ? C_RED : act ? C_GREEN : C_WHITE), bg);
  fb.drawString(!online ? "--" : al ? "ALARM" : act ? "ACTIVE" : "OFF", PX + 14, 95);
  if (act && s.ancDist >= 0) snprintf(b, sizeof(b), "%d / %d m", s.ancDist, s.ancRad); else strcpy(b, online ? (act ? "" : "anchor up") : "");
  fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::middle_right); fb.setTextColor(red ? C_ONRED : C_GREY, bg);
  fb.drawString(b, PX + 274, 96);
  if (aMsg[0] && millis() < aMsgUntil) {
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::bottom_right); fb.setTextColor(red ? C_ONRED : C_AMBER, bg);
    fb.drawString(aMsg, PX + 288, 70);
  }
  // Werte-Kacheln
  char v1[16], v2[16], v3[16], v4[16];
  if (act && s.ancDist >= 0) snprintf(v1, sizeof(v1), "%d m", s.ancDist); else strcpy(v1, "--");
  if (online && !isnan(s.aDepth)) snprintf(v2, sizeof(v2), "%.1f m", s.aDepth); else strcpy(v2, "--");
  if (act && !isnan(s.aScope)) snprintf(v3, sizeof(v3), "%.1f:1", s.aScope); else strcpy(v3, "--");
  if (act && s.aBtoa != NA_I) snprintf(v4, sizeof(v4), "%s %d", card8(s.aBtoa), s.aBtoa); else strcpy(v4, "--");
  const char* lb[] = {"DIST", "DEPTH", "SCOPE", "BRG"};
  const char* vv[] = {v1, v2, v3, v4};
  for (int i = 0; i < 4; i++) {
    int x = PX + (i % 2) * 147, y = 124 + (i / 2) * 35;
    fb.drawRoundRect(x, y, 141, 30, 7, red ? C_ONRED : C_BORDER);
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(red ? C_ONRED : C_DIM, bg);
    fb.drawString(lb[i], x + 8, y + 15);
    uint16_t vc = red ? C_ONRED : C_WHITE;
    if (i == 2 && act && !isnan(s.aScope) && !red) vc = s.aScope >= 5 ? C_GREEN : s.aScope >= 3 ? C_AMBER : C_RED;
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::middle_right); fb.setTextColor(vc, bg);
    fb.drawString(vv[i], x + 133, y + 15);
  }
  // Einstellungen mit −/+
  const char* rl[] = {"RADIUS", "CHAIN", "BEARING"};
  for (int i = 0; i < 3; i++) {
    int y = 198 + i * 40;
    if (i == 0) snprintf(b, sizeof(b), "%d m", act ? s.ancRad : aRad);
    else if (i == 1) snprintf(b, sizeof(b), "%d m", aChain);
    else snprintf(b, sizeof(b), "%d %s", aBrg, card8(aBrg));
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(red ? C_ONRED : C_GREY, bg);
    fb.drawString(rl[i], PX, y + 17);
    fb.setFont(&fonts::DejaVu24); fb.setTextColor(red ? C_ONRED : C_WHITE, bg);
    fb.drawString(b, PX + 70, y + 17);
    bool dis = !online || aReqBusy || (al && i > 0);
    uint16_t bc = dis ? C_BORDER : C_GREY;
    btn(PX + 190, y, 46, 34, "-", bc, dis ? C_DIM : C_WHITE, C_BLACK, red, bg);
    btn(PX + 242, y, 46, 34, "+", bc, dis ? C_DIM : C_WHITE, C_BLACK, red, bg);
  }
  // Aktionsknöpfe
  ABtn bt[3]; int n = online ? anchorButtons(s, bt) : 0;
  int bw = n ? (288 - (n - 1) * 8) / n : 0;
  for (int i = 0; i < n; i++) {
    bool conf = !strcmp(aConfirm, bt[i].act) && millis() < aConfirmUntil;
    uint16_t bcol = bt[i].kind == 1 ? C_GREEN : bt[i].kind == 2 ? C_RED : C_GREY;
    const char* lbl = aReqBusy ? "..." : conf ? "CONFIRM?" : bt[i].lbl;
    btn(PX + i * (bw + 8), 324, bw, 56, lbl, conf ? C_AMBER : bcol, conf ? C_BLACK : bcol, conf ? C_AMBER : C_BLACK, red, bg);
  }
}

// Touch auf Screen 5; gibt true zurück, wenn der Tipp verbraucht wurde
static bool anchorTouch(int tx, int ty) {
  DashState s;
  xSemaphoreTake(sMutex, portMAX_DELAY); s = S; xSemaphoreGive(sMutex);
  if (!s.valid) return false;
  anchorLocalSync(s);
  const int MX = 12, MY = 72, PX = 500;
  for (int i = 0; i < 3; i++) {                       // Zoom
    int zx = MX + 456, zy = MY + 28 + i * 48;
    if ((tx - zx) * (tx - zx) + (ty - zy) * (ty - zy) < 26 * 26) {
      aZoom = i == 0 ? min(8.0f, aZoom * 1.5f) : i == 1 ? max(0.15f, aZoom / 1.5f) : 1.0f;
      return true;
    }
  }
  if (aReqBusy) return tx >= PX;
  for (int i = 0; i < 3; i++) {                       // −/+ Zeilen
    int y = 198 + i * 40;
    if (ty < y - 3 || ty > y + 37 || tx < PX + 186) continue;
    if (s.aAlarming && i > 0) return true;
    int d = tx >= PX + 240 ? 1 : -1;
    if (i == 0) { aRad = constrain((s.ancAct ? s.ancRad : aRad) + d * 5, 10, 300); }
    else if (i == 1) aChain = constrain(aChain + d, 0, 120);
    else { aBrg = ((aBrg + d * 5) % 360 + 360) % 360; aBrgManual = true; }
    if (s.ancAct) { aSaveAt = millis() + 1200; strlcpy(aSaveKind, i == 0 ? "radius" : "move", sizeof(aSaveKind)); }
    return true;
  }
  if (ty >= 320 && ty <= 384 && tx >= PX) {          // Aktionsknöpfe
    ABtn bt[3]; int n = anchorButtons(s, bt);
    int bw = (288 - (n - 1) * 8) / n;
    int i = (tx - PX) / (bw + 8);
    if (i < 0 || i >= n) return true;
    if (bt[i].confirm && (strcmp(aConfirm, bt[i].act) || millis() > aConfirmUntil)) {
      strlcpy(aConfirm, bt[i].act, sizeof(aConfirm)); aConfirmUntil = millis() + 4000;
      return true;
    }
    aConfirm[0] = 0;
    if (!strcmp(bt[i].act, "set"))
      snprintf(aReqBody, sizeof(aReqBody), "{\"action\":\"set\",\"radius_m\":%d,\"chain_length_m\":%d,\"bearing_deg\":%d}", aRad, aChain, aBrg);
    else snprintf(aReqBody, sizeof(aReqBody), "{\"action\":\"%s\"}", bt[i].act);
    aReqPending = true;
    return true;
  }
  return tx >= PX && ty >= 72 && ty <= 392;          // Tipps ins Panel nicht als Quittieren werten
}

static void render(const DashState& s, bool online, bool redPhase) {
  applyPalette(s.night);
  const bool red = s.blink && redPhase && online;
  const uint16_t bg = red ? C_RED_BG : C_BLACK;
  const uint16_t sub = red ? C_ONRED : C_GREY;
  const uint16_t dim = red ? C_ONRED : C_DIM;
  char buf[64];
  fb.fillScreen(bg);

  // Kopfzeile
  fb.setFont(&fonts::DejaVu40);
  fb.setTextDatum(textdatum_t::middle_left);
  fb.setTextColor(C_WHITE, bg);

  // Nachtmodus-Schalter (Mond), Touch-Zone x < 67, y < 72
  {
    uint16_t c = red ? C_ONRED : (s.night ? C_WHITE : C_DIM);
    fb.drawCircle(39, 36, 23, c);
    fb.drawCircle(39, 36, 22, c);
    fb.fillCircle(39, 36, 11, c);
    fb.fillCircle(45, 31, 10, bg);
  }
  // Settings-Zahnrad rechts daneben, Touch-Zone x 67..125
  {
    uint16_t c = red ? C_ONRED : (showSettings ? C_WHITE : C_DIM);
    const int gx = 95, gy = 36;
    fb.drawCircle(gx, gy, 23, c);
    fb.drawCircle(gx, gy, 22, c);
    for (int i = 0; i < 8; i++) {
      float a = i * PI / 4;
      fb.drawWideLine(gx + cosf(a) * 7, gy + sinf(a) * 7, gx + cosf(a) * 12, gy + sinf(a) * 12, 2, c);
    }
    fb.fillCircle(gx, gy, 9, c);
    fb.fillCircle(gx, gy, 4, bg);
  }
  {
    // Lokale Zeit groß, UTC klein daneben — gemeinsam zentriert, gleiche Grundlinie
    const char* lt = online ? s.time : "--:--";
    char ut[16] = "";
    if (online && s.utc[0]) snprintf(ut, sizeof(ut), "UTC %s", s.utc);
    fb.setFont(&fonts::DejaVu40);
    int wl = fb.textWidth(lt);
    fb.setFont(&fonts::DejaVu18);
    int wu = ut[0] ? fb.textWidth(ut) + 12 : 0;
    int x = 400 - (wl + wu) / 2;
    fb.setTextDatum(textdatum_t::baseline_left);
    fb.setTextColor(red ? C_ONRED : C_GREY, bg);
    fb.setFont(&fonts::DejaVu40);
    fb.drawString(lt, x, 50);
    if (wu) {
      fb.setTextColor(red ? C_ONRED : C_DIM, bg);
      fb.setFont(&fonts::DejaVu18);
      fb.drawString(ut, x + wl + 12, 50);
    }
  }

  const char* status = online ? s.status : "warn";
  const char* label = !online ? (WiFi.status() == WL_CONNECTED ? "OFFLINE" : "NO WIFI")
                      : !strcmp(status, "ok") ? "ALL OK"
                      : !strcmp(status, "alarm") ? "ALARM" : "WARNING";
  uint16_t dotCol = red ? C_ONRED : stColor(status, false);
  fb.fillCircle(768, 36, 16, dotCol);
  if (!strcmp(status, "ok")) fb.drawCircle(768, 36, 20, C_GREEN);
  fb.setFont(&fonts::DejaVu24);
  fb.setTextDatum(textdatum_t::middle_right);
  fb.setTextColor(C_WHITE, bg);
  fb.drawString(label, 738, 37);

  if (showSettings) {
    settingsPage(red, bg);
  } else if (page == 1) {
  // Linke Spalte: Batterie oben, Frischwasser unten
  if (online && !isnan(s.battV)) {
    if (!isnan(s.battA)) snprintf(buf, sizeof(buf), "%.2f V  %.1f A", s.battV, s.battA);
    else snprintf(buf, sizeof(buf), "%.2f V", s.battV);
  } else strcpy(buf, "-- V");
  halfTile(72, "BATTERY", s.battSt, online, s.battSoc, s.battThr, buf, C_GREEN, red, bg);

  if (online && s.waterL >= 0 && s.waterCap > 0) snprintf(buf, sizeof(buf), "%d l of %d l", s.waterL, s.waterCap);
  else strcpy(buf, "-- l");
  halfTile(238, "WATER", s.waterSt, online, s.waterPct, s.waterThr, buf, C_BLUE, red, bg);

  // Kachel Wind
  {
    const int x = 276, cx = x + 124;
    bool al = online && !strcmp(s.windSt, "alarm");
    if (online) histChart(s.windHist, s.windN, x + 6, 236, 72 + 120, 72 + 314, true, al, red, bg);
    tileFrame(x, "WIND", al, red, bg);
    gTransp = true;
    uint16_t col = online ? stColor(s.windSt, red) : C_AMBER;
    if (online && !isnan(s.windKn)) snprintf(buf, sizeof(buf), "%.1f", s.windKn); else strcpy(buf, "--");
    bigValue(buf, "kn", cx, 210, col, bg);
    if (online && s.windSrc[0]) snprintf(buf, sizeof(buf), "%s (avg)", s.windSrc); else strcpy(buf, "--");
    centerText(buf, cx, 260, &fonts::DejaVu24, sub, bg);
    if (online && !isnan(s.windMax)) snprintf(buf, sizeof(buf), "Max 10' %.1f kn", s.windMax); else strcpy(buf, "Max 10' --");
    centerText(buf, cx, 300, &fonts::DejaVu24, sub, bg);
    if (s.windThr >= 0) {
      if (s.windWin >= 60) snprintf(buf, sizeof(buf), "Alarm at %d kn  -  %d h", s.windThr, s.windWin / 60);
      else if (s.windWin > 0) snprintf(buf, sizeof(buf), "Alarm at %d kn  -  %d min", s.windThr, s.windWin);
      else snprintf(buf, sizeof(buf), "Alarm at %d kn", s.windThr);
    } else buf[0] = 0;
    centerText(buf, cx, 350, &fonts::DejaVu18, dim, bg);
    gTransp = false;
  }

  // Rechte Spalte: Anker oben, Barometer unten
  {
    const int x = 540, y = 72, w = 248, h = 154, cx = x + w / 2;
    bool al = online && !strcmp(s.ancSt, "alarm");
    uint16_t border = red ? C_ONRED : (al ? C_RED : C_BORDER);
    for (int i = 0; i < (al ? 5 : 2); i++) fb.drawRoundRect(x + i, y + i, w - 2 * i, h - 2 * i, 14 - i, border);
    fb.setFont(&fonts::DejaVu18);
    fb.setTextColor(red ? C_ONRED : C_GREY, bg);
    fb.setTextDatum(textdatum_t::middle_left);
    fb.drawString("ANCHOR", x + 16, y + 20);
    if (online) {
      fb.setTextColor(red ? C_ONRED : (s.ancCloud ? C_DIM : C_AMBER), bg);
      fb.setTextDatum(textdatum_t::middle_right);
      fb.drawString(s.ancCloud ? "cloud" : "cloud offline", x + w - 16, y + 20);
    }
    const char* word = !online ? "--" : al ? "ALARM" : !strcmp(s.ancSt, "off") ? "OFF"
                       : !strcmp(s.ancSt, "ok") ? "ACTIVE" : "--";
    bool showBtn = online && (s.ancAct || aupState == AUP_BUSY);
    centerText(word, cx, showBtn ? y + 52 : y + 76, &fonts::DejaVu40, online ? stColor(s.ancSt, red) : C_AMBER, bg);
    if (online && s.ancAct && s.ancDist >= 0) {
      if (s.ancRad >= 0) snprintf(buf, sizeof(buf), "%d m / radius %d m", s.ancDist, s.ancRad);
      else snprintf(buf, sizeof(buf), "%d m from anchor", s.ancDist);
      centerText(buf, cx, showBtn ? y + 88 : y + 128, &fonts::DejaVu18, sub, bg);
    }
    if (showBtn) {
      const char* lbl = aupState == AUP_CONFIRM ? "TAP TO CONFIRM" : aupState == AUP_BUSY ? "SENDING ..."
                        : aupState == AUP_ERR ? "FAILED - RETRY" : "ANCHOR UP";
      bool conf = aupState == AUP_CONFIRM;
      uint16_t fillC = red ? bg : (conf ? C_AMBER : C_BLACK);
      uint16_t brd = red ? C_ONRED : (conf ? C_AMBER : aupState == AUP_ERR ? C_RED : C_GREY);
      uint16_t txt = red ? C_ONRED : (conf ? C_BLACK : aupState == AUP_ERR ? C_RED : C_WHITE);
      fb.fillRoundRect(AUP_X0, AUP_Y0, AUP_X1 - AUP_X0, AUP_Y1 - AUP_Y0, 8, fillC);
      fb.drawRoundRect(AUP_X0, AUP_Y0, AUP_X1 - AUP_X0, AUP_Y1 - AUP_Y0, 8, brd);
      fb.drawRoundRect(AUP_X0 + 1, AUP_Y0 + 1, AUP_X1 - AUP_X0 - 2, AUP_Y1 - AUP_Y0 - 2, 7, brd);
      centerText(lbl, cx, (AUP_Y0 + AUP_Y1) / 2, &fonts::DejaVu18, txt, fillC);
    }
  }
  {
    const int x = 540, y = 238, w = 248, h = 154, cx = x + w / 2;
    bool al = online && !strcmp(s.baroSt, "alarm");
    // Hintergrund-Diagramm: Druckverlauf über das eingestellte Fenster
    if (online) histChart(s.baroHist, s.baroN, x + 6, w - 12, y + 40, y + h - 6, false, al, red, bg);
    uint16_t border = red ? C_ONRED : (al ? C_RED : C_BORDER);
    for (int i = 0; i < (al ? 5 : 2); i++) fb.drawRoundRect(x + i, y + i, w - 2 * i, h - 2 * i, 14 - i, border);
    // Texte transparent über dem Diagramm
    fb.setFont(&fonts::DejaVu18);
    fb.setTextColor(red ? C_ONRED : C_GREY);
    fb.setTextDatum(textdatum_t::middle_left);
    fb.drawString("BARO", x + 16, y + 20);
    if (s.baroThr >= 0) {
      snprintf(buf, sizeof(buf), "< %d", s.baroThr);
      fb.setTextColor(red ? C_ONRED : C_DIM);
      fb.setTextDatum(textdatum_t::middle_right);
      fb.drawString(buf, x + w - 16, y + 20);
    }
    if (online && !isnan(s.baroHpa)) snprintf(buf, sizeof(buf), "%.1f", s.baroHpa); else strcpy(buf, "--");
    fb.setFont(&fonts::DejaVu40);
    int wv = fb.textWidth(buf);
    fb.setFont(&fonts::DejaVu18);
    int wu = fb.textWidth("hPa") + 6;
    int bx = cx - (wv + wu) / 2;
    uint16_t col = online ? stColor(s.baroSt, red) : C_AMBER;
    fb.setTextDatum(textdatum_t::baseline_left);
    fb.setTextColor(col);
    fb.setFont(&fonts::DejaVu40);
    fb.drawString(buf, bx, y + 92);
    fb.setFont(&fonts::DejaVu18);
    fb.drawString("hPa", bx + wv + 6, y + 92);
    if (online && !isnan(s.baroD)) {
      char win[12];
      if (s.baroWin >= 60) snprintf(win, sizeof(win), "%d h", s.baroWin / 60); else snprintf(win, sizeof(win), "%d min", s.baroWin);
      snprintf(buf, sizeof(buf), "%+.1f hPa / %s", s.baroD, win);
      fb.setTextColor(red ? C_ONRED : C_GREY);
      fb.setTextDatum(textdatum_t::middle_center);
      fb.drawString(buf, cx, y + 128);
    }
  }

  } else if (page == 2) {
    energyPage(s, online, red, bg, millis());
  } else if (page == 3) {
    weatherPage(s, online, red, bg);
  } else if (page == 4) {
    enginePage(s, online, red, bg);
  } else {
    anchorPage(s, online, red, bg);
  }

  // Fußzeile: Alarm-/Warntexte
  const char* msg = !online ? (WiFi.status() == WL_CONNECTED ? "No connection to Node-RED" : "Connecting to WiFi ...")
                    : s.msg;
  uint16_t mcol = red ? C_ONRED : (online && !strcmp(s.status, "alarm") ? C_RED : C_AMBER);
  fb.setFont(&fonts::DejaVu24);
  const lgfx::IFont* mf = fb.textWidth(msg) > 768 ? (const lgfx::IFont*)&fonts::DejaVu18 : &fonts::DejaVu24;
  centerText(msg, 400, 418, mf, mcol, bg);
  const char* hint = online && s.blink ? "Tap to acknowledge" : (online && s.acked ? "Acknowledged" : "");
  centerText(hint, 400, 446, &fonts::DejaVu18, red ? C_ONRED : C_GREY, bg);

  // Seiten-Punkte
  for (int i = 0; i < 5; i++)
    fb.fillCircle(372 + i * 14, 470, 4, red ? C_ONRED : (page == i + 1 ? C_GREY : C_BORDER));

  fb.pushSprite(0, 0);
}

// ── Setup / Loop ────────────────────────────────────────────────────────────
// DashState wird pro Frame kopiert (~3 KB) → großzügiger Stack für den Loop-Task
SET_LOOP_TASK_STACK_SIZE(16 * 1024);

void setup() {
  Serial.begin(115200);
  if (BUZZER_PIN >= 0) { pinMode(BUZZER_PIN, OUTPUT); buzzer(false); }
  boardInit();
  lcd.init();
  lcd.fillScreen(TFT_BLACK);

  applyPalette(false);

  fb.setColorDepth(16);
  fb.setPsram(true);
  if (!fb.createSprite(800, 480)) {
    Serial.println("Sprite-Allokation fehlgeschlagen — ist OPI PSRAM aktiviert?");
    lcd.setTextColor(TFT_RED);
    lcd.setFont(&fonts::DejaVu24);
    lcd.drawString("PSRAM missing: select board option 'OPI PSRAM'", 20, 220);
    for (;;) delay(1000);
  }

  sMutex = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 1, nullptr, 0);
}

void loop() {
  static uint32_t lastRev = 0xFFFFFFFF, lastFrame = 0;
  static bool lastPhase = false, lastOnline = false, wasDown = false;

  // Touch: Wischen links/rechts = Screen wechseln, Tippen (beim Loslassen ausgewertet):
  // Mond-Bereich oben links = Nachtmodus, sonst bei Alarm = Quittieren
  static int t0x = -1, t0y = -1, tlx = -1;
  static uint32_t lastTouchMs = 0;
  int tx = -1, ty = -1;
  bool fresh = touchRead(tx, ty);
  bool down = fresh || (wasDown && millis() - lastTouchMs < 120);  // GT911 meldet nicht jeden Loop
  if (fresh) {
    lastTouchMs = millis();
    if (!wasDown) { t0x = tx; t0y = ty; }
    tlx = tx;
  }
  if (!down && wasDown && t0x >= 0) {
    int dx = tlx - t0x;
    bool ancAct;
    xSemaphoreTake(sMutex, portMAX_DELAY);
    ancAct = S.ancAct;
    xSemaphoreGive(sMutex);
    bool onAup = page == 1 && !showSettings && ancAct && abs(dx) <= 120 &&
                 t0x >= AUP_X0 - 6 && t0x <= AUP_X1 + 6 && t0y >= AUP_Y0 - 6 && t0y <= AUP_Y1 + 6;
    if (onAup) {
      if (aupState == AUP_CONFIRM && millis() < aupUntil) {
        aupState = AUP_BUSY; anchorUpRequested = true;
      } else if (aupState != AUP_BUSY) {
        aupState = AUP_CONFIRM; aupUntil = millis() + 4000;
      }
      dataRev++;
    } else if (abs(dx) > 120 && !showSettings) {
      page = constrain(page + (dx < 0 ? 1 : -1), 1, 5);
      dataRev++;  // sofort neu zeichnen
    } else if (page == 5 && !showSettings && t0y >= 72 && t0y <= 392 && anchorTouch(t0x, t0y)) {
      dataRev++;
    } else if (t0x >= 67 && t0x < 125 && t0y < 72) {
      showSettings = !showSettings; settingsOpenedMs = millis(); dataRev++;
    } else if (showSettings && !(t0x < 67 && t0y < 72)) {
      showSettings = false; dataRev++;
    } else {
      xSemaphoreTake(sMutex, portMAX_DELAY);
      bool blinking = S.blink, night = S.night;
      xSemaphoreGive(sMutex);
      if (localNightMs && millis() - localNightMs < 3000) night = localNightVal;
      if (t0x < 67 && t0y < 72) {
        localNightVal = !night; localNightMs = millis();
        nightRequest = localNightVal ? 1 : 0;
      } else if (blinking) {
        ackRequested = true; localAckMs = millis();
      }
    }
    t0x = -1;
  }
  wasDown = down;

  {
    // Summer läuft jeden Loop-Durchlauf (genaueres Timing als das Rendering)
    xSemaphoreTake(sMutex, portMAX_DELAY);
    char mode[6];
    strlcpy(mode, S.beep, sizeof(mode));
    xSemaphoreGive(sMutex);
    uint32_t t = millis();
    bool online = lastOkMs && t - lastOkMs < 10000;
    if (!online || (localAckMs && t - localAckMs < 3000)) strcpy(mode, "off");
    updateBuzzer(mode, t);
  }

  uint32_t now = millis();
  bool phase = (now / 500) % 2;
  bool online = lastOkMs && now - lastOkMs < 10000;

  bool nightPreview = localNightMs && now - localNightMs < 3100;
  {
    static bool wasBlink = false;
    xSemaphoreTake(sMutex, portMAX_DELAY);
    bool b = S.blink;
    xSemaphoreGive(sMutex);
    if (b && !wasBlink && (page != 1 || showSettings)) { page = 1; showSettings = false; dataRev++; }  // neuer Alarm → Übersicht
    if (showSettings && now - settingsOpenedMs > 60000) { showSettings = false; dataRev++; }
    wasBlink = b;
  }
  if ((aupState == AUP_CONFIRM || aupState == AUP_ERR) && millis() > aupUntil) { aupState = AUP_IDLE; dataRev++; }
  if (aSaveAt && millis() > aSaveAt && !aReqPending) {   // aktiver Anker: Änderung systemweit speichern
    if (!strcmp(aSaveKind, "radius")) snprintf(aReqBody, sizeof(aReqBody), "{\"action\":\"radius\",\"radius_m\":%d}", aRad);
    else snprintf(aReqBody, sizeof(aReqBody), "{\"action\":\"move\",\"chain_length_m\":%d,\"bearing_deg\":%d}", aChain, aBrg);
    aSaveAt = 0; aReqPending = true; dataRev++;
  }
  if (aConfirm[0] && millis() > aConfirmUntil) { aConfirm[0] = 0; dataRev++; }
  if (aMsg[0] && millis() > aMsgUntil) { aMsg[0] = 0; dataRev++; }
  bool animate = page == 2 && !showSettings && now - lastFrame >= 90;  // Pfeile im Energy Flow animieren
  if (animate || nightPreview || dataRev != lastRev || phase != lastPhase || online != lastOnline || now - lastFrame > 5000) {
    xSemaphoreTake(sMutex, portMAX_DELAY);
    DashState s = S;
    xSemaphoreGive(sMutex);
    if (localAckMs && now - localAckMs < 3000) s.blink = false;
    if (localNightMs && now - localNightMs < 3000) s.night = localNightVal;
    render(s, online, phase);
    lastRev = dataRev; lastPhase = phase; lastOnline = online; lastFrame = now;
  }
  delay(20);
}
