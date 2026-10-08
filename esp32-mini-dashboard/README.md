# SUKI Mini Dashboard (Waveshare ESP32-S3-Touch-LCD-7)

Zentrales 7"-Display (800×480): Batterie + Wasser, Wind, Ankerstatus. Oberfläche auf Englisch. Schwarzer Hintergrund,
grüner Punkt = alles ok. Bei einem Alarm blinkt der ganze Bildschirm rot/schwarz;
Antippen quittiert (stoppt das Blinken für X Minuten, nur für die gerade aktiven Alarme).

```
SignalK (Pi :3000) ──WebSocket─┐
                               ├─> Node-RED Tab "ESP32 Mini Dashboard" ──> /esp-dash/api/state ──> ESP32 (1 s Poll)
Supabase mfd-anchor ──5 s──────┘        (Schwellwerte, Hysterese, Quittierung)       └──> Browser-Simulator /esp-dash
```

Die ganze Logik liegt in Node-RED, der ESP32 zeigt nur an. Grenzwerte ändert man also
ohne neues Flashen.

| URL | Zweck |
|---|---|
| http://192.168.0.100:1880/esp-dash | Simulator (gleiches Layout wie das Display, läuft auch auf Tablets) |
| http://192.168.0.100:1880/esp-dash/settings | Einstellungen (Wind-/Batterie-Schwelle, Batterie-Instanz, Test-Alarm) |
| `GET /esp-dash/api/state` | kompakter JSON-State für das Display |
| `GET/POST /esp-dash/api/config` | Konfiguration (persistiert in `/home/admin/esp-dash/config.json` auf dem Pi) |
| `POST /esp-dash/api/ack` | Alarm quittieren |
| `POST /esp-dash/api/anchor` | Anker-Aktionen `drop_now`, `set`, `restore`, `move`, `radius`, `up`, `mute`, `dry` |
| `POST /esp-dash/api/anchor-up` | Anker systemweit einholen (Supabase `silence_alarm`); `{"dryRun":true}` prüft nur die Verbindung |

Screens (wischen): 1 Übersicht · 2 Energy Flow · 3 Wetter · 4 Motor · 5 Segeln · 6 AIS · 7 Anker · 8 SOS.
Einen eigenen Tank-Screen gibt es seit 2026-10-07 nicht mehr — alle Tanks stehen in der linken Box von Screen 1.

## Screen 1: linke Spalte

Eine Box mit Batterie (SOC groß, V/A, Balken) und allen Tanks darunter (Water / Diesel / Black Main / Black Guest
mit Liter, % und Balken). Die frühere Variante mit getrennten Battery- und Water-Boxen gibt es nicht mehr.

## Screen 2: Victron Energy Flow

Nach links wischen (Simulator: Maus ziehen, Pfeiltasten oder die Punkte unten) zeigt den Energy Flow im
VRM-Stil der Pro App: Shore → Inverter/Charger → AC Loads, Solar → Battery → DC Loads, Inverter ↕ Battery.
Daten kommen live vom lokalen MQTT-Broker des Cerbo GX (`192.168.0.116:1883`, `N/<portal>/system/0/#`,
Solar-Tagesertrag aus `solarcharger/+/History/Daily/0/Yield`). Node-RED erkennt die Portal-ID selbst und
schickt alle 30 s das Venus-Keepalive. Wie in der Victron-Box der Pro App: Solar mit Strom, Ertrag heute/gestern und
jedem MPPT (Name, W, kWh heute), Batterie mit Name, Status, Restlaufzeit und weiteren Batterien (z. B. Starterbatterie,
alle `battery/*` außer dem aktiven Batteriemonitor). Solar, AC Loads und DC Loads haben einen 10-Minuten-Verlauf als
Hintergrund-Diagramm. Bei einem neuen Alarm springt das Display automatisch auf Screen 1.

## Screen 3: Wetter

