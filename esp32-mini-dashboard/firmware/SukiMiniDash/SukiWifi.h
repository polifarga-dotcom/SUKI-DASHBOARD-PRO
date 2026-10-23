// SukiWifi.h — WLAN-Verwaltung für die SUKI-ESP32-Displays (Mini Dash 7", Cabin Watch 3,5").
// Identische Kopie in beiden Sketch-Ordnern halten (esp32-mini-dashboard/…/SukiMiniDash, esp32-cabin-watch/…/CabinWatch).
//
// - 2 Netze, je DHCP oder feste IP; gespeichert im NVS (Preferences "sukiwifi"), Defaults aus secrets.h
// - Abgleich mit Node-RED: GET  {dash}/wifi/device?dev=…  (jede Minute, meldet dabei den Status)
//                          POST {dash}/wifi  {source:'device', …}  (lokale Änderung / erste Meldung)
//   Höchste Revision gewinnt; neue Einstellungen aus Node-RED laufen auf Probe: ohne Verbindung
//   nach 120 s → zurück zu den letzten funktionierenden (und Node-RED bekommt das mitgeteilt).
// - Kein Netz für 60 s → eigenes Einrichtungs-WLAN (AP) mit Captive Portal auf 192.168.4.1.
// - Webseite /wifi läuft immer auf dem Gerät (im Boots-WLAN unter dessen IP, im AP unter 192.168.4.1).
// Alle Funktionen nur aus EINEM Task aufrufen (Netz-Task); Abfragen (connected/apActive/…) sind threadsicher genug.
#pragma once
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>

