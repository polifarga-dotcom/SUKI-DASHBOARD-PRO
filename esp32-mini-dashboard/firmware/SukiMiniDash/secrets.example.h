// Kopieren nach secrets.h und ausfüllen (secrets.h ist in .gitignore)
#pragma once
// WLAN 1 (Pflicht) und WLAN 2 (optional, leer lassen wenn nicht gebraucht).
// Das Display verbindet sich mit dem stärksten verfügbaren und wechselt bei Ausfall automatisch.
#define WIFI_SSID  "BOOTS-WLAN"
#define WIFI_PASS  "PASSWORT"
#define WIFI_SSID2 ""
#define WIFI_PASS2 ""
#define DASH_URL   "http://192.168.0.100:1880/esp-dash/api"
// optional: andere Node-RED-Adresse, solange das Display in WLAN 1 ist (z. B. Test zu Hause über
// tools/dev_proxy.py auf dem Mac, der per Tailscale das Boot erreicht). Leer = immer DASH_URL.
#define DASH_URL_WIFI1 ""