Wetter für die aktuelle GPS-Position (SignalK, sonst letzte Position aus Supabase), alle 30 min:
Open-Meteo (aktuell + 3 Tage, Wind in kn, Sonnenauf-/untergang) und met.no (Mondauf-/untergang, Phase).
Beide ohne API-Key. Darunter der **Tagesverlauf** in 4 Karten mit Mini-Icons, beginnend beim laufenden
Abschnitt: MORNING 06–12, MIDDAY 12–18, EVENING 18–22, NIGHT 22–06 (aus den Open-Meteo-Stundenwerten:
Max/Min-Temperatur, stärkster Wind + Böe, Hauptrichtung, max. Regenwahrscheinlichkeit, Regenmenge; der laufende
Abschnitt zählt ab der aktuellen Stunde, „now–12“). Ganz unten die nächsten 3 Tage kompakt. Ohne Internet bleibt die letzte Vorhersage stehen, „updated“ wird nach 3 h orange.

## Screen 4: Motor

Drehzahlmesser 0–3000 U/min (roter Bereich ab 2700, beides in den Settings), Kühlwassertemperatur,
Motorstunden, Verbrauch, Dieseltank und Reichweite (Stunden + Seemeilen bei aktuellem Verbrauch und SOG).
SignalK liefert `propulsion.*` nur bei laufendem Motor; Motorstunden/Temperatur werden deshalb in
`/home/admin/esp-dash/engine.json` gemerkt. Verbrauch: `fuel.rate` vom Motor, falls vorhanden, sonst
Schätzung aus der Verbrauchskurve (Settings → Engine, Format `rpm:l/h,...`).
Vorschau mit laufendem Motor im Simulator: `/esp-dash?demoRpm=2150` (nur lokal im Browser).

## Screen 7: Anker

Wie die Anchor-Seite der Pro App, als Radar-Ansicht (Nord oben, Mitte = Anker, Kreis = Alarmradius,
Track der letzten 2 h, Boot als Pfeil in Kursrichtung). Werte: Distanz, Tiefe, Scope, Peilung zum Anker.
Einstellungen Radius/Kette/Peilung mit −/+; Aktionen DROP NOW, SET, RESTORE, ANCHOR UP, MUTE (mit Bestätigung).
Alles geht über `POST /esp-dash/api/anchor` → Supabase `mfd-anchor` und ist damit sofort systemweit
(Pro App, Zeus, anchor-check-Alarm).

## Screen 6: AIS (vor dem Anker-Screen)

Radar-Ansicht **Heading oben** (eigenes Heading aus SignalK, sonst COG ab 1 kn Fahrt, sonst Nord oben; Anzeige „HDG UP 123°“ unten rechts, N-Markierung am Außenring), eigenes Boot in der Mitte (Reichweite 0.25–24 NM mit +/−). AIS-Ziele kommen per
SignalK-WebSocket (`vessels.*`, alle 5 s), die eigene MMSI wird ignoriert. Jedes Ziel und das eigene Boot
haben eine Kurslinie für 30 min Fahrt (COG × SOG). Node-RED rechnet CPA/TCPA aus der relativen Bewegung.
Modi (Settings → AIS): ANCHOR = kein Alarm, CRUISE = CPA < `aisCruiseNm` (0.5 NM), OFFSHORE = CPA < `aisOffshoreNm`
(2 NM), jeweils nur bei TCPA < `aisTcpaMin` (20 min); orange = doppelte Grenzen. Alarm: ganzer Bildschirm blinkt
rot + Summer, Knopf ACKNOWLEDGE ALARM quittiert. Ziel antippen zeigt MMSI, Rufzeichen, Typ, Länge, Status, Ziel,
SOG/COG, Distanz/Peilung, CPA und Alter der Meldung. Ziele ohne Meldung > 10 min werden grau, nach 20 min entfernt.

Screen 8 ist der SOS-Screen (Rettungsring-Knopf oben links).

## Off-Screen

