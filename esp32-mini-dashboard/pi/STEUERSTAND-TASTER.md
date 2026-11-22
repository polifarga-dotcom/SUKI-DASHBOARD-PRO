# Steuerstand-Taster an Bord einrichten (2× Shelly BLU Button Tough 1)

Ziel: Beide Taster werden vom **SignalK-Pi (192.168.0.100)** empfangen, nicht vom MacBook.
Der Taster-Dienst `suki-button` läuft auf dem Pi schon. Du musst die beiden Taster nur noch dort anlernen. Beide lösen dieselben Funktionen aus.

## Belegung

| Geste | Funktion |
|---|---|
| 1× | Alle Alarme quittieren. Bei einem Wachalarm wird zusätzlich die Wache bestätigt. |
| 2× | Wache bestätigen. |
| 3× | Ankeralarm an („Drop Anchor Now“: Bugposition, Radius 6 × Tiefe). Nur unter 1 kn und ohne gesetzten Anker. |
| lang (≥ 2 s) | Mann über Bord: MOB-Alarm auf allen Geräten, Position vom GPS. |

Rückmeldung über den Summer am Pi:

| Ton | Bedeutung |
|---|---|
| 1, 2 oder 3 kurze Töne | erledigt |
| 2 lange Töne | MOB gesetzt |
| 1 sehr langer Ton | abgelehnt oder Problem am Pi |

## 1. Vorher

- Der Empfänger auf dem MacBook ist abgebaut (seit 22.11.2026). Am Mac ist nichts mehr zu tun.
- Beide Taster haben aktuelle Firmware (2×, 3× und lang werden vom Taster selbst erkannt).
- Am Pi ist noch kein Taster angelernt.

## 2. Am Pi anlernen (ohne SSH)

1. Die Radar-App öffnen (http://192.168.0.100:8090) und zu **Setup → Steuerstand-Taster** gehen.
2. Dort muss stehen, dass der Taster-Dienst läuft. Steht dort „Taster-Dienst auf dem Pi läuft nicht“, siehe Abschnitt 5.
3. **„Taster anlernen“** tippen. Der Countdown von 60 s läuft.
4. In dieser Zeit **1× auf den Taster drücken**, am besten in der Nähe des Pi.
5. Der Taster erscheint in der Liste mit seiner Bluetooth-Adresse und dem Batteriestand. Der Summer gibt einen kurzen Ton.
6. Für den **zweiten Taster** Schritt 3–5 wiederholen. Pro Anlernvorgang wird genau ein Taster übernommen. Den bereits angelernten Taster in dieser Zeit nicht drücken.

Ein Druck während des Anlernens löst **keine** Aktion aus.

## 3. Test am Steuerstand (Reichweite)

1. Mit jedem Taster an seinem Platz **1×** drücken.
2. In der App unter Setup → Steuerstand-Taster muss „Zuletzt: 1× ✓“ mit der aktuellen Uhrzeit erscheinen, und der Summer gibt einen kurzen Ton.
3. **2×** drücken. Das bestätigt die Wache.
4. **3×** und **lang** nur testen, wenn es passt:
   - 3× setzt den Anker scharf. Das geht nur bei weniger als 1 kn Fahrt.
   - Lang löst MOB-Alarm auf allen Geräten aus.
   - Danach den MOB-Marker in der Radar-App antippen → löschen. Den Ankeralarm beendest du in der Anker-App oder am Mini Dash.
5. Kommt am Steuerstand nichts an, ist die Reichweite zu gering. Wenn kein Ton kommt, sofort mehrmals drücken und zuerst das prüfen. Plan B: ein ESP32 in der Nähe des Steuerstands als Bluetooth→WLAN-Relais.

## 4. Taster entfernen

Einen Taster nimmst du mit dem Papierkorb neben seinem Eintrag aus der Liste, z. B. wenn er verloren geht oder ersetzt wird.

## 5. Wenn etwas nicht geht

- **Dienst läuft nicht:**
  ```bash
  ssh admin@192.168.0.100 'sudo systemctl restart suki-button; journalctl -u suki-button -n 20 --no-pager'
  ```
- **2×, 3× oder lang kommen als Einzel-Drücke an:** Firmware des Tasters in der **Shelly Smart Control App** aktualisieren.
- **3× zu langsam gedrückt:** 1× und danach 2× innerhalb von 2 s zählt ebenfalls als 3×.
- **Rohdaten ansehen:** Dienst stoppen, dann im Diagnosemodus starten; jedes Funkpaket wird ausgegeben. Mit Ctrl-C beenden und den Dienst wieder starten.
  ```bash
  ssh -t admin@192.168.0.100 'sudo systemctl stop suki-button; SUKI_RAW=1 suki-button; sudo systemctl start suki-button'
  ```
- **Anlernen per SSH** (falls die App nicht geht):
  ```bash
  ssh -t admin@192.168.0.100 'sudo systemctl stop suki-button; suki-button --learn; sudo systemctl start suki-button'
  ```