namespace sw {

struct Net { char ssid[33]; char pass[65]; bool dhcp; char ip[16], gw[16], mask[16], dns[16]; };
struct Cfg { uint32_t rev; Net net[2]; };

static const char* AP_PASS = "sukisetup";
static const uint32_t AP_AFTER_MS = 60000, PROBATION_MS = 120000, SYNC_MS = 60000;

static Cfg cfg, prevCfg;
static const char* devId = "dev";
static char apName[33];
static WebServer* web = nullptr;
static DNSServer dns;
static volatile bool staUp = false, apUp = false;
static bool pushPending = false, probation = false, reconnectReq = false, haveNode = false, forceTry = false;
static char pushNote[64] = "";
static uint32_t downSince = 0, upSince = 0, probationSince = 0, lastSync = 0, connStart = 0, retryAt = 0;
static int curNet = -1;
enum St : uint8_t { IDLE, SCANNING, CONNECTING, UP };
static St st = IDLE;
static char statusLine[96] = "";
// optional vom Sketch gesetzt (z. B. Firmware-Update): zusätzliche Query-Parameter für /wifi/device und Auswertung der Antwort
static String (*syncExtra)() = nullptr;
static void (*syncReply)(JsonVariantConst) = nullptr;

static bool validIp(const char* s) { IPAddress a; return s && *s && a.fromString(s); }

static void setNet(Net& n, const char* ssid, const char* pass) {
  memset(&n, 0, sizeof(n));
  strlcpy(n.ssid, ssid ? ssid : "", sizeof(n.ssid)); strlcpy(n.pass, pass ? pass : "", sizeof(n.pass));
  n.dhcp = true; strcpy(n.mask, "255.255.255.0");
}
static void defaults(Cfg& c) {
  memset(&c, 0, sizeof(c));
  setNet(c.net[0], WIFI_SSID, WIFI_PASS);
#ifdef WIFI_SSID2
  setNet(c.net[1], WIFI_SSID2, WIFI_PASS2);
#else
  setNet(c.net[1], "", "");
#endif
}

static void toJson(const Cfg& c, JsonObject o, bool withPass) {
  o["rev"] = c.rev;
  JsonArray a = o["nets"].to<JsonArray>();
  for (const Net& n : c.net) {
    JsonObject j = a.add<JsonObject>();
    j["ssid"] = n.ssid; if (withPass) j["pass"] = n.pass;
    j["dhcp"] = n.dhcp; j["ip"] = n.ip; j["gw"] = n.gw; j["mask"] = n.mask; j["dns"] = n.dns;
  }
}
// Gibt false zurück, wenn etwas ungültig ist (err wird gefüllt)
static bool fromJson(JsonVariantConst o, Cfg& c, String& err) {
  Cfg t = c;
  t.rev = o["rev"] | c.rev;
  JsonArrayConst a = o["nets"].as<JsonArrayConst>();
  for (int i = 0; i < 2; i++) {
    JsonVariantConst j = a[i];
    if (j.isNull()) { setNet(t.net[i], "", ""); continue; }
    Net& n = t.net[i];
    strlcpy(n.ssid, j["ssid"] | "", sizeof(n.ssid));
    if (!j["pass"].isNull()) strlcpy(n.pass, j["pass"] | "", sizeof(n.pass));
    n.dhcp = j["dhcp"] | true;
    strlcpy(n.ip, j["ip"] | "", sizeof(n.ip)); strlcpy(n.gw, j["gw"] | "", sizeof(n.gw));
    strlcpy(n.mask, j["mask"] | "255.255.255.0", sizeof(n.mask)); strlcpy(n.dns, j["dns"] | "", sizeof(n.dns));
    // feste IP: leeres Gateway → x.x.x.1, leere Maske → /24 (DNS leer = Gateway, siehe beginNet)
    if (!n.dhcp && validIp(n.ip)) {
      if (!n.gw[0]) { IPAddress ip; ip.fromString(n.ip); snprintf(n.gw, sizeof(n.gw), "%d.%d.%d.1", ip[0], ip[1], ip[2]); }
      if (!n.mask[0]) strcpy(n.mask, "255.255.255.0");
    }
    size_t pl = strlen(n.pass);
    if (n.ssid[0] && pl && (pl < 8 || pl > 63)) { err = "Network " + String(i + 1) + ": password must be 8-63 characters"; return false; }
    if (n.ssid[0] && !n.dhcp && (!validIp(n.ip) || !validIp(n.gw) || !validIp(n.mask))) {
      err = "Network " + String(i + 1) + ": fixed IP needs a valid IP address (e.g. 192.168.0.10)"; return false;
    }
  }
  if (!t.net[0].ssid[0] && !t.net[1].ssid[0]) { err = "At least one network is required"; return false; }
  c = t;
  return true;
}

static void save(const char* key, const Cfg& c) {
  JsonDocument d; toJson(c, d.to<JsonObject>(), true);
  String s; serializeJson(d, s);
  Preferences p; p.begin("sukiwifi", false); p.putString(key, s); p.end();
}
static bool load(const char* key, Cfg& c) {
  Preferences p; p.begin("sukiwifi", true); String s = p.getString(key, ""); p.end();
  if (!s.length()) return false;
  JsonDocument d; if (deserializeJson(d, s)) return false;
  Cfg t; defaults(t); String err;
  if (!fromJson(d.as<JsonVariantConst>(), t, err)) return false;
  c = t; return true;
}
static void persistFlags() { Preferences p; p.begin("sukiwifi", false); p.putBool("push", pushPending); p.putBool("prob", probation); p.end(); }

// ── Webseite auf dem Gerät ───────────────────────────────────────────────────
static String esc(const char* s) {
  String o; for (; *s; s++) { if (*s == '<') o += "&lt;"; else if (*s == '"') o += "&quot;"; else if (*s == '&') o += "&amp;"; else o += *s; } return o;
}
static void pageWifi(const String& msg = "") {
  String h = F("<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
               "<title>SUKI WiFi</title><style>body{margin:0;background:#000;color:#eee;font-family:-apple-system,Arial,sans-serif;padding:16px}"
               "main{max-width:520px;margin:0 auto}h1{font-size:21px}h2{font-size:14px;color:#00d000;letter-spacing:2px;margin:20px 0 6px}"
               "label{display:block;margin:10px 0 4px;color:#aaa;font-size:13px}input,select{width:100%;box-sizing:border-box;background:#111;color:#fff;"
               "border:1px solid #333;border-radius:8px;padding:9px;font-size:16px}button{margin-top:18px;background:#00a000;color:#fff;border:0;"
               "border-radius:8px;padding:12px 18px;font-size:16px;font-weight:bold}.st{color:#aaa;font-size:14px}.msg{color:#ffb300;margin:10px 0}"
               ".row{display:flex;gap:8px}.row>div{flex:1}</style></head><body><main>");
  h += "<h1>SUKI " + esc(apName) + " – WiFi</h1><div class=st>" + esc(statusLine) + "</div>";
  if (msg.length()) h += "<div class=msg>" + esc(msg.c_str()) + "</div>";
  h += F("<form method=post action='/wifi'>");
  for (int i = 0; i < 2; i++) {
    const Net& n = cfg.net[i]; String k = String(i);
    h += "<h2>NETWORK " + String(i + 1) + (i ? " (optional)" : "") + "</h2>";
    h += "<label>SSID</label><input name=s" + k + " maxlength=32 value=\"" + esc(n.ssid) + "\">";
    h += "<label>Password (empty = unchanged)</label><input name=p" + k + " type=password maxlength=63 placeholder='" + (n.pass[0] ? "unchanged" : "none") + "'>";
    h += "<label>IP address</label><select name=d" + k + " onchange=\"document.getElementById('x" + k + "').style.display=this.value=='1'?'none':'block'\">";
    h += String("<option value=1") + (n.dhcp ? " selected" : "") + ">DHCP (automatic)</option><option value=0" + (n.dhcp ? "" : " selected") + ">Fixed IP</option></select>";
    h += "<div id=x" + k + " style='display:" + (n.dhcp ? "none" : "block") + "'><div class=row><div><label>IP</label><input name=i" + k + " value=\"" + esc(n.ip) + "\" placeholder='192.168.0.240'></div>";
    h += "<div><label>Gateway</label><input name=g" + k + " value=\"" + esc(n.gw) + "\" placeholder='automatic (x.x.x.1)'></div></div>";
    h += "<div class=row><div><label>Subnet mask</label><input name=m" + k + " value=\"" + esc(n.mask) + "\"></div>";
    h += "<div><label>DNS</label><input name=n" + k + " value=\"" + esc(n.dns) + "\" placeholder='= gateway'></div></div></div>";
  }
  h += F("<button>Save &amp; connect</button></form><p class=st>Also editable in the Node-RED settings page (WiFi section).</p></main></body></html>");
  web->sendHeader("Cache-Control", "no-store");
  web->send(200, "text/html; charset=utf-8", h);
}
static void handlePost() {
  JsonDocument d; JsonObject o = d.to<JsonObject>();
  o["rev"] = cfg.rev;
  JsonArray a = o["nets"].to<JsonArray>();
  for (int i = 0; i < 2; i++) {
    String k = String(i);
    JsonObject j = a.add<JsonObject>();
    j["ssid"] = web->arg("s" + k);
    String p = web->arg("p" + k);
    if (p.length()) j["pass"] = p;
    else if (web->arg("s" + k) == cfg.net[i].ssid) j["pass"] = cfg.net[i].pass;   // unverändert
    else j["pass"] = "";
    j["dhcp"] = web->arg("d" + k) != "0";
    j["ip"] = web->arg("i" + k); j["gw"] = web->arg("g" + k); j["mask"] = web->arg("m" + k); j["dns"] = web->arg("n" + k);
  }
  Cfg t = cfg; String err;
  if (!fromJson(d.as<JsonVariantConst>(), t, err)) { pageWifi("Not saved: " + err); return; }
  cfg = t; save("cfg", cfg); save("good", cfg);   // lokal eingegeben = vom Nutzer bestätigt, keine Probezeit
  probation = false; pushPending = true; strcpy(pushNote, "changed on device"); persistFlags();
  reconnectReq = true;
  pageWifi("Saved. The display now connects with the new settings.");
}

static void startWeb() {
  if (web) return;
  web = new WebServer(80);
  web->on("/", HTTP_GET, []() { pageWifi(); });
  web->on("/wifi", HTTP_GET, []() { pageWifi(); });
  web->on("/wifi", HTTP_POST, handlePost);
  web->onNotFound([]() {   // Captive Portal: alles auf die WLAN-Seite umleiten
    web->sendHeader("Location", String("http://") + (apUp ? WiFi.softAPIP().toString() : WiFi.localIP().toString()) + "/wifi");
    web->send(302, "text/plain", "");
  });
  web->begin();
}

static void startAp() {
  if (apUp) return;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName, AP_PASS);
  dns.start(53, "*", WiFi.softAPIP());
  apUp = true;
  Serial.printf("[wifi] setup AP '%s' started, http://%s\n", apName, WiFi.softAPIP().toString().c_str());
}
static void stopAp() {
  if (!apUp) return;
  dns.stop(); WiFi.softAPdisconnect(true); WiFi.mode(WIFI_STA);
  apUp = false;
  Serial.println("[wifi] setup AP stopped");
}