Power-Knopf oben links (rechts vom Rettungsring): Bildschirm schwarz, nur Uhrzeit lokal + UTC sehr dunkel
(nachts dunkelrot) — für die Nacht, wenn die anderen Screens zu hell sind. Tipp irgendwo → Startbildschirm.
Jeder blinkende (nicht quittierte) Alarm beendet den Off-Screen sofort. Kein Wischen im Off-Screen.

## Alarmlogik

- **Wind**: Mittelwert über `windAvgSec` (Standard 10 s), Quelle TWS, sonst AWS. Alarm ab `windAlarmKn`,
  endet erst unter Schwelle minus Hysterese. Zusätzlich wird das 10-Minuten-Maximum angezeigt.
- **Batterie**: SOC < `battLowSoc` (Hysterese +3 %). Optionaler Spannungs-Fallback, falls kein SOC vorhanden ist.
- **Water**: freshWater-Füllstand < `waterLowPct` (Standard 15 %, Hysterese +3 %).
- **Baro**: `environment.outside.pressure` < `baroLowHpa` (Standard 995 hPa, Hysterese +1). Hintergrund-Diagramm = Verlauf über `baroWinMin` (Standard 2 min, wählbar bis 6 h; Verlauf wird bis 6 h im Flow-Context gehalten, Skala mind. 1 hPa).
- **Anker**: `anchor_config.alarming` aus Supabase (autoritativ, gleiche Quelle wie Pro App und anchor-check).
  Fällt die Cloud aus (z. B. Starlink), prüft Node-RED lokal mit der zuletzt bekannten Ankerposition
  (Distanz > Radius länger als `alarm_delay_s`).
- **Warnung** (oranger Punkt, kein Blinken): veraltete SignalK-Daten, Cloud nicht erreichbar, ESP ohne Verbindung.

## Gewitterwarnung (MeteoAlarm)

Offizielle Warnungen der nationalen Wetterdienste über MeteoAlarm (`feeds.meteoalarm.org`, Atom-Feed pro Land),
alle 20 min. Die Region kommt aus der GPS-Position per OpenStreetMap/Nominatim (nur nach > 10 km Ortswechsel,
`zoom=14`, damit auch Positionen im Hafenbecken eine Region ergeben); auf See bleibt die letzte Region bis 100 km
gültig. **Orange / Rot** = Alarm (Blinken + Summer, Quittieren stillt ihn für **4 h**; eine Verschärfung auf Rot
blinkt sofort wieder), **Gelb** = nur Hinweis (per Tipp ebenfalls 4 h quittierbar; eine neue/verlängerte Warnung erscheint wieder). Ohne MeteoAlarm-Region (außerhalb Europas / weit draußen) gibt es nur
einen Hinweis, wenn Open-Meteo in den nächsten 2 h Gewitter vorhersagt. Settings → Thunderstorm warnings
(`stormAlarmOn`). Reine Gewitteralarme springen auf den Wetter-Screen. Quittierdauer je Alarm: `ack.kUntil`.

## Alarm-Summer

Angeschlossen am **Sensor AD**-Stecker (PH2.0, 3 Pins: 3V3 / GND / Signal, Signal = GPIO 6 laut Waveshare-Beispiel
`04_Sensor_AD`; vor dem Anschließen am Platinenaufdruck prüfen). Pin in `secrets.h` mit `#define BUZZER_PIN x`
änderbar, `-1` = aus. Tagsüber piept er im Blinktakt, nachts je nach Setting kurz alle 2 s oder gar nicht.
Antippen quittiert auch den Ton.

Empfohlene Teile (Conrad): Summer TRU COMPONENTS TC-10475820 (Best.-Nr. 2618955, 12 V, 95 dB) +
Joy-it COM-MOSFET (Best.-Nr. 2176924, Signal HIGH = Ausgang an, läuft mit 3,3 V Logik).

