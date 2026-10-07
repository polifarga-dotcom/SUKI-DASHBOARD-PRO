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
#include "logo_neel.h"
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
    C_ZG, C_ZO, C_ZR,  // Rigg-Balken Zonen
    C_BROWN,           // Schwarzwasser-Tank
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
struct WxPart {   // Tagesverlauf: MORNING / MIDDAY / EVENING / NIGHT
  char lbl[8] = "", hrs[8] = "", dl[4] = "", ic[8] = "", txt[16] = "", wd[3] = "";
  bool night = false;
  int max = NA_I, min = NA_I, ws = NA_I, wg = NA_I, pp = NA_I;
  float ps = NAN;
};
struct EMppt { char n[15] = ""; int w = NA_I; float kwh = NAN; };          // einzelner Solarregler
struct EBat { char n[17] = ""; int soc = NA_I; float v = NAN; };            // weitere Batterie (z. B. Starter)
struct TankV {
  char name[12] = "", kind[6] = "", st[6] = "na";
  int pct = NA_I, l = NA_I, cap = NA_I;
};
// AIS (Screen 6): eigener globaler Block, damit DashState-Kopien auf dem Stack klein bleiben
struct AisT {
  char m[10] = "", nm[18] = "", cs[9] = "", ty[16] = "", dest[16] = "", nav[16] = "";
  float e = 0, n = 0, sog = NAN, d = NAN, cpa = NAN, tcpa = NAN;
  int16_t cog = NA_I, hdg = NA_I, b = NA_I, len = NA_I, age = 0;
  uint8_t st = 0;   // 0 ok, 1 warn, 2 alarm
  bool stale = false;
};
struct AisState {
  bool ok = false, own = false, alarmKey = false, onlyAlarm = false;
  char mode[10] = "cruising";
  float thr = NAN, cn = 0.5f, on = 2, ownSog = NAN;
  int ownCog = 0, n = 0, alarms = 0, nt = 0, up = NA_I;   // up = Heading-up-Winkel, NA_I = Nord oben
  char upSrc[4] = "N";
  AisT t[30];
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
  WxPart parts[4];
  int nParts = 0;
  // SOS / VHF-Notruf (Screen 8)
  char sosName[12] = "SUKI", sosCs[10] = "", sosMmsi[14] = "", sosPhon[64] = "", sosLat[48] = "", sosLon[48] = "", sosUtc[16] = "", sosDesc[44] = "";
  int sosPob = 2;
  // Tanks (Screen 1, Box links)
  TankV tanks[4];
  // Segeln (Screen 5)
  float sAws = NAN, sTws = NAN, sStw = NAN, sSog = NAN, rigP = NAN, rigS = NAN, rigWarn = 3.2f, rigAlarm = 4.2f, rigScale = 5;
  int sAwa = NA_I, sTwa = NA_I, sTwd = NA_I, sHdg = NA_I, sWin = 0, sAwsN = 0;
  bool sTwCalc = false;
  float sAwsMax = NAN, sAwsHist[60];
  char rigPst[8] = "na", rigSst[8] = "na";
  bool rigOnlyAlarm = false, engOnlyAlarm = false;
  bool classicDial = false;
  int closeFrom = 30, closeTo = 50;  // Am-Wind-Sektoren (° AWA)   // alle aktiven Alarme sind Rigg-Alarme → Segel-Screen zeigen
  // Anker-Screen (Screen 7)
  int aChainDb = NA_I, aBrgDb = NA_I, aHdg = NA_I, aBtoa = NA_I, aTrackN = 0;
  float aDepth = NAN, aScope = NAN, aLat = NAN, aLon = NAN, aBlat = NAN;
  bool aAlarming = false, aMuted = false, aHasLast = false, aHasBoff = false;
  int aBoffE = 0, aBoffN = 0;
  int16_t aTrack[120][2];
  // Motor (Screen 4)
  bool mOn = false, mTempLive = false, mEst = false;
  int mRpm = NA_I, mMax = 3000, mRed = 2500, mG0 = 1800, mG1 = 2200, mTemp = NA_I, mFuelPct = NA_I, mFuelL = NA_I, mFuelCap = NA_I, mRangeNm = NA_I;
  float mHrs = NAN, mLph = NAN, mRangeH = NAN, mSog = NAN, mAws = NAN, mWtemp = NAN;
  int mAwa = NA_I, mTwarn = 90, mTalarm = 95;
  char mTst[8] = "na";
  // Victron Energy Flow (NA_I = kein Wert)
  bool eOk = false, shoreOn = false;
  int shoreW, shoreV, invW, acW, pvW, batSoc, batW, dcW;
  float pvToday = NAN, batV = NAN, batA = NAN, pvA = NAN, pvYest = NAN;
  char batName[17] = "";
  EMppt mppt[6]; int nMppt = 0;
  EBat ebat[3]; int nEbat = 0;
  int16_t pvHist[60], acHist[60], dcHist[60]; int pvHn = 0, acHn = 0, dcHn = 0;   // 10-min-Verlauf (W), INT16_MIN = Lücke
  char invSt[16] = "--", batSt[14] = "--", batTtg[12] = "";
};
static DashState S;
static AisState AIS, aisR;   // AIS: vom Poll-Task geschrieben / Kopie für das Rendering
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
static bool offMode = false;     // „Off“-Screen: schwarz, nur Uhrzeit schwach; Tipp → Screen 1, Alarm weckt
static bool sosPanPan = false;   // SOS-Screen: false = MAYDAY, true = PAN PAN
static uint8_t sosStep = 0;      // 0 = CALL, 1 = POSITION, 2 = SITUATION
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
static uint8_t page = 1;         // 1 = Übersicht, 2 = Victron Energy Flow, 3 = Wetter, 4 = Motor, 5 = Segeln, 6 = AIS, 7 = Anker, 8 = SOS (per Wischen oder Rettungsring-Knopf)
static uint32_t localAckMs = 0;
static const float aisRanges[] = {0.25f, 0.5f, 1, 2, 4, 8, 12, 24};
static int8_t aisRangeIdx = 3;           // 2 NM
static char aisSel[10] = "";             // angetippte MMSI
static volatile bool aisModePending = false;
static char aisModeReq[10] = "";
static int16_t aisPts[30][2]; static int aisPtN = 0; static char aisPtM[30][10];  // unterdrückt Blinken kurz bis zur Bestätigung von Node-RED

