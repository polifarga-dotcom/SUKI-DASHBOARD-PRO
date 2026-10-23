#!/bin/bash
# Baut die Firmware mit ESP-IDF. Die Quelle bleibt firmware/SukiMiniDash/SukiMiniDash.ino:
# arduino-cli erzeugt daraus (inkl. Funktions-Prototypen) main/SukiMiniDash.cpp.
#   ./build.sh            → bauen
#   ./build.sh flash      → bauen + flashen (USB-Port /dev/cu.usbmodem*)
#   ./build.sh ota        → bauen + auf den Pi legen; das Display holt sich das Update selbst (WLAN)
#   ./build.sh monitor    → Log anzeigen
set -e
cd "$(dirname "$0")"
SKETCH=../firmware/SukiMiniDash
FQBN="esp32:esp32:esp32s3:PSRAM=opi,FlashSize=8M,PartitionScheme=default_8MB,USBMode=hwcdc,CDCOnBoot=cdc"
PI=admin@192.168.0.100
NODE_RED=http://192.168.0.100:1880
DEV=mini
if [ "$1" != monitor ]; then
  # Firmware-Version = Bauzeitpunkt; das Display vergleicht sie mit der Version auf dem Pi
  FW_VERSION=$(date +%Y-%m-%d-%H%M%S)
  echo "#define FW_VERSION \"$FW_VERSION\"" > "$SKETCH/fw_version.h"
  # nur zum Testen des Rückfallschutzes: diese Firmware bestätigt sich nie
  [ "$OTA_TEST_ROLLBACK" = 1 ] && echo "#define OTA_TEST_NO_CONFIRM" >> "$SKETCH/fw_version.h"
  ~/.local/bin/arduino-cli compile --preprocess -b "$FQBN" "$SKETCH" > main/SukiMiniDash.cpp.new
  mv main/SukiMiniDash.cpp.new main/SukiMiniDash.cpp
fi
source ~/esp/esp-idf/export.sh > /dev/null
PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
case "$1" in
  flash)   idf.py build && idf.py -p "$PORT" flash ;;
  monitor) idf.py -p "$PORT" monitor ;;
  ota)
    idf.py build
    BIN=build/SukiMiniDash.bin
    SHA=$(shasum -a 256 "$BIN" | cut -d' ' -f1)
    SIZE=$(stat -f%z "$BIN")
    # erst unter .tmp hochladen und dann umbenennen: Node-RED liefert nie eine halbe Datei aus
    ssh "$PI" 'mkdir -p /home/admin/esp-dash/fw'
    scp -q "$BIN" "$PI:/home/admin/esp-dash/fw/$DEV.bin.tmp"
    ssh "$PI" "mv /home/admin/esp-dash/fw/$DEV.bin.tmp /home/admin/esp-dash/fw/$DEV.bin"
    curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"dev\":\"$DEV\",\"ver\":\"$FW_VERSION\",\"size\":$SIZE,\"sha256\":\"$SHA\"}" "$NODE_RED/esp-dash/api/fw"
    echo
    echo "Firmware $FW_VERSION ($SIZE B) liegt auf dem Pi — das Display aktualisiert sich innerhalb von ~1 min (nicht während eines Alarms)."
    ;;
  *)       idf.py build ;;
esac
