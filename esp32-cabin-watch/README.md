# SUKI Cabin Watch

Small night-time system watch for the cabin: Waveshare 3.5" ESP32 Touch LCD
(ESP32-D0WDR2-V3, 2 MB PSRAM, 16 MB flash, ST7796 320×480 SPI, FT6336 touch, AXP2101, ES8311 speaker).

## Architecture (same infrastructure as the 7" mini dashboard)

```
SignalK (Pi) ─┐
Supabase ─────┼─> Node-RED evaluate.js (all alarm logic, ack, night) ─> /esp-dash/api/cabin (~1 KB JSON) ─> Cabin Watch
Cerbo MQTT ───┘
```

The device is only a viewer + speaker: no alarm logic in the firmware. `toCabin()` in `sim/index.html`
is the spec for the slim Node-RED endpoint. Silence = the existing `POST /esp-dash/api/ack`,
ANCHOR UP = existing `POST /esp-dash/api/anchor-up`.

## Screens (480×320 landscape)

1. **Home** – large local time, status/alarm banner with UTC + date, ANCHOR tile (mini radar, distance of radius, depth), WIND tile (big kn, 10' sparkline with alarm line, max), footer battery · pressure · sound · link · page dots.
2. **Anchor** – radar (north-up, track, distance rings), distance / radius / depth / chain, SILENCE or two-tap ANCHOR UP.
3. **Settings** (device-local) – night mode off/on/auto (sunset–sunrise), brightness day/night, volume + test, alarm at night full/short.

Any tap while an alarm is sounding = silence. Tap the anchor tile = anchor screen. Swipe = next screen.

## Sound patterns

- anchor: two-tone siren 880/660 Hz
- other alarms: triple beep 1 kHz
- night "short": one soft beep every 2 s
- no data > 15 s: two quiet beeps per minute

## Test on the Mac

```
python3 sim/serve.py      # http://localhost:8091  (read-only proxy to Node-RED on the Pi)
```

## Build and flash

```
cd firmware
./build.sh flash      # build + flash over USB (/dev/cu.wchusbserial*)
./build.sh ota        # build + put it on the Pi; the device updates itself over WiFi
./build.sh monitor    # serial log
```

Firmware updates over WiFi work exactly like on the 7" mini dashboard (shared `ota.h`, see
`esp32-mini-dashboard/README.md` → "Firmware-Update per WLAN"): the device reports its version once a minute,
downloads `/esp-dash/api/fw/cabin.bin` when a different one is offered (never during an alarm), and only
confirms the new firmware after reaching Node-RED — otherwise it returns to the previous one after 3 min.
The settings page (WiFi → Cabin Watch → FIRMWARE) shows the running version and has "Auto-update" / "Update now";
the device's NETWORK page shows the version too. Keep `ota.h` and `SukiWifi.h` identical in both sketch folders.