// Tag: schwarz/weiß/grün — Nacht: schwarz/rot (Nachtsicht schonen), Alarm blinkt dunkelrot
static void applyPalette(bool night) {
  auto c = [](uint8_t r, uint8_t g, uint8_t b) { return lgfx::color565(r, g, b); };
  C_BLACK = c(0, 0, 0);
  if (!night) {
    C_RED_BG = c(208, 0, 0);   C_ONRED = c(255, 255, 255); C_WHITE = c(255, 255, 255);
    C_GREEN = c(0, 208, 0);    C_AMBER = c(255, 160, 0);   C_RED = c(255, 48, 48);
    C_GREY = c(170, 170, 170); C_DIM = c(110, 110, 110);   C_BORDER = c(51, 51, 51);
    C_BLUE = c(42, 157, 244);
    C_ZG = c(0, 44, 18);       C_ZO = c(54, 34, 0);        C_ZR = c(64, 8, 8);        C_BROWN = c(121, 85, 72);
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
    C_ZG = c(20, 0, 0);        C_ZO = c(34, 0, 0);         C_ZR = c(54, 0, 0);        C_BROWN = c(112, 0, 0);
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

  {
    int i = 0;
    for (JsonObject t : doc["tanks"].as<JsonArray>()) {
      if (i >= 4) break;
      strlcpy(n.tanks[i].name, t["name"] | "", sizeof(n.tanks[i].name));
      strlcpy(n.tanks[i].kind, t["kind"] | "", sizeof(n.tanks[i].kind));
      strlcpy(n.tanks[i].st, t["st"] | "na", sizeof(n.tanks[i].st));
      n.tanks[i].pct = t["pct"] | NA_I; n.tanks[i].l = t["l"] | NA_I; n.tanks[i].cap = t["cap"] | NA_I;
      i++;
    }
  }

  {
    JsonObject o = doc["sos"];
    strlcpy(n.sosName, o["name"] | "SUKI", sizeof(n.sosName));
    strlcpy(n.sosCs, o["cs"] | "", sizeof(n.sosCs));
    strlcpy(n.sosMmsi, o["mmsiFmt"] | "", sizeof(n.sosMmsi));
    strlcpy(n.sosPhon, o["csPhon"] | "", sizeof(n.sosPhon));
    strlcpy(n.sosLat, o["lat"] | "", sizeof(n.sosLat));
    strlcpy(n.sosLon, o["lon"] | "", sizeof(n.sosLon));
    strlcpy(n.sosUtc, o["utc"] | "", sizeof(n.sosUtc));
    strlcpy(n.sosDesc, o["desc"] | "", sizeof(n.sosDesc));
    n.sosPob = o["pob"] | 2;
  }

  JsonObject sl = doc["sail"];
  n.sAws = sl["aws"] | NAN; n.sTws = sl["tws"] | NAN; n.sStw = sl["stw"] | NAN; n.sSog = sl["sog"] | NAN;
  n.sAwa = sl["awa"] | NA_I; n.sTwa = sl["twa"] | NA_I; n.sHdg = sl["hdg"] | NA_I;
  n.sAwsMax = sl["awsMax"] | NAN; n.sWin = sl["win"] | 0;
  n.sTwd = sl["twd"] | NA_I; n.sTwCalc = sl["twCalc"] | false;
  n.classicDial = !strcmp(sl["style"] | "tacho", "classic");
  n.closeFrom = sl["cf"] | 30; n.closeTo = sl["ct"] | 50;
  n.sAwsN = 0;
  for (JsonVariant v : sl["awsHist"].as<JsonArray>()) {
    if (n.sAwsN >= 60) break;
    n.sAwsHist[n.sAwsN++] = v.isNull() ? NAN : v.as<float>();
  }
  JsonObject rg = sl["rig"];
  n.rigP = rg["port"] | NAN; n.rigS = rg["sb"] | NAN;
  n.rigWarn = rg["warn"] | 3.2f; n.rigAlarm = rg["alarm"] | 4.2f; n.rigScale = rg["scale"] | 5.0f;
  strlcpy(n.rigPst, rg["pst"] | "na", sizeof(n.rigPst));
  strlcpy(n.rigSst, rg["sst"] | "na", sizeof(n.rigSst));
  {
    JsonArray ak = doc["alarmKeys"].as<JsonArray>();
    n.rigOnlyAlarm = n.engOnlyAlarm = ak.size() > 0;
    for (JsonVariant k : ak) {
      if (strncmp(k | "", "rig", 3)) n.rigOnlyAlarm = false;
      if (strcmp(k | "", "engtemp")) n.engOnlyAlarm = false;
    }
  }

  {
    static AisState an;   // statisch: nicht auf dem Stack des Netz-Tasks
    an = AisState();
    JsonObject ai = doc["ais"];
    an.ok = !ai.isNull();
    strlcpy(an.mode, ai["mode"] | "cruising", sizeof(an.mode));
    an.thr = ai["thr"] | NAN; an.cn = ai["cn"] | 0.5f; an.on = ai["on"] | 2.0f;
    an.own = ai["own"] | false; an.n = ai["n"] | 0; an.alarms = ai["alarms"] | 0;
    an.ownCog = ai["ownCog"] | 0; an.ownSog = ai["ownSog"] | NAN;
    an.up = ai["up"] | NA_I; strlcpy(an.upSrc, ai["upSrc"] | "N", sizeof(an.upSrc));
    for (JsonObject t : ai["targets"].as<JsonArray>()) {
      if (an.nt >= 30) break;
      AisT& x = an.t[an.nt++];
      strlcpy(x.m, t["m"] | "", sizeof(x.m));       strlcpy(x.nm, t["nm"] | "", sizeof(x.nm));
      strlcpy(x.cs, t["cs"] | "", sizeof(x.cs));     strlcpy(x.ty, t["ty"] | "", sizeof(x.ty));
      strlcpy(x.dest, t["dest"] | "", sizeof(x.dest)); strlcpy(x.nav, t["nav"] | "", sizeof(x.nav));
      x.e = t["e"] | 0.0f; x.n = t["n"] | 0.0f; x.sog = t["sog"] | NAN; x.d = t["d"] | NAN;
      x.cpa = t["cpa"] | NAN; x.tcpa = t["tcpa"] | NAN;
      x.cog = t["cog"] | NA_I; x.hdg = t["hdg"] | NA_I; x.b = t["b"] | NA_I; x.len = t["len"] | NA_I; x.age = t["age"] | 0;
      const char* st = t["st"] | "ok"; x.st = !strcmp(st, "alarm") ? 2 : !strcmp(st, "warn") ? 1 : 0;
      x.stale = t["stale"] | false;
    }
    JsonArray ak = doc["alarmKeys"].as<JsonArray>();
    an.onlyAlarm = ak.size() > 0;
    for (JsonVariant k : ak) { if (!strncmp(k | "", "ais_", 4)) an.alarmKey = true; else an.onlyAlarm = false; }
    xSemaphoreTake(sMutex, portMAX_DELAY); AIS = an; xSemaphoreGive(sMutex);
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
  n.mAws = m["aws"] | NAN; n.mAwa = m["awa"] | NA_I; n.mWtemp = m["wtemp"] | NAN;
  n.mTwarn = m["twarn"] | 90; n.mTalarm = m["talarm"] | 95;
  strlcpy(n.mTst, m["tst"] | "na", sizeof(n.mTst));

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
    n.nParts = 0;
    for (JsonObject o : wx["parts"].as<JsonArray>()) {
      if (n.nParts >= 4) break;
      WxPart& q = n.parts[n.nParts++];
      strlcpy(q.lbl, o["lbl"] | "", sizeof(q.lbl)); strlcpy(q.dl, o["dl"] | "", sizeof(q.dl));
      strlcpy(q.ic, o["ic"] | "", sizeof(q.ic));   strlcpy(q.txt, o["txt"] | "", sizeof(q.txt));
      strlcpy(q.wd, o["wd"] | "", sizeof(q.wd));
      // "now–12" → ASCII-Bindestrich (DejaVu-Fonts in LovyanGFX haben keinen Gedankenstrich)
      const char* h = o["hrs"] | ""; int k = 0;
      for (const char* c = h; *c && k < (int)sizeof(q.hrs) - 1; c++) {
        if ((uint8_t)*c == 0xE2 && c[1] && c[2]) { q.hrs[k++] = '-'; c += 2; } else q.hrs[k++] = *c;
      }
      q.hrs[k] = 0;
      q.night = o["night"] | false;
      q.max = o["max"] | NA_I; q.min = o["min"] | NA_I; q.ws = o["ws"] | NA_I; q.wg = o["wg"] | NA_I;
      q.pp = o["pp"] | NA_I; q.ps = o["ps"] | NAN;
    }
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
  n.pvA = e["pv"]["a"] | NAN; n.pvYest = e["pv"]["yest"] | NAN;
  strlcpy(n.batName, e["bat"]["n"] | "", sizeof(n.batName));
  n.nMppt = 0;
  for (JsonObject m : e["pv"]["mppts"].as<JsonArray>()) {
    if (n.nMppt >= 6) break;
    EMppt& q = n.mppt[n.nMppt++];
    strlcpy(q.n, m["n"] | "", sizeof(q.n)); q.w = m["w"] | NA_I; q.kwh = m["kwh"] | NAN;
  }
  auto rh = [](JsonArray a, int16_t* h, int& hn) {
    hn = 0;
    for (JsonVariant v : a) { if (hn >= 60) break; h[hn++] = v.isNull() ? INT16_MIN : (int16_t)constrain(v.as<int>(), -32000, 32000); }
  };
  rh(e["pv"]["hist"].as<JsonArray>(), n.pvHist, n.pvHn);
  rh(e["ac"]["hist"].as<JsonArray>(), n.acHist, n.acHn);
  rh(e["dc"]["hist"].as<JsonArray>(), n.dcHist, n.dcHn);
  n.nEbat = 0;
  for (JsonObject b : e["bats"].as<JsonArray>()) {
    if (n.nEbat >= 3) break;
    EBat& q = n.ebat[n.nEbat++];
    strlcpy(q.n, b["n"] | "", sizeof(q.n)); q.soc = b["soc"] | NA_I; q.v = b["v"] | NAN;
  }
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

    if (aisModePending) {
      HTTPClient http;
      http.setConnectTimeout(1500);
      http.setTimeout(2000);
      if (http.begin(String(DASH_URL) + "/config")) {
        http.addHeader("Content-Type", "application/json");
        char body[40]; snprintf(body, sizeof(body), "{\"aisMode\":\"%s\"}", aisModeReq);
        Serial.printf("aisMode -> %d\n", http.POST(body));
        http.end();
      }
      aisModePending = false;
      lastPoll = millis() - 800;
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

// Großer Wert + Einheit; passt er nicht in maxW (z. B. zweistelliger Wind "12.3 kn"), eine Schriftgröße kleiner
static void bigValue(const char* val, const char* unit, int cx, int baseY, uint16_t col, uint16_t bg, int maxW = 224) {
  static const lgfx::IFont* sizes[] = {&fonts::DejaVu72, &fonts::DejaVu56, &fonts::DejaVu40};
  fb.setFont(&fonts::DejaVu24);
  int wu = unit && *unit ? fb.textWidth(unit) + 6 : 0;
  const lgfx::IFont* f = sizes[0];
  int wv = 0;
  for (auto cand : sizes) { f = cand; fb.setFont(f); wv = fb.textWidth(val); if (wv + wu <= maxW) break; }
  int x = cx - (wv + wu) / 2;
  fb.setTextDatum(textdatum_t::baseline_left);
  if (gTransp) fb.setTextColor(col); else fb.setTextColor(col, bg);
  fb.setFont(f);
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

// Screen 1 links: Batterie groß + alle Tanks als Balken in einer Box
static void supplyTile(const DashState& s, bool online, bool red, uint16_t bg) {
  const int x = 12, y = 72, w = 248, h = 320;
  bool hiTank = false;
  for (int i = 0; i < 4; i++) if (!strcmp(s.tanks[i].st, "high")) hiTank = true;
  bool al = online && (!strcmp(s.battSt, "alarm") || !strcmp(s.waterSt, "alarm") || hiTank);
  uint16_t border = red ? C_ONRED : (al ? C_RED : C_BORDER);
  for (int i = 0; i < (al ? 5 : 2); i++) fb.drawRoundRect(x + i, y + i, w - 2 * i, h - 2 * i, 14 - i, border);
  char b[24], b2[24];
  const uint16_t grey = red ? C_ONRED : C_GREY, dim = red ? C_ONRED : C_DIM, fg = red ? C_ONRED : C_WHITE;
  fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(grey, bg);
  fb.drawString("BATTERY", x + 16, y + 20);
  if (s.battThr >= 0) {
    snprintf(b, sizeof(b), "< %d %%", s.battThr);
    fb.setTextColor(dim, bg); fb.setTextDatum(textdatum_t::middle_right); fb.drawString(b, x + w - 16, y + 20);
  }
  // SOC groß links, V / A rechts gestapelt
  if (online && s.battSoc >= 0) snprintf(b, sizeof(b), "%d", s.battSoc); else strcpy(b, "--");
  uint16_t sc = !online ? C_AMBER : stColor(s.battSt, red);
  fb.setFont(&fonts::DejaVu56); fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(sc, bg);
  fb.drawString(b, x + 14, y + 84);
  int wv = fb.textWidth(b);
  fb.setFont(&fonts::DejaVu24); fb.drawString("%", x + 18 + wv, y + 84);
  if (online && !isnan(s.battV)) snprintf(b, sizeof(b), "%.2f V", s.battV); else strcpy(b, "-- V");
  if (online && !isnan(s.battA)) snprintf(b2, sizeof(b2), "%s%.1f A", s.battA > 0 ? "+" : "", s.battA); else strcpy(b2, "-- A");
  fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::middle_right); fb.setTextColor(fg, bg);
  fb.drawString(b, x + w - 16, y + 50); fb.drawString(b2, x + w - 16, y + 74);
  int p = online && s.battSoc >= 0 ? constrain(s.battSoc, 0, 100) : 0;
  fb.fillRoundRect(x + 16, y + 98, 216, 10, 5, red ? C_ONRED : C_BORDER);
  if (p) fb.fillRoundRect(x + 16, y + 98, 216 * p / 100, 10, 5, red ? C_RED_BG : sc);
  fb.drawFastHLine(x + 16, y + 124, 216, red ? C_ONRED : C_BORDER);
  // Tanks: Name, Liter, Prozent + Balken in Tankfarbe (Wasser blau, Diesel gelb, Schwarzwasser braun)
  static const char* defNames[] = {"WATER", "DIESEL", "BLACK MAIN", "BLACK GUEST"};
  for (int i = 0; i < 4; i++) {
    const TankV& t = s.tanks[i];
    const char* st = !strcmp(t.kind, "water") ? s.waterSt : t.st;   // Frischwasser nutzt den echten Wasser-Alarm
    bool hi = online && (!strcmp(st, "alarm") || !strcmp(st, "high")), wr = online && !strcmp(st, "warn");
    int ty = y + 146 + i * 46;
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(grey, bg);
    fb.drawString(t.name[0] ? t.name : defNames[i], x + 16, ty);
    if (online && t.pct != NA_I) snprintf(b, sizeof(b), "%d %%", t.pct); else strcpy(b, "--");
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::middle_right);
    fb.setTextColor(red ? C_ONRED : hi ? C_RED : wr ? C_AMBER : C_WHITE, bg);
    fb.drawString(b, x + w - 16, ty);
    int wp = fb.textWidth(b);
    if (online && t.l != NA_I && t.cap != NA_I) {
      snprintf(b2, sizeof(b2), "%d / %d l", t.l, t.cap);
      fb.setFont(&fonts::DejaVu12); fb.setTextColor(grey, bg);
      fb.drawString(b2, x + w - 22 - wp, ty + 1);
    }
    int tp = online && t.pct != NA_I ? constrain(t.pct, 0, 100) : 0;
    uint16_t fc = red ? C_RED_BG : hi ? C_RED : wr ? C_AMBER : !strcmp(t.kind, "fuel") ? C_WSUN : !strcmp(t.kind, "black") ? C_BROWN : C_WRAIN;
    fb.fillRoundRect(x + 16, ty + 14, 216, 8, 4, red ? C_ONRED : C_BORDER);
    if (tp) fb.fillRoundRect(x + 16, ty + 14, max(8, 216 * tp / 100), 8, 4, fc);
  }
}

// ── Screen 2: Victron Energy Flow ──────────────────────────────────────────
//   Shore ──► Inverter ──► AC Loads
//                 ↕
//   Solar ──► Battery  ──► DC Loads
static void eBox(int x, int y, const char* label, bool on, bool center, bool red, uint16_t bg, int h = 132) {
  const int w = 220;
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
  (void)b; fb.setTextColor(red ? C_ONRED : C_ETXT);   // transparent: Diagramm darunter bleibt sichtbar
  fb.drawString(val, x, y);
  if (unit && *unit) {
    int wv = fb.textWidth(val);
    fb.setFont(&fonts::DejaVu18);
    fb.setTextColor(red ? C_ONRED : C_ESUB);
    fb.drawString(unit, x + wv + 6, y);
  }
}

static void eSub(int x, int y, const char* txt, bool on, bool red, uint16_t bg) {
  fb.setTextDatum(textdatum_t::baseline_left);
  fb.setFont(&fonts::DejaVu18);
  (void)bg; (void)on; fb.setTextColor(red ? C_ONRED : C_ESUB);
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

// 10-min-Verlauf als Hintergrund einer Energy-Box (Skala ab 0 W, mind. 10 W), Farben passend zur Boxfarbe
static void eChart(const int16_t* h, int n, int x, int y, int w, int top, int bot, bool on, bool night, bool red, bool soft = false) {
  if (n < 2) return;
  int mx = 10;
  for (int i = 0; i < n; i++) if (h[i] != INT16_MIN) mx = max(mx, (int)h[i]);
  float sc = (bot - top) / (mx * 1.1f);
  uint16_t fillC = night ? (on ? lgfx::color565(96, 0, 0) : lgfx::color565(40, 0, 0)) : (on ? lgfx::color565(40, 120, 210) : lgfx::color565(22, 62, 98));
  uint16_t lineC = red ? C_ONRED : night ? lgfx::color565(150, 0, 0) : (on ? lgfx::color565(150, 195, 240) : lgfx::color565(70, 130, 190));
  if (soft && !red) { fillC = night ? lgfx::color565(60, 0, 0) : (on ? lgfx::color565(32, 112, 202) : lgfx::color565(18, 54, 88)); lineC = night ? lgfx::color565(100, 0, 0) : (on ? lgfx::color565(70, 145, 220) : lgfx::color565(40, 90, 140)); }
  int px = -1, py = -1;
  for (int i = 0; i < n; i++) {
    if (h[i] == INT16_MIN) continue;
    int qx = x + 2 + i * (w - 5) / (n - 1), qy = bot - (int)(max(0, (int)h[i]) * sc);
    if (px >= 0) {
      if (!red) for (int xx = px; xx <= qx; xx++) { int yy = py + (qy - py) * (xx - px) / max(1, qx - px); fb.drawFastVLine(xx, yy, bot - yy, fillC); }
      fb.drawWideLine(px, py, qx, qy, 1, lineC);
    }
    px = qx; py = qy;
  }
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

  // obere Reihe flach (wenig Inhalt), untere Reihe hoch: Platz für MPPT-Liste und weitere Batterien (wie Pro App)
  const int X1 = 20, X2 = 290, X3 = 560, Y1 = 74, Y2 = 220, H1 = 110, H2 = 172;
  auto small = [&](const char* t, int x, int y, textdatum_t d, bool on, bool bright) {   // DejaVu12, Grundlinie y
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(d);
    (void)on; fb.setTextColor(red ? C_ONRED : (bright ? C_ETXT : C_ESUB)); fb.drawString(t, x, y);
  };

  eBox(X1, Y1, "Shore", shoreOn, false, red, bg, H1);
  if (shoreOn) {
    W(s.shoreW); eText(X1 + 14, Y1 + 74, v, "W", &fonts::DejaVu40, true, red, bg);
    if (s.shoreV != NA_I) { snprintf(u, sizeof(u), "%d V", s.shoreV); eSub(X1 + 14, Y1 + 98, u, true, red, bg); }
  } else {
    eText(X1 + 14, Y1 + 72, ok ? "Disconnected" : "--", nullptr, &fonts::DejaVu24, false, red, bg);
  }

  eBox(X2, Y1, "Inverter / Charger", false, true, red, bg, H1);
  fb.setFont(&fonts::DejaVu40);
  const char* st = ok ? s.invSt : "--";
  eText(X2 + 14, Y1 + 74, st, nullptr, fb.textWidth(st) > 192 ? (const lgfx::IFont*)&fonts::DejaVu24 : &fonts::DejaVu40, false, red, bg);
  if (ok && s.invW != NA_I && s.invW != 0) { snprintf(u, sizeof(u), "%d W DC", abs(s.invW)); eSub(X2 + 14, Y1 + 98, u, false, red, bg); }

  eBox(X3, Y1, "AC Loads", acOn, false, red, bg, H1);
  if (ok) eChart(s.acHist, s.acHn, X3, Y1, 220, Y1 + 44, Y1 + H1 - 3, acOn, s.night, red);
  W(s.acW); eText(X3 + 14, Y1 + 74, v, "W", &fonts::DejaVu40, acOn, red, bg);

  // Solar: Leistung + Strom, Ertrag heute/gestern, darunter jeder MPPT mit Name, W, kWh heute
  eBox(X1, Y2, "Solar yield", solarOn, false, red, bg, H2);
  if (ok) eChart(s.pvHist, s.pvHn, X1, Y2, 220, Y2 + 104, Y2 + H2 - 3, solarOn, s.night, red, true);   // unter Tagesertrag, hinter der MPPT-Liste, gedämpft
  W(s.pvW); eText(X1 + 14, Y2 + 70, v, "W", &fonts::DejaVu40, solarOn, red, bg);
  if (ok && !isnan(s.pvA) && s.pvA > 0.05f) {
    snprintf(u, sizeof(u), "%.1f A", s.pvA);
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::baseline_right);
    fb.setTextColor(red ? C_ONRED : C_ETXT); fb.drawString(u, X1 + 206, Y2 + 66);
  }
  if (ok && !isnan(s.pvToday)) {
    if (!isnan(s.pvYest)) snprintf(u, sizeof(u), "Today %.2f - Yest. %.2f kWh", s.pvToday, s.pvYest);
    else snprintf(u, sizeof(u), "Today %.2f kWh", s.pvToday);
    small(u, X1 + 14, Y2 + 90, textdatum_t::baseline_left, solarOn, false);
  }
  if (ok && s.nMppt) {
    fb.drawFastHLine(X1 + 14, Y2 + 97, 192, red ? C_ONRED : C_BOXBRD);
    for (int i = 0; i < s.nMppt && i < 5; i++) {
      const EMppt& m = s.mppt[i];
      int y = Y2 + 111 + i * 13;
      small(m.n, X1 + 14, y, textdatum_t::baseline_left, solarOn, false);
      if (m.w != NA_I) snprintf(u, sizeof(u), "%d W", m.w); else strcpy(u, "--");
      small(u, X1 + 150, y, textdatum_t::baseline_right, solarOn, true);
      if (!isnan(m.kwh)) snprintf(u, sizeof(u), "%.2f kWh", m.kwh); else strcpy(u, "--");
      small(u, X1 + 206, y, textdatum_t::baseline_right, solarOn, false);
    }
  }

  // Batterie: SOC, Status + Restlaufzeit rechts, V/A/W, darunter weitere Batterien
  eBox(X2, Y2, "Battery", false, true, red, bg, H2);
  if (ok && s.batName[0]) small(s.batName, X2 + 206, Y2 + 26, textdatum_t::baseline_right, false, false);
  if (ok && s.batSoc != NA_I) snprintf(v, sizeof(v), "%d", s.batSoc); else strcpy(v, "--");
  eText(X2 + 14, Y2 + 70, v, "%", &fonts::DejaVu40, false, red, bg);
  if (ok) {
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::baseline_right);
    fb.setTextColor(red ? C_ONRED : C_ETXT); fb.drawString(s.batSt, X2 + 206, Y2 + 58);
    if (s.batTtg[0]) small(s.batTtg, X2 + 206, Y2 + 74, textdatum_t::baseline_right, false, false);
    char a[10], w[10];
    if (!isnan(s.batA)) snprintf(a, sizeof(a), "%.1f", s.batA); else strcpy(a, "--");
    if (s.batW != NA_I) snprintf(w, sizeof(w), "%d", s.batW); else strcpy(w, "--");
    snprintf(u, sizeof(u), "%.2fV %sA %sW", isnan(s.batV) ? 0.0f : s.batV, a, w);
    eSub(X2 + 14, Y2 + 96, u, false, red, bg);
    if (s.nEbat) fb.drawFastHLine(X2 + 14, Y2 + 106, 192, red ? C_ONRED : C_BOXBRD);
    for (int i = 0; i < s.nEbat; i++) {
      const EBat& q = s.ebat[i];
      int y = Y2 + 124 + i * 17;
      small(q.n, X2 + 14, y, textdatum_t::baseline_left, false, false);
      char sv[24] = "";
      if (q.soc != NA_I && !isnan(q.v)) snprintf(sv, sizeof(sv), "%d %% - %.2f V", q.soc, q.v);
      else if (!isnan(q.v)) snprintf(sv, sizeof(sv), "%.2f V", q.v);
      small(sv, X2 + 206, y, textdatum_t::baseline_right, false, true);
    }
  }

  eBox(X3, Y2, "DC Loads", dcOn, false, red, bg, H2);
  if (ok) eChart(s.dcHist, s.dcHn, X3, Y2, 220, Y2 + 70, Y2 + H2 - 3, dcOn, s.night, red);
  W(s.dcW); eText(X3 + 14, Y2 + 70, v, "W", &fonts::DejaVu40, dcOn, red, bg);

  eConn(240, Y1 + 55, 50, false, shoreOn, 0, red, now);
  eConn(510, Y1 + 55, 50, false, acOn, 0, red, now);
  eConn(240, Y2 + 58, 50, false, solarOn, 0, red, now);
  eConn(510, Y2 + 58, 50, false, dcOn, 0, red, now);
  eConn(400, Y1 + H1, Y2 - Y1 - H1, true, charging || inverting, inverting ? 1 : 2, red, now);
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
  auto upper = [](const char* in, char* out, size_t n) { strlcpy(out, in, n); for (char* q = out; *q; q++) *q = toupper(*q); };
  auto small2 = [&](int x, int midY, const char* big, const char* sm) {   // Wert DejaVu18 + Zusatz DejaVu12
    fb.setTextDatum(textdatum_t::middle_left); fb.setFont(&fonts::DejaVu18); fb.setTextColor(fg, bg);
    fb.drawString(big, x, midY);
    if (sm && *sm) { int w = fb.textWidth(big); fb.setFont(&fonts::DejaVu12); fb.setTextColor(grey, bg); fb.drawString(sm, x + w + 8, midY + 1); }
  };
  // ── Heute (kompakt)
  for (int i = 0; i < 2; i++) fb.drawRoundRect(12 + i, 72 + i, 776 - 2 * i, 126 - 2 * i, 14 - i, brd);
  if (!online || !s.wOk) {
    centerText(online ? "No weather data" : "--", 400, 135, &fonts::DejaVu24, grey, bg);
  } else {
    const WxDay& t = s.today;
    wxIcon(s.cIc, s.cNight, 64, 126, 92, red, bg);
    snprintf(b, sizeof(b), "updated %s", s.wUpd);
    centerText(b, 64, 186, &fonts::DejaVu12, red ? C_ONRED : (s.wOld ? C_AMBER : C_DIM), bg);
    char dow[4]; upper(t.dow, dow, sizeof(dow));
    snprintf(b, sizeof(b), "TODAY - %s %s", dow, t.date);
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(grey, bg);
    fb.drawString(b, 128, 90);
    drawDeg(126, 156, s.cT, &fonts::DejaVu56, 40, fg, bg);
    fb.fillTriangle(128, 183, 136, 183, 132, 176, grey);
    int xe = drawDeg(140, 185, t.max, &fonts::DejaVu18, 13, grey, bg);
    fb.fillTriangle(xe + 6, 176, xe + 14, 176, xe + 10, 183, grey);
    xe = drawDeg(xe + 18, 185, t.min, &fonts::DejaVu18, 13, grey, bg);
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(fg, bg);
    drawFit(s.cTxt, xe + 12, 185, 430 - xe - 12);
    fb.drawFastVLine(442, 86, 98, brd);
    const int ix = 470, tx = 492;
    iconWind(ix, 92, 20, windC);
    snprintf(b, sizeof(b), "%d kn %s", s.cWs, s.cWd); snprintf(b2, sizeof(b2), "gust %d - max %d", s.cWg, t.ws);
    small2(tx, 92, b, b2);
    iconDrop(ix, 120, 18, dropC);
    snprintf(b, sizeof(b), "%d %%", t.pp);
    if (!isnan(t.ps)) snprintf(b2, sizeof(b2), "%.1f mm", t.ps); else b2[0] = 0;
    small2(tx, 120, b, b2);
    wxSun(ix, 148, 5, 0.42f, red ? C_ONRED : C_WSUN);
    riseSet(tx, 148, t.sr, t.ss, &fonts::DejaVu18, fg, bg);
    moonPhase(ix, 176, 9, s.mp, red);
    riseSet(tx, 176, t.mr, t.ms, &fonts::DejaVu18, fg, bg);
  }
  // ── Tagesverlauf: 4 Abschnitte ab dem aktuellen, der laufende mit hellerem Rahmen
  for (int i = 0; i < 4; i++) {
    const int x = 12 + i * 197, y = 206;
    bool now = i == 0 && online && s.wOk && s.nParts > 0;
    uint16_t pb = red ? C_ONRED : now ? C_GREY : C_BORDER;
    for (int j = 0; j < 2; j++) fb.drawRoundRect(x + j, y + j, 185 - 2 * j, 112 - 2 * j, 12 - j, pb);
    if (!online || !s.wOk || i >= s.nParts) continue;
    const WxPart& q = s.parts[i];
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(fg, bg);
    fb.drawString(q.lbl, x + 12, y + 16);
    if (q.dl[0]) snprintf(b, sizeof(b), "%s %s", q.dl, q.hrs); else strlcpy(b, q.hrs, sizeof(b));
    fb.setTextDatum(textdatum_t::middle_right); fb.setTextColor(grey, bg);
    fb.drawString(b, x + 173, y + 16);
    wxIcon(q.ic, q.night, x + 32, y + 58, 46, red, bg);
    int xe = drawDeg(x + 62, y + 58, q.max, &fonts::DejaVu24, 17, fg, bg);
    if (q.min != q.max) drawDeg(xe + 2, y + 58, q.min, &fonts::DejaVu12, 9, grey, bg);
    iconWind(x + 69, y + 76, 13, windC);
    snprintf(b, sizeof(b), "%d kn %s", q.ws, q.wd);
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(fg, bg);
    fb.drawString(b, x + 79, y + 76);
    snprintf(b2, sizeof(b2), "G%d", q.wg);
    fb.setTextColor(dim, bg);
    fb.drawString(b2, x + 79 + fb.textWidth(b) + 5, y + 76);
    iconDrop(x + 17, y + 97, 11, dropC);
    if (!isnan(q.ps) && q.ps > 0) snprintf(b, sizeof(b), "%d %% - %.1f mm - %s", q.pp, q.ps, q.txt);
    else snprintf(b, sizeof(b), "%d %% - %s", q.pp, q.txt);
    fb.setTextColor(grey, bg); fb.setTextDatum(textdatum_t::middle_left);
    drawFit(b, x + 27, y + 97, 148);
  }
  // ── Nächste 3 Tage (kompakt): Icon, Datum, Max/Min, Wind, Regen
  for (int i = 0; i < 3; i++) {
    const int x = 12 + i * 264, y = 326;
    for (int j = 0; j < 2; j++) fb.drawRoundRect(x + j, y + j, 248 - 2 * j, 66 - 2 * j, 12 - j, brd);
    if (!online || !s.wOk || i >= s.nDays) continue;
    const WxDay& d = s.days[i];
    char dow[4]; upper(d.dow, dow, sizeof(dow));
    wxIcon(d.ic, false, x + 30, y + 33, 40, red, bg);
    snprintf(b, sizeof(b), "%s %s", dow, d.date);
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(grey, bg);
    fb.drawString(b, x + 58, y + 17);
    int xe = drawDeg(x + 162, y + 25, d.max, &fonts::DejaVu18, 13, fg, bg);
    drawDeg(xe, y + 25, d.min, &fonts::DejaVu12, 9, grey, bg);
    iconWind(x + 65, y + 46, 13, windC);
    snprintf(b, sizeof(b), "%d kn %s", d.ws, d.wd);
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(fg, bg);
    fb.drawString(b, x + 75, y + 46);
    int wx2 = x + 75 + fb.textWidth(b) + 5;
    snprintf(b2, sizeof(b2), "G%d", d.wg);
    fb.setTextColor(dim, bg); fb.drawString(b2, wx2, y + 46);
    wx2 += fb.textWidth(b2) + 12;
    iconDrop(wx2, y + 46, 11, dropC);
    if (d.pp != NA_I) snprintf(b, sizeof(b), "%d %%", d.pp); else strcpy(b, "--");
    fb.setTextColor(fg, bg); fb.drawString(b, wx2 + 9, y + 46);
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
static void engValue(int x, int y, const char* v, const char* unit, const char* sub, bool red, uint16_t bg, int maxW = 157) {
  fb.setFont(&fonts::DejaVu18);
  int wu = unit && *unit ? fb.textWidth(unit) + 6 : 0;
  fb.setFont(&fonts::DejaVu40);
  if (fb.textWidth(v) + wu > maxW) fb.setFont(&fonts::DejaVu24);   // z. B. "12345.6 h" → kleiner
  fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(red ? C_ONRED : C_WHITE, bg);
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
// Eckwert in den Ecken der Rundinstrumente (SailSteer, Drehzahlmesser): kleines Label + Wert (+ Einheit), ausgerichtet links oder rechts
static void cornerValue(int x, int y, bool right, const char* lbl, const char* val, const char* unit, bool red, uint16_t bg, bool deg = false) {
  fb.setFont(&fonts::DejaVu12);
  fb.setTextDatum(right ? textdatum_t::top_right : textdatum_t::top_left);
  fb.setTextColor(red ? C_ONRED : C_GREY, bg);
  fb.drawString(lbl, x, y);
  fb.setFont(&fonts::DejaVu24);
  int wv = fb.textWidth(val);
  fb.setFont(&fonts::DejaVu12);
  int wu = unit && *unit ? fb.textWidth(unit) + 4 : 0;
  if (deg) wv += 9;  // Platz für den Grad-Kringel
  int x0 = right ? x - wv - wu : x;
  fb.setFont(&fonts::DejaVu24); fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(red ? C_ONRED : C_WHITE, bg);
  fb.drawString(val, x0, y + 36);
  if (deg) { fb.drawCircle(x0 + wv - 5, y + 36 - 15, 3, red ? C_ONRED : C_WHITE); }
  if (wu) { fb.setFont(&fonts::DejaVu12); fb.setTextColor(red ? C_ONRED : C_GREY, bg); fb.drawString(unit, x0 + wv + 4, y + 36); }
}

static void enginePage(const DashState& s, bool online, bool red, uint16_t bg) {
  for (int i = 0; i < 2; i++) fb.drawRoundRect(12 + i, 72 + i, 376 - 2 * i, 320 - 2 * i, 14 - i, red ? C_ONRED : C_BORDER);
  tacho(s, online, red, bg);
  char v[16], sub[48], u[8];
  // Ecken am Drehzahlmesser: SOG oben links, AWS oben rechts, Wassertemperatur unten links, AWA unten rechts
  if (online && !isnan(s.mSog)) snprintf(v, sizeof(v), "%.1f", s.mSog); else strcpy(v, "--");
  cornerValue(26, 84, false, "SOG", v, "kn", red, bg);
  if (online && !isnan(s.mAws)) snprintf(v, sizeof(v), "%.1f", s.mAws); else strcpy(v, "--");
  cornerValue(374, 84, true, "AWS", v, "kn", red, bg);
  if (online && s.mAwa != NA_I) { snprintf(v, sizeof(v), "%d", abs(s.mAwa)); strcpy(u, s.mAwa < 0 ? "P" : s.mAwa > 0 ? "S" : ""); }
  else { strcpy(v, "--"); u[0] = 0; }
  cornerValue(374, 338, true, "AWA", v, u, red, bg, online && s.mAwa != NA_I);
  if (online && !isnan(s.mWtemp)) snprintf(v, sizeof(v), "%.1f", s.mWtemp); else strcpy(v, "--");
  cornerValue(26, 338, false, "WATER", v, "C", red, bg, online && !isnan(s.mWtemp));
  // TEMP mit Alarm: Warnung orange, Alarm = Box blinkt (unabhängig vom Quittieren, solange zu heiß)
  {
    bool al = online && !strcmp(s.mTst, "alarm"), wr = online && !strcmp(s.mTst, "warn");
    bool flash = al && !red && (millis() / 500) % 2;
    uint16_t tbg = flash ? C_RED_BG : bg;
    if (flash) fb.fillRoundRect(400, 72, 189, 100, 14, C_RED_BG);
    engTile(400, 72, 189, "TEMP", red, tbg);
    if (al || wr) for (int i = 2; i < (al ? 4 : 3); i++) fb.drawRoundRect(400 + i, 72 + i, 189 - 2 * i, 100 - 2 * i, 14 - i, red ? C_ONRED : al ? C_RED : C_AMBER);
    if (al || wr) for (int i = 0; i < 2; i++) fb.drawRoundRect(400 + i, 72 + i, 189 - 2 * i, 100 - 2 * i, 14 - i, red ? C_ONRED : al ? C_RED : C_AMBER);
    snprintf(v, sizeof(v), "max %d C", s.mTalarm);
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_right); fb.setTextColor(red || flash ? C_ONRED : C_DIM, tbg);
    fb.drawString(v, 400 + 189 - 16, 72 + 20);
    engValue(416, 72, "", "", online && s.mTemp != NA_I ? (s.mTempLive ? "coolant" : "last known") : "", red || flash, tbg);
    uint16_t tc = red || flash ? C_ONRED : al ? C_RED : wr ? C_AMBER : C_WHITE;
    int xe = drawDeg(416, 72 + 66, online ? s.mTemp : NA_I, &fonts::DejaVu40, 29, tc, tbg);
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(red || flash ? C_ONRED : C_GREY, tbg);
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

// ── Screen 8: SOS — VHF-Notruf zum Ablesen (MAYDAY / PAN PAN) ──────────────
// Text mit UTF-8-"°": die DejaVu-Fonts haben kein Grad-Zeichen → als kleiner Kringel gezeichnet
static int drawTextDeg(const char* str, int x, int y, const lgfx::IFont* font, uint16_t col, uint16_t bg) {
  char seg[96]; int n = 0;
  fb.setFont(font); fb.setTextDatum(textdatum_t::top_left); fb.setTextColor(col, bg);
  int h = fb.fontHeight();
  for (const char* p = str; ; p++) {
    bool deg = (uint8_t)p[0] == 0xC2 && (uint8_t)p[1] == 0xB0;
    if (deg || !*p || n >= (int)sizeof(seg) - 1) {
      seg[n] = 0;
      if (n) { fb.drawString(seg, x, y); x += fb.textWidth(seg); n = 0; }
      if (deg) { int rr = max(2, h / 9); fb.drawCircle(x + rr + 1, y + rr + 2, rr, col); x += 2 * rr + 4; p++; continue; }
      if (!*p) break;
    }
    seg[n++] = *p;
  }
  return x;
}

static void sosPage(const DashState& s, bool online, bool red, uint16_t bg) {
  // Umschalter MAYDAY / PAN PAN
  btn(12, 72, 384, 44, "MAYDAY", sosPanPan ? C_DIM : C_RED, sosPanPan ? C_GREY : C_WHITE, sosPanPan ? C_BLACK : C_RED_BG, red, bg);
  btn(404, 72, 384, 44, "PAN PAN", sosPanPan ? C_AMBER : C_DIM, sosPanPan ? C_BLACK : C_GREY, sosPanPan ? C_AMBER : C_BLACK, red, bg);
  // Schritt-Tabs
  static const char* tabs[] = {"1 - CALL  >", "2 - POSITION  >", "3 - SITUATION"};
  for (int i = 0; i < 3; i++) {
    int tx = 12 + i * 262, tw = 252;
    bool on = sosStep == i;
    fb.drawRoundRect(tx, 120, tw, 26, 7, red ? C_ONRED : on ? C_WSUN : C_BORDER);
    centerText(tabs[i], tx + tw / 2, 133, &fonts::DejaVu12, red ? C_ONRED : on ? C_WSUN : C_DIM, bg);
  }
  for (int i = 0; i < 2; i++) fb.drawRoundRect(12 + i, 150 + i, 776 - 2 * i, 242 - 2 * i, 12 - i, red ? C_ONRED : C_BORDER);
  // Zeilen des aktuellen Schritts: kind 0 groß, 1 klein (Lautschrift/UTC), 2 Position gelb, 3 Platzhalter orange, 4 mittel, 5 Hinweis
  const char* N = s.sosName[0] ? s.sosName : "SUKI";
  const char* cs = s.sosCs[0] ? s.sosCs : "[CALL SIGN]";
  const char* mm = s.sosMmsi[0] ? s.sosMmsi : "[MMSI]";
  char l[7][80]; uint8_t kind[7]; int n = 0;
  auto add = [&](uint8_t k, const char* t) { if (n < 7) { strlcpy(l[n], t, sizeof(l[n])); kind[n++] = k; } };
  char b[80];
  bool pos = online && s.sosLat[0];
  if (sosStep == 0) {
    if (!sosPanPan) {
      add(5, "1 - Lift red DISTRESS cover, hold 5 s   2 - Channel 16, high power   3 - Read slowly:");
      add(0, "MAYDAY - MAYDAY - MAYDAY");
    } else {
      add(5, "1 - Channel 16, high power   2 - Read slowly   3 - Wait for reply");
      add(0, "PAN PAN - PAN PAN - PAN PAN");
      add(4, "ALL STATIONS - ALL STATIONS - ALL STATIONS");
    }
    snprintf(b, sizeof(b), "THIS IS %s - %s - %s", N, N, N); add(0, b);
    snprintf(b, sizeof(b), "CALL SIGN %s", cs); add(0, b);
    add(1, s.sosPhon);
    snprintf(b, sizeof(b), "MMSI %s", mm); add(sosPanPan ? 4 : 0, b);
  } else if (sosStep == 1) {
    if (!sosPanPan) { snprintf(b, sizeof(b), "MAYDAY %s", N); add(0, b); }
    add(0, "MY POSITION");
    if (pos) { add(2, s.sosLat); add(2, s.sosLon); add(4, s.sosUtc); }   // ausgeschrieben zum Vorlesen
    else add(3, "[READ POSITION FROM PLOTTER]");
  } else {
    if (!sosPanPan) { add(3, "[SINKING / FIRE / MAN OVERBOARD]"); add(0, "I REQUIRE IMMEDIATE ASSISTANCE"); }
    else { add(3, "[ENGINE FAILURE / INJURED CREW]"); add(3, "I REQUIRE [TOW / MEDICAL]"); }
    snprintf(b, sizeof(b), "%d PERSONS ON BOARD", s.sosPob); add(0, b);
    add(4, s.sosDesc);
    add(0, "OVER");
  }
  int y = 156;
  for (int i = 0; i < n; i++) {
    uint8_t k = kind[i];
    uint16_t c = red ? C_ONRED : k == 2 || k == 5 ? C_WSUN : k == 3 ? C_AMBER : k == 1 ? C_GREY : C_WHITE;
    const lgfx::IFont* f = k == 1 || k == 5 ? (const lgfx::IFont*)&fonts::DejaVu12 : k == 4 ? (const lgfx::IFont*)&fonts::DejaVu24 : &fonts::DejaVu40;
    fb.setFont(f);
    if (fb.textWidth(l[i]) > 744 && f == &fonts::DejaVu40) f = &fonts::DejaVu24;   // zu lang → kleiner
    int step = f == &fonts::DejaVu40 ? 42 : f == &fonts::DejaVu24 ? 30 : 18;
    drawTextDeg(l[i], 30, y, f, c, bg);
    y += step;
  }
}

// ── Screen 5: Segeln — B&G-Windanzeige + Rigg-Load (Cyclops) ─────────────
static void windDial(const DashState& s, bool online, bool red, uint16_t bg) {
  const int cx = 200, cy = 232, R = 140;
  auto A = [](float d) { return d - 90.0f; };  // 0° = Bug oben
  auto P = [&](float r, float a, int& x, int& y) { float t = a * PI / 180; x = cx + cosf(t) * r; y = cy + sinf(t) * r; };
  if (!red) fb.fillCircle(cx, cy, R + 4, C_TFACE);
  fb.drawCircle(cx, cy, R + 4, red ? C_ONRED : C_TBEZEL); fb.drawCircle(cx, cy, R + 3, red ? C_ONRED : C_TBEZEL);
  uint16_t face = red ? bg : C_TFACE;
  thickArc(cx, cy, R - 6, A(-s.closeTo), A(-s.closeFrom), 10, red ? C_ONRED : C_RED);
  thickArc(cx, cy, R - 6, A(s.closeFrom), A(s.closeTo), 10, red ? C_ONRED : C_TZG);
  char b[12];
  for (int d = -170; d <= 180; d += 10) {
    bool mj = d % 30 == 0;
    int x0, y0, x1, y1;
    P(R - (mj ? 26 : 18), A(d), x0, y0); P(R - 12, A(d), x1, y1);
    fb.drawWideLine(x0, y0, x1, y1, mj ? 1.5f : 0.7f, red ? C_ONRED : (mj ? C_WHITE : C_DIM));
    if (mj && abs(d) <= 120 && d != 0) {
      int nx, ny; P(R - 42, A(d), nx, ny);
      snprintf(b, sizeof(b), "%d", abs(d));
      centerText(b, nx, ny, &fonts::DejaVu18, red ? C_ONRED : C_GREY, face);
    }
  }
  // Boot (Rumpf als Polygon, Fächer aus Dreiecken)
  static const int8_t hull[][2] = {{0, -36}, {9, -24}, {13, -6}, {13, 10}, {10, 30}, {-10, 30}, {-13, 10}, {-13, -6}, {-9, -24}};
  const int nh = sizeof(hull) / sizeof(hull[0]);
  for (int i = 0; i < nh; i++) {
    int j = (i + 1) % nh;
    if (!red) fb.fillTriangle(cx, cy, cx + hull[i][0], cy + hull[i][1], cx + hull[j][0], cy + hull[j][1], C_TPILL);
    fb.drawLine(cx + hull[i][0], cy + hull[i][1], cx + hull[j][0], cy + hull[j][1], red ? C_ONRED : C_DIM);
  }
  // wahrer Wind: hohles Dreieck
  if (online && s.sTwa != NA_I) {
    int x0, y0, x1, y1, x2, y2;
    P(R - 30, A(s.sTwa), x0, y0); P(R - 4, A(s.sTwa - 5), x1, y1); P(R - 4, A(s.sTwa + 5), x2, y2);
    fb.drawTriangle(x0, y0, x1, y1, x2, y2, red ? C_ONRED : C_TVAL);
  }
  // scheinbarer Wind: Zeiger, rot = Backbord, grün = Steuerbord
  if (online && s.sAwa != NA_I) {
    int tx, ty, lx, ly, rx, ry, bx, by;
    float a = A(s.sAwa);
    P(R - 8, a, tx, ty); P(8, a - 90, lx, ly); P(8, a + 90, rx, ry); P(26, a + 180, bx, by);
    uint16_t nc = red ? C_ONRED : (s.sAwa < 0 ? C_TNDL : C_GREEN);
    fb.fillTriangle(tx, ty, lx, ly, rx, ry, nc);
    fb.fillTriangle(bx, by, lx, ly, rx, ry, nc);
  }
  fb.fillCircle(cx, cy, 9, red ? bg : C_TPILL);
  fb.drawCircle(cx, cy, 9, red ? C_ONRED : C_GREY);
  // AWA oben, AWS unten
  if (online && s.sAwa != NA_I) {
    fb.setFont(&fonts::DejaVu24);
    snprintf(b, sizeof(b), "%d", abs(s.sAwa));
    int w = fb.textWidth(b) + 10 + (s.sAwa ? fb.textWidth(" S") : 0);
    int xe = drawDeg(cx - w / 2, cy - 42, abs(s.sAwa), &fonts::DejaVu24, 17, red ? C_ONRED : C_WHITE, face);
    if (s.sAwa) { fb.setFont(&fonts::DejaVu24); fb.setTextDatum(textdatum_t::baseline_left); fb.drawString(s.sAwa < 0 ? "P" : "S", xe + 2, cy - 42); }
  } else centerText("--", cx, cy - 50, &fonts::DejaVu24, red ? C_ONRED : C_GREY, face);
}

// Windanzeige im Stil des Drehzahlmessers: gleiche Zifferblatt-, Band-, Strich-, Zeiger- und Feldgestaltung,
// Außenband = Am-Wind-Sektoren (einstellbar), Innenbogen = Bug → AWA, Neel-Logo statt Volvo Penta (kein Digitalfeld,
// damit der Zeiger bei Raumwind frei bleibt)
static void windDialTacho(const DashState& s, bool online, bool red, uint16_t bg) {
  const int cx = 200, cy = 232, R = 140;
  auto A = [](float d) { return d - 90.0f; };
  auto P = [&](float r, float a, int& x, int& y) { float t = a * PI / 180; x = cx + cosf(t) * r; y = cy + sinf(t) * r; };
  uint16_t on1 = red ? C_ONRED : 0;
  if (!red) fb.fillCircle(cx, cy, R + 4, C_TFACE);
  fb.drawCircle(cx, cy, R + 4, red ? C_ONRED : C_TBEZEL);
  fb.drawCircle(cx, cy, R + 3, red ? C_ONRED : C_TBEZEL);
  uint16_t face = red ? bg : C_TFACE;
  thickArc(cx, cy, R - 4, A(-s.closeTo), A(-s.closeFrom), 8, red ? on1 : C_RED);
  thickArc(cx, cy, R - 4, A(s.closeFrom), A(s.closeTo), 8, red ? on1 : C_TZG);
  if (!red) thickArc(cx, cy, R - 20, 0, 360, 14, C_TTRACK);
  bool hasAwa = online && s.sAwa != NA_I;
  if (hasAwa && s.sAwa != 0) {
    if (s.sAwa < 0) thickArc(cx, cy, R - 20, A(s.sAwa), A(0), 14, red ? on1 : C_TNDL);
    else thickArc(cx, cy, R - 20, A(0), A(s.sAwa), 14, red ? on1 : C_GREEN);
  }
  char b[12];
  for (int d = -170; d <= 180; d += 10) {
    bool mj = d % 30 == 0;
    int x0, y0, x1, y1;
    P(R - (mj ? 46 : 34), A(d), x0, y0); P(R - 30, A(d), x1, y1);
    fb.drawWideLine(x0, y0, x1, y1, mj ? 2.0f : 0.7f, red ? C_ONRED : (mj ? C_WHITE : C_DIM));
    // Skalenzahl ausblenden, solange die Winkel-Blase an ihr vorbeizieht
    bool near = hasAwa && abs((((d - s.sAwa) % 360) + 540) % 360 - 180) < 22;
    if (mj && d != 0 && abs(d) <= 120 && !near) {
      int nx, ny; P(R - 60, A(d), nx, ny);
      snprintf(b, sizeof(b), "%d", abs(d));
      centerText(b, nx, ny, &fonts::DejaVu18, red ? C_ONRED : C_WHITE, face);
    }
  }
  // Neel-Logo unter der Nabe
  drawAlpha4(LOGO_NEEL, LOGO_NEEL_W, LOGO_NEEL_H, cx - LOGO_NEEL_W / 2, cy + 48, red ? C_ONRED : C_GREY, face);
  // wahrer Wind: hohles Dreieck am Rand
  if (online && s.sTwa != NA_I) {
    int x0, y0, x1, y1, x2, y2;
    P(R - 26, A(s.sTwa), x0, y0); P(R + 2, A(s.sTwa - 5), x1, y1); P(R + 2, A(s.sTwa + 5), x2, y2);
    fb.drawTriangle(x0, y0, x1, y1, x2, y2, red ? C_ONRED : C_TVAL);
  }
  // Zeiger wie beim Drehzahlmesser, Farbe nach Seite
  uint16_t ndl = red ? C_ONRED : (hasAwa && s.sAwa > 0 ? C_GREEN : C_TNDL);
  if (hasAwa) {
    float na = A(s.sAwa);
    int tx, ty, lx, ly, rx, ry, bx, by;
    P(R - 26, na, tx, ty); P(7, na - 90, lx, ly); P(7, na + 90, rx, ry); P(22, na + 180, bx, by);
    fb.fillTriangle(tx, ty, lx, ly, rx, ry, ndl);
    fb.fillTriangle(bx, by, lx, ly, rx, ry, ndl);
  }
  fb.fillCircle(cx, cy, 10, red ? bg : C_TPILL);
  fb.drawCircle(cx, cy, 10, ndl); fb.drawCircle(cx, cy, 9, ndl);
  // Windwinkel als Wertblase an der Zeigerspitze — wandert mit, wird nie vom Zeiger verdeckt
  if (hasAwa) {
    int bx, by; P(R - 26, A(s.sAwa), bx, by);
    snprintf(b, sizeof(b), "%d", abs(s.sAwa));
    fb.setFont(&fonts::DejaVu18);
    int w = fb.textWidth(b) + 7 + (s.sAwa ? fb.textWidth(" S") : 0);
    int bw = max(60, w + 14);   // Blase passt sich der Textbreite an
    if (!red) fb.fillRoundRect(bx - bw / 2, by - 12, bw, 24, 12, C_BLACK);
    fb.drawRoundRect(bx - bw / 2, by - 12, bw, 24, 12, ndl); fb.drawRoundRect(bx - bw / 2 + 1, by - 11, bw - 2, 22, 11, ndl);
    uint16_t bb = red ? bg : C_BLACK;
    int xe = drawDeg(bx - w / 2, by + 6, abs(s.sAwa), &fonts::DejaVu18, 13, red ? C_ONRED : C_WHITE, bb);
    if (s.sAwa) { fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(red ? C_ONRED : C_WHITE, bb); fb.drawString(s.sAwa < 0 ? "P" : "S", xe + 1, by + 6); }
  }
}

static void rigTileDraw(int x, int y, const char* label, float t, const char* st, const DashState& s, bool online, bool red, uint16_t bg) {
  // kompakt (halbe Höhe): Name + Status, Wert, Balken mit Zonen, Grenzmarken
  const int w = 189, h = 104;
  bool al = online && !strcmp(st, "alarm"), wr = online && !strcmp(st, "warn"), ok = online && !strcmp(st, "ok");
  uint16_t col = red ? C_ONRED : al ? C_RED : wr ? C_AMBER : ok ? C_GREEN : C_DIM;
  uint16_t brd = red ? C_ONRED : al ? C_RED : wr ? C_AMBER : C_BORDER;
  for (int i = 0; i < (al ? 4 : 2); i++) fb.drawRoundRect(x + i, y + i, w - 2 * i, h - 2 * i, 14 - i, brd);
  fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(red ? C_ONRED : C_GREY, bg);
  fb.drawString(label, x + 14, y + 16);
  fb.setTextDatum(textdatum_t::middle_right); fb.setTextColor(col, bg);
  fb.drawString(al ? "ALARM" : wr ? "HIGH" : ok ? "OK" : "", x + w - 14, y + 16);  // ohne Daten: nur "--" als Wert
  char b[16];
  bool has = online && !isnan(t);
  if (has) snprintf(b, sizeof(b), "%.2f", t); else strcpy(b, "--");
  fb.setFont(&fonts::DejaVu24); fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(has ? col : (red ? C_ONRED : C_DIM), bg);
  fb.setTextSize(1.4f);
  fb.drawString(b, x + 14, y + 60);
  int wv = fb.textWidth(b);
  fb.setTextSize(1);
  fb.setFont(&fonts::DejaVu18); fb.setTextColor(red ? C_ONRED : C_GREY, bg);
  fb.drawString("t", x + 14 + wv + 5, y + 60);
  const int bx = x + 14, by = y + 70, bw = w - 28, bh = 12;
  float sc = s.rigScale > 0 ? s.rigScale : 5;
  auto px = [&](float v) { return (int)(bw * constrain(v / sc, 0.0f, 1.0f)); };
  int pw = px(s.rigWarn), pa = px(s.rigAlarm);
  if (!red) {
    fb.fillRect(bx, by, pw, bh, C_ZG);
    fb.fillRect(bx + pw, by, pa - pw, bh, C_ZO);
    fb.fillRect(bx + pa, by, bw - pa, bh, C_ZR);
  } else fb.drawRect(bx, by, bw, bh, C_ONRED);
  if (has && px(t) > 0) fb.fillRect(bx, by, px(t), bh, red ? C_ONRED : col);
  snprintf(b, sizeof(b), "%.1f", s.rigWarn);
  centerText(b, bx + pw, by + bh + 9, &fonts::DejaVu9, red ? C_ONRED : C_GREY, bg);
  snprintf(b, sizeof(b), "%.1f", s.rigAlarm);
  centerText(b, bx + pa, by + bh + 9, &fonts::DejaVu9, red ? C_ONRED : C_GREY, bg);
}

static void sailPage(const DashState& s, bool online, bool red, uint16_t bg) {
  for (int i = 0; i < 2; i++) fb.drawRoundRect(12 + i, 72 + i, 376 - 2 * i, 320 - 2 * i, 14 - i, red ? C_ONRED : C_BORDER);
  if (s.classicDial) windDial(s, online, red, bg); else windDialTacho(s, online, red, bg);
  char v[16], u[8];
  // Ecken: SOG links oben, TWA rechts oben, TWS rechts unten, TWD links unten
  const char* tl = s.sTwCalc ? "TWA calc" : "TWA";
  const char* sl2 = s.sTwCalc ? "TWS calc" : "TWS";
  if (online && !isnan(s.sSog)) snprintf(v, sizeof(v), "%.1f", s.sSog); else strcpy(v, "--");
  cornerValue(26, 84, false, "SOG", v, "kn", red, bg);
  if (online && s.sTwa != NA_I) { snprintf(v, sizeof(v), "%d", abs(s.sTwa)); strcpy(u, s.sTwa < 0 ? "P" : "S"); }
  else { strcpy(v, "--"); u[0] = 0; }
  cornerValue(374, 84, true, tl, v, u, red, bg, online && s.sTwa != NA_I);
  if (online && !isnan(s.sTws)) snprintf(v, sizeof(v), "%.1f", s.sTws); else strcpy(v, "--");
  cornerValue(374, 338, true, sl2, v, "kn", red, bg);
  if (online && s.sTwd != NA_I) { snprintf(v, sizeof(v), "%d", s.sTwd); strlcpy(u, card8(s.sTwd), sizeof(u)); }
  else { strcpy(v, "--"); u[0] = 0; }
  cornerValue(26, 338, false, "TWD", v, u, red, bg, online && s.sTwd != NA_I);
  // AWS-Box mit Verlaufsdiagramm (wie die Wind-Kachel auf Screen 1)
  const int ax = 400, ay = 72, aw = 388, ah = 208;
  if (online) histChart(s.sAwsHist, s.sAwsN, ax + 6, aw - 12, ay + 100, ay + ah - 6, true, false, red, bg);
  for (int i = 0; i < 2; i++) fb.drawRoundRect(ax + i, ay + i, aw - 2 * i, ah - 2 * i, 14 - i, red ? C_ONRED : C_BORDER);
  gTransp = true;
  fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(red ? C_ONRED : C_GREY);
  fb.drawString("AWS", ax + 16, ay + 22);
  if (s.sWin) {
    if (s.sWin >= 60) snprintf(v, sizeof(v), "%d h", s.sWin / 60); else snprintf(v, sizeof(v), "%d min", s.sWin);
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_right); fb.setTextColor(red ? C_ONRED : C_DIM);
    fb.drawString(v, ax + aw - 16, ay + 22);
  }
  if (online && !isnan(s.sAws)) snprintf(v, sizeof(v), "%.1f", s.sAws); else strcpy(v, "--");
  fb.setFont(&fonts::DejaVu72); fb.setTextDatum(textdatum_t::baseline_left); fb.setTextColor(red ? C_ONRED : C_WHITE);
  fb.drawString(v, ax + 16, ay + 112);
  int wv = fb.textWidth(v);
  fb.setFont(&fonts::DejaVu24); fb.setTextColor(red ? C_ONRED : C_GREY);
  fb.drawString("kn", ax + 16 + wv + 8, ay + 112);
  char sub[48], m[8];
  if (online && !isnan(s.sAwsMax)) snprintf(m, sizeof(m), "%.1f", s.sAwsMax); else strcpy(m, "--");
  char st[8];
  if (online && !isnan(s.sStw)) snprintf(st, sizeof(st), "%.1f", s.sStw); else strcpy(st, "--");
  snprintf(sub, sizeof(sub), "Max 10' %s kn - STW %s kn", m, st);
  fb.setFont(&fonts::DejaVu18); fb.setTextColor(red ? C_ONRED : C_GREY);
  fb.drawString(sub, ax + 16, ay + 140);
  gTransp = false;
  rigTileDraw(400, 288, "PORT LOAD", s.rigP, s.rigPst, s, online, red, bg);
  rigTileDraw(599, 288, "STBD LOAD", s.rigS, s.rigSst, s, online, red, bg);
}

// ── Screen 7: Anker (Radar-Ansicht, Nord oben, Mitte = Anker) ─────────────
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

// Touch auf dem Anker-Screen (7); gibt true zurück, wenn der Tipp verbraucht wurde
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

// ── AIS (Screen 6): Radar Heading oben (ohne Heading: Nord oben), eigenes Boot in der Mitte, 30-min-Kurslinien ──
static void drawFit(const char* str, int x, int y, int maxW) {   // kürzt Text auf maxW Pixel
  char b[40]; strlcpy(b, str, sizeof(b));
  for (int l = strlen(b); l > 0 && fb.textWidth(b) > maxW; ) b[--l] = 0;
  fb.drawString(b, x, y);
}
static void aisArrow(int x, int y, float deg, float sc, uint16_t c, uint16_t brd) {
  float h = deg * PI / 180;
  auto R = [&](float px, float py, int& ox, int& oy) { ox = x + (px * cosf(h) - py * sinf(h)) * sc; oy = y + (px * sinf(h) + py * cosf(h)) * sc; };
  int x0, y0, x1, y1, x2, y2, x3, y3;
  R(0, -9, x0, y0); R(6, 7, x1, y1); R(0, 4, x2, y2); R(-6, 7, x3, y3);
  fb.fillTriangle(x0, y0, x1, y1, x2, y2, c); fb.fillTriangle(x0, y0, x2, y2, x3, y3, c);
  fb.drawLine(x0, y0, x1, y1, brd); fb.drawLine(x1, y1, x2, y2, brd); fb.drawLine(x2, y2, x3, y3, brd); fb.drawLine(x3, y3, x0, y0, brd);
}
static bool aisShowAck(bool blink, const AisState& a) { return blink && a.alarmKey; }

static void aisPage(const DashState& s, const AisState& a, bool online, bool red, uint16_t bg) {
  char b[48];
  const int MX = 12, MY = 72, MW = 476, MH = 320, cx = MX + MW / 2, cy = MY + MH / 2;
  const float rng = aisRanges[aisRangeIdx], ppm = (MH / 2 - 14) / (rng * 1852);
  for (int i = 0; i < 2; i++) fb.drawRoundRect(MX + i, MY + i, MW - 2 * i, MH - 2 * i, 14 - i, red ? C_ONRED : C_BORDER);
  fb.setClipRect(MX + 2, MY + 2, MW - 4, MH - 4);
  uint16_t ringC = red ? C_ONRED : C_BORDER;
  for (int k = 1; k <= 2; k++) {
    int rr = (MH / 2 - 14) * k / 2;
    dashedCircle(cx, cy, rr, ringC, 3, 5);
    snprintf(b, sizeof(b), "%g NM", rng * k / 2);
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::bottom_left); fb.setTextColor(red ? C_ONRED : C_DIM);
    fb.drawString(b, cx + 4, cy - rr - 2);
  }
  if (online && !isnan(a.thr)) {   // Alarmkreis
    int tr = min(600.0f, a.thr * 1852 * ppm);
    dashedCircle(cx, cy, tr, red ? C_ONRED : C_RED, 6, 5);
  }
  aisPtN = 0;
  bool selFound = false;
  const int up = a.up != NA_I ? a.up : 0;
  const float ur = up * PI / 180, cu = cosf(ur), su = sinf(ur);
  if (online) for (int i = a.nt - 1; i >= 0; i--) {   // gefährlichste zuletzt = oben
    const AisT& t = a.t[i];
    int x = cx + (t.e * cu - t.n * su) * ppm, y = cy - (t.e * su + t.n * cu) * ppm;
    if (x < MX - 10 || x > MX + MW + 10 || y < MY - 10 || y > MY + MH + 10) continue;
    uint16_t c = red ? C_ONRED : t.stale ? C_DIM : t.st == 2 ? C_RED : t.st == 1 ? C_AMBER : C_GREEN;
    bool sel = aisSel[0] && !strcmp(aisSel, t.m);
    if (!isnan(t.sog) && t.sog > 0.5f && t.cog != NA_I) {
      float vl = t.sog * 0.5144f * 1800 * ppm, vr = (t.cog - up) * PI / 180;   // Weg der nächsten 30 min
      fb.drawLine(x, y, x + sinf(vr) * vl, y - cosf(vr) * vl, c);
      aisArrow(x, y, (t.hdg != NA_I ? t.hdg : t.cog) - up, 1, c, red ? bg : C_BLACK);
    } else { fb.fillCircle(x, y, 4, c); fb.drawCircle(x, y, 5, red ? bg : C_BLACK); }
    if (sel) { fb.drawCircle(x, y, 13, red ? C_ONRED : C_WHITE); fb.drawCircle(x, y, 12, red ? C_ONRED : C_WHITE); selFound = true; }
    if (t.st || sel) {
      fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::bottom_left); fb.setTextColor(red ? C_ONRED : C_GREY);
      drawFit(t.nm[0] ? t.nm : t.m, x + 10, y - 6, 110);
    }
    if (aisPtN < 30) { aisPts[aisPtN][0] = x; aisPts[aisPtN][1] = y; strlcpy(aisPtM[aisPtN], t.m, 10); aisPtN++; }
  }
  if (aisSel[0] && !selFound) {   // Auswahl nur halten, solange das Ziel in der Liste ist
    bool inList = false; for (int i = 0; i < a.nt; i++) if (!strcmp(a.t[i].m, aisSel)) inList = true;
    if (!inList) aisSel[0] = 0;
  }
  if (online && !isnan(a.ownSog) && a.ownSog > 0.5f) {   // eigene Kurslinie, 30 min, gestrichelt
    float ol = a.ownSog * 0.5144f * 1800 * ppm, orr = (a.ownCog - up) * PI / 180;
    int ex = cx + sinf(orr) * ol, ey = cy - cosf(orr) * ol;
    float len = hypotf(ex - cx, ey - cy);
    for (float d = 0; d < len; d += 10) {
      float d1 = min(len, d + 6);
      fb.drawLine(cx + (ex - cx) * d / len, cy + (ey - cy) * d / len, cx + (ex - cx) * d1 / len, cy + (ey - cy) * d1 / len, red ? C_ONRED : C_WHITE);
    }
  }
  aisArrow(cx, cy, a.up != NA_I ? 0 : a.ownCog, 1.2f, red ? C_ONRED : C_WHITE, red ? bg : C_BLACK);   // Heading-up: Boot immer nach oben
  // Nordpfeil (gedreht) + N am äußeren Ring
  {
    uint16_t nc = red ? C_ONRED : C_GREY;
    int ax = MX + 26, ay = MY + 28;
    auto R = [&](float px, float py, int& ox, int& oy) { ox = ax + px * cu + py * su; oy = ay - px * su + py * cu; };
    int x0, y0, x1, y1, x2, y2, x3, y3;
    R(0, -12, x0, y0); R(6, 6, x1, y1); R(0, 2, x2, y2); R(-6, 6, x3, y3);
    fb.fillTriangle(x0, y0, x1, y1, x2, y2, nc); fb.fillTriangle(x0, y0, x2, y2, x3, y3, nc);
    centerText("N", ax, ay + 24, &fonts::DejaVu12, nc, bg);
    int nr = MH / 2 - 14, nx = cx - su * nr, ny = cy - cu * nr;
    fb.fillCircle(nx, ny, 9, red ? bg : C_BLACK);
    centerText("N", nx, ny, &fonts::DejaVu12, red ? C_ONRED : C_WHITE, red ? bg : C_BLACK);
    if (a.up != NA_I) snprintf(b, sizeof(b), "%s UP %03d", a.upSrc, up); else strcpy(b, "NORTH UP");
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::bottom_right); fb.setTextColor(red ? C_ONRED : C_GREY);
    if (online) fb.drawString(b, MX + MW - 12, MY + MH - 8);
  }
  // Reichweite +/-
  for (int i = 0; i < 2; i++) {
    int zx = MX + 456, zy = MY + 28 + i * 48;
    fb.fillCircle(zx, zy, 20, red ? bg : C_BLACK);
    fb.drawCircle(zx, zy, 20, red ? C_ONRED : C_DIM); fb.drawCircle(zx, zy, 19, red ? C_ONRED : C_DIM);
    centerText(i ? "-" : "+", zx, zy, &fonts::DejaVu24, red ? C_ONRED : C_WHITE, red ? bg : C_BLACK);
  }
  if (!online) strcpy(b, "");
  else if (!a.own) strcpy(b, "No own position");
  else if (a.alarms) snprintf(b, sizeof(b), "%d targets - range %g NM - %d alarm", a.n, rng, a.alarms);
  else snprintf(b, sizeof(b), "%d targets - range %g NM", a.n, rng);
  fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::bottom_left); fb.setTextColor(red ? C_ONRED : C_GREY);
  fb.drawString(b, MX + 12, MY + MH - 8);
  fb.clearClipRect();

  // ── Panel rechts: Modi
  const int PX = 500, PW = 288;
  static const char* mk[] = {"anchor", "cruising", "offshore"};
  for (int i = 0; i < 3; i++) {
    int bx = PX + i * 98;
    bool on = online && !strcmp(a.mode, mk[i]);
    if (i == 0) strcpy(b, "ANCHOR"); else snprintf(b, sizeof(b), "%s %g", i == 1 ? "CRUISE" : "OFFSHORE", i == 1 ? a.cn : a.on);
    uint16_t oc = i == 2 ? C_BLUE : i == 0 ? C_WHITE : C_GREEN;
    uint16_t bc = on ? oc : C_BORDER, tc = on ? oc : C_GREY;
    if (red) bc = tc = C_ONRED;
    for (int k = 0; k < 2; k++) fb.drawRoundRect(bx + k, 72 + k, 92 - 2 * k, 40 - 2 * k, 9 - k, bc);
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_center); fb.setTextColor(tc, bg);
    fb.drawString(b, bx + 46, 92);
  }
  // Info-Box
  bool ack = online && aisShowAck(s.blink, a);
  const int IY = 120, IH = ack ? 214 : 272;
  for (int k = 0; k < 2; k++) fb.drawRoundRect(PX + k, IY + k, PW - 2 * k, IH - 2 * k, 12 - k, red ? C_ONRED : C_BORDER);
  const AisT* sel = nullptr;
  if (aisSel[0]) for (int i = 0; i < a.nt; i++) if (!strcmp(a.t[i].m, aisSel)) sel = &a.t[i];
  uint16_t lc = red ? C_ONRED : C_GREY, vc = red ? C_ONRED : C_WHITE;
  if (sel && online) {
    fb.setFont(&fonts::DejaVu18); fb.setTextDatum(textdatum_t::top_left); fb.setTextColor(vc, bg);
    if (sel->nm[0]) drawFit(sel->nm, PX + 12, IY + 9, PW - 24); else { snprintf(b, sizeof(b), "MMSI %s", sel->m); drawFit(b, PX + 12, IY + 9, PW - 24); }
    char v[10][28];
    const char* k[10] = {"MMSI", "Call sign", "Type", "Length", "Status", "Destination", "SOG / COG", "Dist / Brg", "CPA", "Last report"};
    strlcpy(v[0], sel->m, 28); strlcpy(v[1], sel->cs[0] ? sel->cs : "--", 28); strlcpy(v[2], sel->ty[0] ? sel->ty : "--", 28);
    if (sel->len != NA_I) snprintf(v[3], 28, "%d m", sel->len); else strcpy(v[3], "--");
    strlcpy(v[4], sel->nav[0] ? sel->nav : "--", 28); strlcpy(v[5], sel->dest[0] ? sel->dest : "--", 28);
    if (!isnan(sel->sog)) snprintf(v[6], 28, "%.1f kn / %d", sel->sog, sel->cog != NA_I ? sel->cog : 0); else strcpy(v[6], "--");
    if (!isnan(sel->d)) snprintf(v[7], 28, "%.2f NM / %d", sel->d, sel->b != NA_I ? sel->b : 0); else strcpy(v[7], "--");
    if (!isnan(sel->cpa)) { if (!isnan(sel->tcpa)) snprintf(v[8], 28, "%.2f NM in %d min", sel->cpa, (int)lroundf(sel->tcpa)); else snprintf(v[8], 28, "%.2f NM", sel->cpa); } else strcpy(v[8], "--");
    snprintf(v[9], 28, "%d s ago", sel->age);
    int lh = ack ? 18 : 22, y0 = IY + 38 + lh / 2;
    for (int i = 0; i < 10; i++) {
      int y = y0 + i * lh;
      fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(lc, bg);
      fb.drawString(k[i], PX + 12, y);
      fb.setTextDatum(textdatum_t::middle_right);
      fb.setTextColor(i == 8 && sel->st == 2 && !red ? C_RED : vc, bg);
      fb.setFont(&fonts::DejaVu12);
      int w = fb.textWidth(v[i]);
      if (w > 170) { char c[28]; strlcpy(c, v[i], 28); for (int l = strlen(c); l > 0 && fb.textWidth(c) > 170; ) c[--l] = 0; fb.drawString(c, PX + PW - 12, y); }
      else fb.drawString(v[i], PX + PW - 12, y);
    }
  } else {
    fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::top_left); fb.setTextColor(red ? C_ONRED : C_DIM, bg);
    fb.drawString(online ? "CLOSEST - TAP FOR DETAILS" : "", PX + 12, IY + 10);
    int rows = ack ? 7 : 9;
    for (int i = 0; online && i < a.nt && i < rows; i++) {
      const AisT& t = a.t[i];
      int y = IY + 40 + i * 26;
      uint16_t c = red ? C_ONRED : t.st == 2 ? C_RED : t.st == 1 ? C_AMBER : C_WHITE;
      fb.setFont(&fonts::DejaVu12); fb.setTextDatum(textdatum_t::middle_left); fb.setTextColor(c, bg);
      drawFit(t.nm[0] ? t.nm : t.m, PX + 12, y, 118);
      if (!isnan(t.tcpa)) snprintf(b, sizeof(b), "%.2f NM - CPA %.2f", t.d, t.cpa); else snprintf(b, sizeof(b), "%.2f NM", t.d);
      fb.setTextDatum(textdatum_t::middle_right);
      fb.drawString(b, PX + PW - 12, y);
    }
  }
  if (ack) btn(PX, 342, PW, 50, "ACKNOWLEDGE ALARM", red ? C_ONRED : C_RED, C_WHITE, red ? bg : C_RED_BG, red, bg);
}

