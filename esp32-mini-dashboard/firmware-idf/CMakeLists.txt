# SUKI Mini Dashboard — ESP-IDF-Build (statt Arduino-Fertigpaket), damit Programmcode und Konstanten aus dem PSRAM
# laufen (CONFIG_SPIRAM_XIP_FROM_PSRAM) und der RGB-Display-Interrupt im IRAM liegt (CONFIG_LCD_RGB_ISR_IRAM_SAFE).
# Quelle bleibt firmware/SukiMiniDash/SukiMiniDash.ino — build.sh erzeugt daraus main/SukiMiniDash.cpp.
cmake_minimum_required(VERSION 3.16)

# Bibliotheken aus dem Arduino-Sketchbook als IDF-Komponenten mitbenutzen
set(EXTRA_COMPONENT_DIRS
    "$ENV{HOME}/Documents/Arduino/libraries/LovyanGFX"
    "$ENV{HOME}/Documents/Arduino/libraries/ArduinoJson")

# Grundlage: Arduinos komplette Original-Konfiguration (alles, was der Arduino-Kern erwartet);
# sdkconfig.defaults legt die Display-/PSRAM-Änderungen darüber
set(SDKCONFIG_DEFAULTS "sdkconfig.defaults.arduino;sdkconfig.defaults")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# wie das Arduino-Board „ESP32S3 Dev Module“ mit USB-CDC (Log und Flashen über den USB-Port)
idf_build_set_property(COMPILE_DEFINITIONS "ARDUINO_USB_MODE=1" APPEND)
idf_build_set_property(COMPILE_DEFINITIONS "ARDUINO_USB_CDC_ON_BOOT=1" APPEND)
idf_build_set_property(COMPILE_DEFINITIONS "BOARD_HAS_PSRAM" APPEND)

project(SukiMiniDash)
