// Waveshare ESP32-S3-Touch-LCD-7 (800x480, ST7262 RGB565-Panel)
// Pinbelegung laut Waveshare-Wiki / Demo-Code. Backlight, LCD-Reset und
// Touch-Reset hängen am CH422G-IO-Expander (I2C), nicht an GPIOs.
#pragma once
#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include <lgfx/v1/platforms/esp32s3/Panel_RGB.hpp>
#include <lgfx/v1/platforms/esp32s3/Bus_RGB.hpp>

#define PIN_I2C_SDA 8
#define PIN_I2C_SCL 9
#define PIN_TOUCH_INT 4

class LGFX : public lgfx::LGFX_Device {
  lgfx::Bus_RGB _bus;
  lgfx::Panel_RGB _panel;

 public:
  LGFX() {
    {
      auto cfg = _panel.config();
      cfg.memory_width = 800;
      cfg.memory_height = 480;
      cfg.panel_width = 800;
      cfg.panel_height = 480;
      cfg.offset_x = 0;
      cfg.offset_y = 0;
      _panel.config(cfg);
    }
    {
      auto cfg = _panel.config_detail();
      cfg.use_psram = 1;
      _panel.config_detail(cfg);
    }
    {
      auto cfg = _bus.config();
      cfg.panel = &_panel;
      // B3..B7
      cfg.pin_d0 = GPIO_NUM_14;
      cfg.pin_d1 = GPIO_NUM_38;
      cfg.pin_d2 = GPIO_NUM_18;
      cfg.pin_d3 = GPIO_NUM_17;
      cfg.pin_d4 = GPIO_NUM_10;
      // G2..G7
      cfg.pin_d5 = GPIO_NUM_39;
      cfg.pin_d6 = GPIO_NUM_0;
      cfg.pin_d7 = GPIO_NUM_45;
      cfg.pin_d8 = GPIO_NUM_48;
      cfg.pin_d9 = GPIO_NUM_47;
      cfg.pin_d10 = GPIO_NUM_21;
      // R3..R7
      cfg.pin_d11 = GPIO_NUM_1;
      cfg.pin_d12 = GPIO_NUM_2;
      cfg.pin_d13 = GPIO_NUM_42;
      cfg.pin_d14 = GPIO_NUM_41;
      cfg.pin_d15 = GPIO_NUM_40;

      cfg.pin_henable = GPIO_NUM_5;
      cfg.pin_vsync = GPIO_NUM_3;
      cfg.pin_hsync = GPIO_NUM_46;
      cfg.pin_pclk = GPIO_NUM_7;
      cfg.freq_write = 16000000;

      cfg.hsync_polarity = 0;
      cfg.hsync_front_porch = 8;
      cfg.hsync_pulse_width = 4;
      cfg.hsync_back_porch = 8;
      cfg.vsync_polarity = 0;
      cfg.vsync_front_porch = 8;
      cfg.vsync_pulse_width = 4;
      cfg.vsync_back_porch = 8;
      cfg.pclk_active_neg = 1;
      cfg.de_idle_high = 0;
      cfg.pclk_idle_high = 0;
      _bus.config(cfg);
    }
    _panel.setBus(&_bus);
    setPanel(&_panel);
  }
};
