#!/bin/bash
# Baut die Firmware mit ESP-IDF. Die Quelle bleibt firmware/SukiMiniDash/SukiMiniDash.ino:
# arduino-cli erzeugt daraus (inkl. Funktions-Prototypen) main/SukiMiniDash.cpp.
#   ./build.sh            → bauen
#   ./build.sh flash      → bauen + flashen (USB-Port /dev/cu.usbmodem*)
#   ./build.sh monitor    → Log anzeigen
set -e
cd "$(dirname "$0")"
SKETCH=../firmware/SukiMiniDash
FQBN="esp32:esp32:esp32s3:PSRAM=opi,FlashSize=8M,PartitionScheme=default_8MB,USBMode=hwcdc,CDCOnBoot=cdc"
~/.local/bin/arduino-cli compile --preprocess -b "$FQBN" "$SKETCH" > main/SukiMiniDash.cpp.new
mv main/SukiMiniDash.cpp.new main/SukiMiniDash.cpp
source ~/esp/esp-idf/export.sh > /dev/null
PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
case "$1" in
  flash)   idf.py build && idf.py -p "$PORT" flash ;;
  monitor) idf.py -p "$PORT" monitor ;;
  *)       idf.py build ;;
esac
