// ota.h — Firmware-Update per WLAN für die SUKI-ESP32-Displays.
//
// Ablauf: build.sh ota legt die Firmware auf den Pi (Node-RED). Das Display meldet bei jedem
// WLAN-Abgleich (sw::sync, 1×/min) seine Version (&fw=…). Liegt eine andere bereit, schickt
// Node-RED ein Angebot {ver,size,sha256,url,force} mit. Ist gerade kein Alarm, lädt das Display
// die Datei in den freien App-Bereich (app0/app1), prüft SHA-256 und startet neu.
//
// Rückfallschutz (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE): die neue Firmware läuft „auf Probe“.
// Erst wenn sie Node-RED erreicht hat, wird sie bestätigt (validate(true)). Schafft sie das nicht
// innerhalb von 3 min oder stürzt sie vorher ab, startet der Bootloader wieder die alte Version.
// Die alte merkt das (NVS „trying“ ≠ eigene Version), sperrt die fehlerhafte Version und meldet
// fwres=err:rollback; erneut versucht wird sie nur per „Update now“ (force).
//
// Alle Funktionen nur aus dem Netz-Task aufrufen; pct wird vom Render-Loop gelesen.
#pragma once
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

#ifndef FW_VERSION
#define FW_VERSION "dev"
#endif

// Arduino-Kern: neue Firmware nicht schon beim Start bestätigen, das macht ota::validate()
extern "C" bool verifyRollbackLater() { return true; }

