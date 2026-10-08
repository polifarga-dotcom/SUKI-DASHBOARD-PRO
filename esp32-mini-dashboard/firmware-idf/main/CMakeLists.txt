idf_component_register(
    SRCS "SukiMiniDash.cpp"
    INCLUDE_DIRS "." "../../firmware/SukiMiniDash"
    REQUIRES arduino-esp32 LovyanGFX ArduinoJson esp_lcd)
# wie im Arduino-Build: diese beiden Warnungen nicht als Fehler werten (ArduinoJson-Zugriffe bzw. bewusst gekürzte Texte)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error=dangling-reference -Wno-error=format-truncation -Wno-dangling-reference -Wno-format-truncation)
