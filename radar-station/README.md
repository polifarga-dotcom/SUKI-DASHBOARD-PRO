# SUKI Radar Station

Lokale Web-App (MacBook / iPad Pro) für den B&G HALO20+ mit AIS-Overlay, ARPA, Kollisionsalarmen und voller Radarsteuerung.
Nur Boots-LAN, keine Cloud.

**URL:** http://192.168.0.100:8090/ (iPad: „Zum Home-Bildschirm“ → Vollbild)

## Architektur
- **nginx** auf dem Pi (Port 8090): statische App + Proxy `/signalk/` → SignalK :3000, `/mayara/` → mayara :6502,
  `/mayara-emu/` → mayara-Emulator :6503 (nur Test). Config: `pi/nginx-radar-station.conf`.
- **mayara-server** (`pi/mayara.service`): jetzt **ohne `--replay`** (Steuerung erlaubt) und mit `-t arpa` (ARPA-Tracking im Server).
- App: Vite + Svelte 5 + TypeScript, Radarbild per WebGL2 (`src/radar/renderer.ts`), Spokes im Web Worker (`src/radar/spokeWorker.ts`).

| Modul | Inhalt |
|---|---|
| `src/data/signalk.svelte.ts` | Eigenschiff + AIS (vessels.*, atons.*), REST-Seed für Namen |
| `src/data/mayara.svelte.ts` | Radarliste, Capabilities, Controls lesen/setzen, ARPA-Ziele (acquire/cancel) |
| `src/collision/cpa.ts` | CPA/TCPA, BCR/BCT, KVR-Lage (head-on, crossing, overtaking), Gefahrenklasse |
| `src/collision/targets.svelte.ts` | Zielliste AIS + ARPA, Fusion (ARPA bestätigt AIS), Hafen-Rauschfilter |
| `src/alarms/` | Alarmengine (CPA, SART/MOB, Guard Zones Echo + AIS, Lost Target, Systemzustand), Töne |
| `src/radar/overlay.ts` | Ringe, Kompassskala, Headingline, Symbole, Vektoren, Tracks, CPA-Punkte, EBL/VRM, Zonen |
| `src/chart/chartLayer.ts` | optionale OSM/OpenSeaMap-Unterlage (gedreht per CSS) |
| `src/sim/simulator.ts` | Test-Begegnungen (Settings → Test) |

## Bedienung
- Range: +/− Buttons, Mausrad, Pinch (stellt die Radar-Range um, wie am Plotter)
- Tap auf Ziel = Info; Tap ins Leere = Cursor; Long-Press / Rechtsklick = Menü (Acquire, EBL/VRM, Marker)
- Tasten (Mac): `+`/`-` Range, `O` Orientierung, `P` Position, `A` Acquire, `E` EBL, `1`/`2` EBL an/aus,
  `N` Nacht, `Space` quittieren, `M` 5 min stumm, `Tab` Seitenleiste, `Esc` abbrechen
- Transmit nur mit Bestätigung (Personen an der Antenne!)

## Entwicklung
```sh
npm install
npm run dev        # http://localhost:5180, Proxy auf den Pi (SUKI_PI=http://… zum Umbiegen)
npm test           # Vitest: CPA/COLREG, Protobuf-Decoder
./deploy.sh        # Test + Build + rsync auf den Pi
```
Emulator (für Tests ohne echtes Senden) auf dem Pi starten:
```sh
ssh admin@192.168.0.100 'nohup /home/admin/mayara/mayara-server --emulator --no-mdns -t arpa -n ws:127.0.0.1:3000 -p 6503 --no-telemetry > /tmp/mayara-emu.log 2>&1 &'
```
Dann in der App Settings → Radar → Source: Emulator. Der Emulator übernimmt nur Range, andere Controls ignoriert er.

## Kartenebenen & MFD (seit 2026-10-27)
- **chart-proxy** (`pi/chart-proxy/`, systemd `chart-proxy.service`, nginx `/tiles/` → 127.0.0.1:8091): Kachel-Proxy mit Anbieter-Katalog
  (`providers.mjs`), zentralen API-Keys (`/home/admin/chart-proxy-data/keys.json`), Disk-Cache `/home/admin/chart-cache`
  (nur Anbieter mit `mode: 'cache'`), Revier-Download (nur `prefetch: true`), Kielspur aus SignalK, Coral-Atlas-Dateien.
  Deploy: `rsync -a --exclude '*.test.mjs' pi/chart-proxy/ admin@192.168.0.100:/home/admin/radar-station/chart-proxy/ && ssh admin@192.168.0.100 sudo systemctl restart chart-proxy`
- Anbieter: OSM, OpenSeaMap, EOX Sentinel-2 cloudless, NASA GIBS, EMODnet, GEBCO (frei);
  Copernicus Sentinel Hub, Esri World Imagery, Mapbox, MapTiler (direkt), Google Map Tiles (mit eigenem kostenlosem Schlüssel).
- App: Tab „Ebenen“ (Reihenfolge, Deckkraft, Versatz/„Ausrichten“, Anbieter-Optionen, Presets, Offline-Revier, Coral-Import),
  Einstellungen → Kartenanbieter (Schlüssel). MFD: Ziehen verschiebt (Zum-Schiff-Taste / `C`), Karten-Zoom unabhängig vom Radar,
  Messwerkzeug, MOB-Taste (gedrückt halten), Kielspur, Tiefe + Flachwasser-Alarm, Maßstabsleiste.

## Bekannte Grenzen
- Trails sind relative Trails (polar, nordstabilisiert); ARPA-Ziele haben echte Past-Tracks.
- Chart-Overlay braucht Internet; ab Zoom 19 wird nicht weiter vergrößert.
- Kein Ersatz für Zeus/Ausguck — Ergänzung.
