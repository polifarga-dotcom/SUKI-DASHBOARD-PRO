#!/bin/bash
# Baut die Cabin-Watch-Firmware mit arduino-cli (Ausgabe in build/).
#   ./build.sh            → bauen
#   ./build.sh flash      → bauen + flashen (USB, /dev/cu.wchusbserial* bzw. /dev/cu.usbserial*)
#   ./build.sh ota        → bauen + auf den Pi legen; das Display holt sich das Update selbst (WLAN)
#   ./build.sh monitor    → Log anzeigen
set -e
cd "$(dirname "$0")"
SKETCH=CabinWatch
FQBN="esp32:esp32:esp32:PSRAM=enabled,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB"
CLI=~/.local/bin/arduino-cli
PI=admin@192.168.0.100
NODE_RED=http://192.168.0.100:1880
DEV=cabin
PORT=$(ls /dev/cu.wchusbserial* /dev/cu.usbserial* 2>/dev/null | head -1)
if [ "$1" = monitor ]; then exec "$CLI" monitor -p "$PORT" -c baudrate=115200; fi
# Firmware-Version = Bauzeitpunkt; das Display vergleicht sie mit der Version auf dem Pi
FW_VERSION=$(date +%Y-%m-%d-%H%M%S)
echo "#define FW_VERSION \"$FW_VERSION\"" > "$SKETCH/fw_version.h"
# nur zum Testen des Rückfallschutzes: diese Firmware bestätigt sich nie
[ "$OTA_TEST_ROLLBACK" = 1 ] && echo "#define OTA_TEST_NO_CONFIRM" >> "$SKETCH/fw_version.h"
"$CLI" compile -b "$FQBN" --libraries libraries --build-path build "$SKETCH"
case "$1" in
  flash) "$CLI" upload -b "$FQBN" -p "$PORT" --input-dir build "$SKETCH" ;;
  ota)
    BIN=build/$SKETCH.ino.bin
    SHA=$(shasum -a 256 "$BIN" | cut -d' ' -f1)
    SIZE=$(stat -f%z "$BIN")
    # erst unter .tmp hochladen und dann umbenennen: Node-RED liefert nie eine halbe Datei aus
    ssh "$PI" 'mkdir -p /home/admin/esp-dash/fw'
    scp -q "$BIN" "$PI:/home/admin/esp-dash/fw/$DEV.bin.tmp"
    ssh "$PI" "mv /home/admin/esp-dash/fw/$DEV.bin.tmp /home/admin/esp-dash/fw/$DEV.bin"
    curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"dev\":\"$DEV\",\"ver\":\"$FW_VERSION\",\"size\":$SIZE,\"sha256\":\"$SHA\"}" "$NODE_RED/esp-dash/api/fw"
    echo
    echo "Firmware $FW_VERSION ($SIZE B) liegt auf dem Pi — das Cabin Watch aktualisiert sich innerhalb von ~1 min (nicht während eines Alarms)."
    ;;
esac