// ── Verbindungsaufbau ────────────────────────────────────────────────────────
static void beginNet(int i, int32_t ch = 0, const uint8_t* bssid = nullptr) {
  const Net& n = cfg.net[i];
  if (n.dhcp) WiFi.config(INADDR_NONE, INADDR_NONE, INADDR_NONE);
  else {
    IPAddress ip, gw, mask, d;
    ip.fromString(n.ip); gw.fromString(n.gw); mask.fromString(n.mask);
    if (!d.fromString(n.dns)) d = gw;
    WiFi.config(ip, gw, mask, d);
  }
  WiFi.begin(n.ssid, n.pass[0] ? n.pass : nullptr, ch, bssid);
  curNet = i; connStart = millis(); st = CONNECTING;
  Serial.printf("[wifi] connecting '%s' (%s)\n", n.ssid, n.dhcp ? "DHCP" : n.ip);
}

static void begin(const char* dev, const char* displayName) {
  devId = dev;
  strlcpy(apName, displayName, sizeof(apName));
  defaults(cfg);
  load("cfg", cfg);
  if (!load("good", prevCfg)) prevCfg = cfg;
  Preferences p; p.begin("sukiwifi", true); pushPending = p.getBool("push", false); probation = p.getBool("prob", false); p.end();
  if (probation) probationSince = millis();
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  downSince = millis();
  startWeb();
}