namespace ota {

static const uint32_t VERIFY_MS = 180000, RETRY_MS = 30 * 60000UL;

static volatile int pct = -1;                 // ≥ 0: Update läuft (Anzeige „UPDATING“)
static char offerVer[32] = "", offerSha[65] = "", offerUrl[64] = "";
static uint32_t offerSize = 0;
static bool offerForce = false;
static char result[40] = "";                 // letztes Ergebnis, an Node-RED gemeldet (fwres=)
static char badVer[32] = "";                 // Version, die nicht hochkam (nur mit force erneut)
static bool pendingVerify = false;
static uint32_t retryAt = 0;

static void nvsSet(const char* k, const char* v) { Preferences p; p.begin("sukiota", false); p.putString(k, v); p.end(); }

// in setup() aufrufen
static void begin() {
  esp_ota_img_states_t s;
  pendingVerify = esp_ota_get_state_partition(esp_ota_get_running_partition(), &s) == ESP_OK && s == ESP_OTA_IMG_PENDING_VERIFY;
  Preferences p; p.begin("sukiota", true);
  String trying = p.isKey("trying") ? p.getString("trying", "") : "", bad = p.isKey("bad") ? p.getString("bad", "") : "";
  p.end();
  strlcpy(badVer, bad.c_str(), sizeof(badVer));
  if (trying.length() && trying != FW_VERSION) {   // Update auf „trying“ ist nicht hochgekommen → alte Version läuft wieder
    strlcpy(badVer, trying.c_str(), sizeof(badVer));
    nvsSet("bad", badVer); nvsSet("trying", "");
    snprintf(result, sizeof(result), "err:rollback-%s", badVer);
  }
  Serial.printf("[ota] firmware %s%s\n", FW_VERSION, pendingVerify ? " (on probation)" : "");
  if (result[0]) Serial.printf("[ota] %s\n", result);
}

// regelmäßig aus dem Netz-Task: nodeOk = Node-RED hat schon geantwortet
static void validate(bool nodeOk) {
  if (!pendingVerify) return;
#ifdef OTA_TEST_NO_CONFIRM
  nodeOk = false;   // Testbuild (OTA_TEST_ROLLBACK=1 ./build.sh ota): nie bestätigen → Rückfall nach 3 min
#endif
  if (nodeOk) {
    esp_ota_mark_app_valid_cancel_rollback();
    pendingVerify = false;
    nvsSet("trying", "");
    strlcpy(result, "ok", sizeof(result));
    Serial.println("[ota] new firmware confirmed");
    sw::syncSoon();
  } else if (millis() > VERIFY_MS) {
    Serial.println("[ota] no contact to Node-RED with the new firmware -> rollback");
    delay(100);
    esp_ota_mark_app_invalid_rollback_and_reboot();
  }
}

// Hooks für sw::sync()
static String syncExtra() {
  String q = String("&fw=") + FW_VERSION;
  if (result[0]) q += String("&fwres=") + result;
  return q;
}
static void syncReply(JsonVariantConst d) {
  JsonVariantConst f = d["fw"];
  if (f.isNull()) { offerVer[0] = 0; return; }
  strlcpy(offerVer, f["ver"] | "", sizeof(offerVer));
  strlcpy(offerSha, f["sha256"] | "", sizeof(offerSha));
  strlcpy(offerUrl, f["url"] | "", sizeof(offerUrl));
  offerSize = f["size"] | 0;
  offerForce = f["force"] | false;
}

// liegt ein Update an, das jetzt geladen werden darf? (Alarm-Sperre prüft der Aufrufer)
static bool due() {
  if (!offerVer[0] || !offerUrl[0] || !offerSize || strlen(offerSha) != 64) return false;
  if (!strcmp(offerVer, FW_VERSION) || pendingVerify || millis() < retryAt) return false;
  if (!strcmp(offerVer, badVer) && !offerForce) return false;
  return true;
}

static bool fail(const char* why) {
  snprintf(result, sizeof(result), "err:%s", why);
  Serial.printf("[ota] update %s failed: %s\n", offerVer, why);
  retryAt = millis() + RETRY_MS;
  pct = -1;
  sw::syncSoon();
  return false;
}

// lädt dashBase + offerUrl, schreibt in den freien App-Bereich, prüft SHA-256, startet neu
static bool run(const String& dashBase, volatile uint32_t& dataRev) {
  const esp_partition_t* part = esp_ota_get_next_update_partition(nullptr);
  if (!part) return fail("no-partition");
  if (offerSize > part->size) return fail("too-big");
  Serial.printf("[ota] downloading %s (%u B) -> %s\n", offerVer, (unsigned)offerSize, part->label);
  pct = 0; dataRev++;
  vTaskDelay(pdMS_TO_TICKS(300));   // Render-Loop zeichnet zuerst den Update-Bildschirm

  HTTPClient http; http.setConnectTimeout(3000); http.setTimeout(10000);
  if (!http.begin(dashBase + offerUrl)) return fail("url");
  int code = http.GET();
  if (code != 200) { http.end(); char b[16]; snprintf(b, sizeof(b), "http-%d", code); return fail(b); }
  if ((uint32_t)http.getSize() != offerSize) { http.end(); return fail("size"); }

  esp_ota_handle_t h;
  if (esp_ota_begin(part, offerSize, &h) != ESP_OK) { http.end(); return fail("begin"); }
  uint8_t* buf = (uint8_t*)heap_caps_malloc(4096, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!buf) { esp_ota_abort(h); http.end(); return fail("no-ram"); }
  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha); mbedtls_sha256_starts(&sha, 0);
  WiFiClient* st = http.getStreamPtr();
  uint32_t got = 0, last = millis();
  const char* err = nullptr;
  while (got < offerSize) {
    int a = st->available();
    if (a <= 0) {
      if (millis() - last > 15000) { err = "timeout"; break; }
      vTaskDelay(pdMS_TO_TICKS(2));
      continue;
    }
    int n = st->readBytes(buf, min((uint32_t)a, min((uint32_t)4096, offerSize - got)));
    if (n <= 0) continue;
    mbedtls_sha256_update(&sha, buf, n);
    if (esp_ota_write(h, buf, n) != ESP_OK) { err = "write"; break; }
    got += n; last = millis();
    int p = (int)((uint64_t)got * 100 / offerSize);
    if (p / 5 != pct / 5) { pct = p; dataRev++; }   // Anzeige nur alle 5 % neu zeichnen
  }
  http.end();
  free(buf);
  uint8_t dig[32];
  mbedtls_sha256_finish(&sha, dig); mbedtls_sha256_free(&sha);
  if (err) { esp_ota_abort(h); return fail(err); }
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", dig[i]);
  if (strcasecmp(hex, offerSha)) { esp_ota_abort(h); return fail("sha"); }
  if (esp_ota_end(h) != ESP_OK) return fail("image");
  if (esp_ota_set_boot_partition(part) != ESP_OK) return fail("boot");
  nvsSet("trying", offerVer);
  if (!strcmp(offerVer, badVer)) nvsSet("bad", "");
  Serial.printf("[ota] %s written, restarting\n", offerVer);
  pct = 100; dataRev++;
  delay(800);
  ESP.restart();
  return true;
}

}  // namespace ota