// Touch auf dem AIS-Screen; true = Tipp verbraucht
static bool aisTouch(int tx, int ty) {
  AisState* a = &aisR;   // aisR wird nur vom Loop-Task (= hier) geschrieben
  xSemaphoreTake(sMutex, portMAX_DELAY); bool blink = S.blink; xSemaphoreGive(sMutex);
  const int MX = 12, MY = 72, PX = 500;
  for (int i = 0; i < 2; i++) {   // Reichweite
    int zx = MX + 456, zy = MY + 28 + i * 48;
    if ((tx - zx) * (tx - zx) + (ty - zy) * (ty - zy) < 26 * 26) {
      aisRangeIdx = constrain(aisRangeIdx + (i ? 1 : -1), 0, 7);
      return true;
    }
  }
  if (tx < MX + 476) {            // Ziel antippen (nächstes innerhalb 24 px), sonst Auswahl aufheben
    int best = -1, bd = 24 * 24;
    for (int i = 0; i < aisPtN; i++) {
      int d = (aisPts[i][0] - tx) * (aisPts[i][0] - tx) + (aisPts[i][1] - ty) * (aisPts[i][1] - ty);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) strlcpy(aisSel, aisPtM[best], sizeof(aisSel)); else aisSel[0] = 0;
    return true;
  }
  if (tx < PX) return false;
  if (ty >= 72 && ty < 114) {     // Modus
    static const char* mk[] = {"anchor", "cruising", "offshore"};
    int i = constrain((tx - PX) / 98, 0, 2);
    if (!aisModePending) { strlcpy(aisModeReq, mk[i], sizeof(aisModeReq)); aisModePending = true; strlcpy(aisR.mode, mk[i], sizeof(aisR.mode)); }
    return true;
  }
  if (aisShowAck(blink, *a) && ty >= 338) { ackRequested = true; localAckMs = millis(); return true; }
  if (ty >= 120 && ty < 392) {    // Info-Box: Zeile → Details, in Details → zurück zur Liste
    if (aisSel[0]) aisSel[0] = 0;
    else {
      int i = (ty - 120 - 27) / 26, rows = aisShowAck(blink, *a) ? 7 : 9;
      if (i >= 0 && i < rows && i < a->nt) strlcpy(aisSel, a->t[i].m, sizeof(aisSel));
    }
    return true;
  }
  return false;
}