// neue Konfiguration aus Node-RED übernehmen
static void adoptRemote(const Cfg& c) {
  prevCfg = cfg;
  if (staUp) save("good", cfg);      // aktuelle Einstellungen funktionieren gerade
  cfg = c; save("cfg", cfg);
  probation = true; probationSince = millis(); persistFlags();
  reconnectReq = true;
  Serial.printf("[wifi] new settings from Node-RED (rev %u)\n", (unsigned)cfg.rev);
}

static void sync(const String& dash) {
  if (!staUp) return;
  if (lastSync && millis() - lastSync < SYNC_MS && !pushPending) return;
  lastSync = millis();
  HTTPClient http; http.setConnectTimeout(2000); http.setTimeout(3000);
  String url = dash + "/wifi/device?dev=" + devId + "&ssid=" + WiFi.SSID() + "&ip=" + WiFi.localIP().toString() +
               "&rssi=" + String(WiFi.RSSI()) + "&mac=" + WiFi.macAddress() + "&rev=" + String(cfg.rev) +
               "&mode=" + (cfg.net[curNet < 0 ? 0 : curNet].dhcp ? "dhcp" : "static") + (syncExtra ? syncExtra() : String());
  url.replace(" ", "%20");
  if (!http.begin(url)) return;
  int code = http.GET();
  if (code != 200) { http.end(); Serial.printf("[wifi] sync GET -> %d\n", code); return; }
  JsonDocument d;
  DeserializationError e = deserializeJson(d, http.getString());
  http.end();
  if (e) return;
  haveNode = true;
  if (syncReply) syncReply(d.as<JsonVariantConst>());
  uint32_t nrev = d["rev"] | 0;
  if (pushPending || nrev == 0) {
    JsonDocument b; JsonObject o = b.to<JsonObject>();
    toJson(cfg, o, true);
    o["dev"] = devId; o["source"] = "device"; o["note"] = pushNote;
    String body; serializeJson(b, body);
    HTTPClient p; p.setConnectTimeout(2000); p.setTimeout(3000);
    if (p.begin(dash + "/wifi")) {
      p.addHeader("Content-Type", "application/json");
      int c = p.POST(body);
      if (c == 200) {
        JsonDocument r;
        if (!deserializeJson(r, p.getString())) { cfg.rev = r["rev"] | cfg.rev; save("cfg", cfg); }
        pushPending = false; pushNote[0] = 0; persistFlags();
      }
      Serial.printf("[wifi] pushed settings -> %d (rev %u)\n", c, (unsigned)cfg.rev);
      p.end();
    }
  } else if (nrev != cfg.rev) {
    Cfg t = cfg; String err;
    if (fromJson(d.as<JsonVariantConst>(), t, err)) { t.rev = nrev; adoptRemote(t); }
    else Serial.printf("[wifi] ignored invalid settings from Node-RED: %s\n", err.c_str());
  }
}