```
Sensor AD 3V3 ──── COM-MOSFET VCC (Pin 2)
Sensor AD GND ──── COM-MOSFET GND (Pin 1)
Sensor AD Signal ─ COM-MOSFET Signal (Pin 4)        (Pin 3 = NC)
12 V Bordnetz ──── COM-MOSFET Vin + / −   (abgesichert, z. B. 1 A)
COM-MOSFET Vout + ── Summer rot,  Vout − ── Summer schwarz
```

## Node-RED deployen

```bash
cd nodered && python3 build_flow.py --deploy
```

Legt den Tab an oder ersetzt ihn (gefunden über den Namen). Andere Tabs bleiben unberührt.
Den Tab nicht im Editor ändern: Der Quelltext liegt in `src/` und `web/`.

## Firmware bauen und flashen (ESP-IDF)

Gebaut wird mit **ESP-IDF v5.5.5** und dem Arduino-Kern 3.3.12 als Komponente (`firmware-idf/`). Nur so lassen
sich die zwei Espressif-Einstellungen setzen, die dieses RGB-Display mit WLAN braucht: Programmcode und Konstanten
laufen aus dem PSRAM (`CONFIG_SPIRAM_XIP_FROM_PSRAM`) und der Display-Interrupt liegt im IRAM
(`CONFIG_LCD_RGB_ISR_IRAM_SAFE`). Mit dem Arduino-Fertigpaket zuckte das Bild bzw. zeigte Zeilenreste links.

Quelle bleibt `firmware/SukiMiniDash/SukiMiniDash.ino`; `build.sh` erzeugt daraus mit `arduino-cli --preprocess`
die C++-Datei für ESP-IDF.

Einmalig:
- ESP-IDF in `~/esp/esp-idf` (`git clone -b v5.5.5 --recursive https://github.com/espressif/esp-idf.git`, dann `./install.sh esp32s3`)
- `arduino-cli` mit Kern esp32 3.3.12 und den Bibliotheken LovyanGFX + ArduinoJson (für das Vorverarbeiten)
- WLAN in `firmware/SukiMiniDash/secrets.h` eintragen (Vorlage `secrets.example.h`)

Board am **USB**-Port (nicht UART) anschließen, dann:

```bash
cd firmware-idf && ./build.sh flash
```

Nach dem Flashen bleibt der Chip oft im Flash-Modus → Kabel kurz ab- und wieder anstecken. Hängt die Firmware in
einer Neustart-Schleife: BOOT gedrückt halten, Kabel einstecken, loslassen, dann flashen. Log: `./build.sh monitor`.

### Darstellung (warum so gebaut)

- Gezeichnet wird in 40-Zeilen-Streifen in einen Puffer im internen RAM (nicht direkt im PSRAM, aus dem das Panel
  liest); nur geänderte Streifen werden in den Framebuffer kopiert (Prüfsumme).
- Panel über `esp_lcd` (14 MHz, Bounce-Buffer 10 Zeilen), große Werte mit geglätteter DejaVu Sans Bold
  (`tools/make_vlw.py` → `fonts_bold.h`).
- LovyanGFX' `drawWideLine` setzt den Clip-Bereich zurück → eigene `fbWideLine()` verwenden.

### Test zu Hause

Zu Hause erreicht das Display den Pi auf dem Boot nicht (nur der Mac über Tailscale). `tools/dev_proxy.py` auf dem
Mac reicht ausschließlich `/esp-dash/api/…` und nur an die Display-IP durch; in `secrets.h` zeigt `DASH_URL_WIFI1`
dafür auf den Mac:

```bash
python3 tools/dev_proxy.py --allow 192.168.178.164
```

### Erste Inbetriebnahme: Prüfliste

- Bild bleibt dunkel → Backlight/CH422G-Sequenz in `boardInit()` prüfen (I²C SDA 8 / SCL 9).
- Serieller Monitor meldet `GT911 touch: NICHT gefunden` → Touch-Reset-Sequenz prüfen.
- Variante „7B“ (1024×600) braucht andere Auflösung und Timings.