// „Off“-Screen, wenn die anderen Screens nachts zu hell sind: nur Uhrzeit lokal + UTC, sehr dunkel
static void offPage(const DashState& s, bool online) {
  fb.fillScreen(C_BLACK);
  uint16_t c1 = s.night ? lgfx::color565(58, 0, 0) : lgfx::color565(58, 58, 58);
  uint16_t c2 = s.night ? lgfx::color565(38, 0, 0) : lgfx::color565(38, 38, 38);
  centerText(online ? s.time : "--:--", 400, 228, &fonts::DejaVu40, c1, C_BLACK);
  if (online && s.utc[0]) { char b[16]; snprintf(b, sizeof(b), "UTC %s", s.utc); centerText(b, 400, 266, &fonts::DejaVu18, c2, C_BLACK); }
  fb.pushSprite(0, 0);
}

static void render(const DashState& s, bool online, bool redPhase) {
  if (offMode) { offPage(s, online); return; }
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
  // Off-Knopf (Power-Symbol) rechts vom Rettungsring, Touch-Zone x 181..239 → „Off“-Screen
  {
    const int ox = 209, oy = 36;
    uint16_t c = red ? C_ONRED : C_DIM;
    fb.drawCircle(ox, oy, 23, c); fb.drawCircle(ox, oy, 22, c);
    uint16_t ic = red ? C_ONRED : C_GREY;
    thickArc(ox, oy, 9, 310, 590, 3, ic);
    fb.drawWideLine(ox, oy - 12, ox, oy - 2, 1.4f, ic);
  }
  // SOS-Knopf (Rettungsring) rechts daneben, Touch-Zone x 125..181 → springt auf den Notruf-Screen
  {
    const int sx = 151, sy = 36;
    uint16_t c = red ? C_ONRED : (page == 8 ? C_WHITE : C_DIM);
    fb.drawCircle(sx, sy, 23, c); fb.drawCircle(sx, sy, 22, c);
    thickArc(sx, sy, 9, 0, 360, 6, red ? C_ONRED : C_WHITE);
    for (int q = 0; q < 4; q++) thickArc(sx, sy, 9, q * 90 + 22.5f, q * 90 + 67.5f, 6, red ? bg : C_RED);
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

  // quittiert: rot → orange, bis der Zustand weg ist (ein neuer Alarm blinkt wieder rot)
  const bool ackd = online && !strcmp(s.status, "alarm") && s.acked && !s.blink;
  const char* status = !online || ackd ? "warn" : s.status;
  const char* label = !online ? (WiFi.status() == WL_CONNECTED ? "OFFLINE" : "NO WIFI")
                      : ackd ? "ACKNOWLEDGED"
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
  // Linke Spalte: Batterie + alle Tanks in einer Box
  supplyTile(s, online, red, bg);

  // Kachel Wind
  {
    const int x = 276, cx = x + 124;
    bool al = online && !strcmp(s.windSt, "alarm");
    if (online) histChart(s.windHist, s.windN, x + 6, 236, 72 + 120, 72 + 314, true, al, red, bg);
    // Solarleistung: Sonne scheint von der oberen rechten Ecke in die Box, Strahlen wachsen mit der Leistung;
    // ohne Ertrag (≤ 5 W, z. B. nachts) oder ohne Daten verschwindet sie
    if (online && s.eOk && s.pvW != NA_I && s.pvW > 5) {
      const int sx = x + 246, sy = 74;
      int pw = online && s.eOk ? s.pvW : NA_I;
      bool on = pw != NA_I && pw > 5;
      float k = pw == NA_I ? 0 : constrain(pw / 1500.0f, 0.0f, 1.0f);
      uint16_t sc = red ? C_ONRED : on ? C_WSUN : C_DIM;
      fb.setClipRect(x + 2, 74, 244, 316);
      if (on && !red) fb.fillCircle(sx, sy, 30 + 8 * k, lgfx::color565(s.night ? 40 : 56, s.night ? 0 : 42, 0));   // Lichtschein
      for (float a = 100; a <= 170.1f; a += 17.5f) {
        float t = a * PI / 180, r1 = 40 + 22 * k;
        fb.drawWideLine(sx + cosf(t) * 30, sy + sinf(t) * 30, sx + cosf(t) * r1, sy + sinf(t) * r1, 1.5f, sc);
      }
      fb.fillCircle(sx, sy, 22, sc);
      fb.clearClipRect();
      for (int dy = 0; dy < 14; dy++)   // Ecke außerhalb des abgerundeten Rahmens wieder freiräumen
        for (int dx = 0; dx < 14; dx++)
          if (dx * dx + dy * dy > 13 * 13) fb.drawPixel(x + 234 + dx, 72 + 13 - dy, bg);
      char pb[12];
      if (pw == NA_I) strcpy(pb, "--"); else snprintf(pb, sizeof(pb), "%d", pw);
      fb.setFont(&fonts::DejaVu12); int wu = fb.textWidth("W");
      fb.setTextDatum(textdatum_t::baseline_right); fb.setTextColor(sc, bg);
      fb.drawString("W", x + 234, 72 + 66);
      fb.setFont(&fonts::DejaVu18); fb.drawString(pb, x + 232 - wu, 72 + 66);
    }
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
  } else if (page == 5) {
    sailPage(s, online, red, bg);
  } else if (page == 7) {
    anchorPage(s, online, red, bg);
  } else if (page == 6) {
    aisPage(s, aisR, online, red, bg);
  } else {
    sosPage(s, online, red, bg);
  }

  // Fußzeile: Alarm-/Warntexte
  const char* msg = !online ? (WiFi.status() == WL_CONNECTED ? "No connection to Node-RED" : "Connecting to WiFi ...")
                    : s.msg;
  uint16_t mcol = red ? C_ONRED : (online && !strcmp(s.status, "alarm") && !ackd ? C_RED : C_AMBER);
  fb.setFont(&fonts::DejaVu24);
  const lgfx::IFont* mf = fb.textWidth(msg) > 768 ? (const lgfx::IFont*)&fonts::DejaVu18 : &fonts::DejaVu24;
  centerText(msg, 400, 418, mf, mcol, bg);
  const char* hint = online && s.blink ? "Tap to acknowledge" : (online && s.acked ? "Acknowledged" : "");
  centerText(hint, 400, 446, &fonts::DejaVu18, red ? C_ONRED : C_GREY, bg);

  // Seiten-Punkte
  for (int i = 0; i < 8; i++)
    fb.fillCircle(351 + i * 14, 470, 4, red ? C_ONRED : (page == i + 1 ? C_GREY : C_BORDER));

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

  Serial.printf("DashState %u B, AisState %u B\n", (unsigned)sizeof(DashState), (unsigned)sizeof(AisState));   // Stack-Budget im Blick
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
    if (offMode) {                                   // Off-Screen: jeder Tipp → Startbildschirm
      offMode = false; page = 1; showSettings = false; dataRev++; t0x = -1; wasDown = down;
      return;
    }
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
      page = constrain(page + (dx < 0 ? 1 : -1), 1, 8);
      dataRev++;  // sofort neu zeichnen
    } else if (page == 7 && !showSettings && t0y >= 72 && t0y <= 392 && anchorTouch(t0x, t0y)) {
      dataRev++;
    } else if (page == 6 && !showSettings && t0y >= 72 && t0y <= 392 && aisTouch(t0x, t0y)) {
      dataRev++;
    } else if (t0x >= 181 && t0x < 239 && t0y < 72 && abs(dx) <= 120) {
      offMode = true; showSettings = false; dataRev++;            // Power-Knopf → Off-Screen
    } else if (t0x >= 125 && t0x < 181 && t0y < 72) {
      page = 8; sosStep = 0; showSettings = false; dataRev++;    // Rettungsring → Notruf-Screen
    } else if (page == 8 && !showSettings && t0y >= 68 && t0y < 118) {
      sosPanPan = t0x >= 400; sosStep = 0; dataRev++;             // MAYDAY | PAN PAN
    } else if (page == 8 && !showSettings && t0y >= 118 && t0y < 148) {
      sosStep = constrain((t0x - 12) / 262, 0, 2); dataRev++;     // Schritt-Tabs
    } else if (page == 8 && !showSettings && t0y >= 148 && t0y <= 392) {
      sosStep = (sosStep + 1) % 3; dataRev++;                     // Tipp auf den Text → nächster Schritt
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
    bool b = S.blink, rigOnly = S.rigOnlyAlarm, engOnly = S.engOnlyAlarm, aisOnly = AIS.onlyAlarm;
    xSemaphoreGive(sMutex);
    // neuer Alarm → Übersicht, reine Rigg-Alarme → Segel-Screen, reine AIS-Alarme → AIS-Screen
    // nie vom SOS-Screen wegspringen — wer gerade einen Notruf abliest, darf nicht unterbrochen werden
    if (b && offMode) { offMode = false; dataRev++; if (page == 8) page = 1; }   // Alarm weckt das Display (auch ein schon laufender)
    if (b && !wasBlink && page != 8) { int tgt = aisOnly ? 6 : rigOnly ? 5 : engOnly ? 4 : 1; if (page != tgt || showSettings) { page = tgt; showSettings = false; dataRev++; } }
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
    { char md[10]; bool keep = aisModePending; strlcpy(md, aisR.mode, sizeof(md)); aisR = AIS; if (keep) strlcpy(aisR.mode, md, sizeof(md)); }
    xSemaphoreGive(sMutex);
    if (localAckMs && now - localAckMs < 3000) s.blink = false;
    if (localNightMs && now - localNightMs < 3000) s.night = localNightVal;
    render(s, online, phase);
    lastRev = dataRev; lastPhase = phase; lastOnline = online; lastFrame = now;
  }
  delay(20);
}