// Aus dem Netz-Task regelmäßig aufrufen (blockiert höchstens kurz)
static void loop() {
  if (web) web->handleClient();
  if (apUp) dns.processNextRequest();
  uint32_t now = millis();
  bool up = WiFi.status() == WL_CONNECTED;

  if (reconnectReq) {
    reconnectReq = false; forceTry = true;   // neue Einstellungen: sofort probieren, auch wenn ein Handy im Einrichtungs-WLAN ist
    WiFi.disconnect(); st = IDLE; retryAt = now + 300; up = false;
    if (staUp) { staUp = false; downSince = now; }
  }
  if (up && st != UP) {
    st = UP; staUp = true; lastSync = 0; upSince = now; forceTry = false;
    if (probation) { probation = false; save("good", cfg); persistFlags(); }
    snprintf(statusLine, sizeof(statusLine), "Connected to %s · %s · %d dBm", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
    Serial.printf("[wifi] %s\n", statusLine);
  } else if (!up && st == UP) {
    st = IDLE; staUp = false; downSince = now; retryAt = now + 1000;
    Serial.println("[wifi] connection lost");
  }
  if (up) {
    // AP noch kurz offen lassen, damit das Handy die Bestätigung sieht; dann schließen
    if (apUp && (WiFi.softAPgetStationNum() == 0 || now - upSince > 120000) && now - upSince > 5000) stopAp();
    if (now - lastSync < 1000)
      snprintf(statusLine, sizeof(statusLine), "Connected to %s · %s · %d dBm", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
    return;
  }

  // Probezeit abgelaufen → letzte funktionierende Einstellungen
  if (probation && now - probationSince > PROBATION_MS) {
    Serial.println("[wifi] new settings failed - reverting to last working settings");
    cfg = prevCfg;   // Rückfall wird an Node-RED gemeldet (pushPending), damit die Seite den echten Stand zeigt
    probation = false; pushPending = true; strcpy(pushNote, "reverted: could not connect with the new settings");
    save("cfg", cfg); persistFlags();
    WiFi.disconnect(); st = IDLE; retryAt = now + 300;
  }
  if (!apUp && now - downSince > AP_AFTER_MS) startAp();
  snprintf(statusLine, sizeof(statusLine), apUp ? "No network - setup WiFi '%s' active" : "Searching for WiFi ...", apName);
  // solange jemand im Einrichtungs-WLAN ist: nur nach neuen Einstellungen oder alle 60 s probieren
  // (Scannen/Verbinden wechselt den Kanal und kann das Handy kurz trennen)
  static uint32_t lastApTry = 0;
  if (apUp && WiFi.softAPgetStationNum() > 0 && !forceTry && st == IDLE) {
    if (now - lastApTry < 60000) return;
    lastApTry = now;
  }

  switch (st) {
    case IDLE:
      if (now < retryAt) break;
      WiFi.scanNetworks(true);
      st = SCANNING; connStart = now;
      break;
    case SCANNING: {
      int n = WiFi.scanComplete();
      if (n == WIFI_SCAN_RUNNING) { if (now - connStart > 15000) { WiFi.scanDelete(); st = IDLE; retryAt = now + 1000; } break; }
      int best = -1, bestIdx = -1; int32_t bestRssi = -1000;
      for (int k = 0; k < n; k++)
        for (int i = 0; i < 2; i++)
          if (cfg.net[i].ssid[0] && WiFi.SSID(k) == cfg.net[i].ssid && WiFi.RSSI(k) > bestRssi) { bestRssi = WiFi.RSSI(k); best = i; bestIdx = k; }
      if (best >= 0) {
        int32_t ch = WiFi.channel(bestIdx); uint8_t bssid[6]; memcpy(bssid, WiFi.BSSID(bestIdx), 6);
        WiFi.scanDelete();
        beginNet(best, ch, bssid);
      } else {
        WiFi.scanDelete();
        // nichts gefunden: reihum direkt versuchen (versteckte SSIDs)
        static int rr = 0; static bool direct = false;
        direct = !direct;   // jeden zweiten Durchlauf direkt verbinden
        for (int t = 0; t < 2; t++) { rr = (rr + 1) % 2; if (cfg.net[rr].ssid[0]) break; }
        if (direct && cfg.net[rr].ssid[0]) beginNet(rr); else { st = IDLE; retryAt = now + 3000; }
      }
      break;
    }
    case CONNECTING:
      if (now - connStart > 15000) {
        forceTry = false;
        Serial.printf("[wifi] '%s' failed (status %d)\n", cfg.net[curNet].ssid, (int)WiFi.status());
        WiFi.disconnect(); st = IDLE; retryAt = now + 2000;
      }
      break;
    case UP: break;
  }
}

static bool connected() { return staUp; }
static void syncSoon() { lastSync = 0; }   // beim nächsten loop()/sync() sofort melden
static bool apActive() { return apUp; }
static const char* apSsid() { return apName; }
static const char* status() { return statusLine; }
// QR-Text zum Beitreten des Einrichtungs-WLANs
static String apQr() { return String("WIFI:T:WPA;S:") + apName + ";P:" + AP_PASS + ";;"; }

}  // namespace sw
