// Waveshare ESP32-S3-Touch-LCD-7 (800x480, ST7262 RGB565-Panel)
// Ansteuerung über ESP-IDF esp_lcd mit Bounce-Buffer: das Panel liest seine nächsten Zeilen aus einem kleinen
// Puffer im internen RAM, der im Hintergrund aus dem PSRAM-Framebuffer nachgefüllt wird. Kurze Engpässe auf dem
// Speicherbus (Flash/PSRAM teilen sich den Bus) werden so abgefangen; nach einer Störung synchronisiert der Treiber
// beim nächsten Bildanfang neu (CONFIG_LCD_RGB_RESTART_IN_VSYNC). Gezeichnet wird mit LovyanGFX in internen
// Streifen (SukiMiniDash.ino), die per rgbPushBand() in den Framebuffer kopiert werden.
// Backlight, LCD-Reset und Touch-Reset hängen am CH422G-IO-Expander (I2C), nicht an GPIOs.
#pragma once
#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include "esp_lcd_panel_rgb.h"
#include "esp_lcd_panel_ops.h"

#define PIN_I2C_SDA 8
#define PIN_I2C_SCL 9
#define PIN_TOUCH_INT 4

#define LCD_W 800
#define LCD_H 480

static esp_lcd_panel_handle_t rgbPanel = nullptr;

static bool rgbInit() {
  esp_lcd_rgb_panel_config_t c = {};
  c.clk_src = LCD_CLK_SRC_DEFAULT;
  c.timings.pclk_hz = 14 * 1000 * 1000;
  c.timings.h_res = LCD_W;
  c.timings.v_res = LCD_H;
  c.timings.hsync_pulse_width = 4;
  c.timings.hsync_back_porch = 20;   // längere Austastung = Luft fürs Nachfüllen (DE-Modus: Bildlage unverändert)
  c.timings.hsync_front_porch = 20;
  c.timings.vsync_pulse_width = 4;
  c.timings.vsync_back_porch = 8;
  c.timings.vsync_front_porch = 8;
  c.timings.flags.pclk_active_neg = 1;
  c.data_width = 16;
  c.bits_per_pixel = 16;
  c.num_fbs = 1;
  // Bounce-Buffer (ohne: Bild ruckte). Mit dem Arduino-Fertigpaket war das Nachfüllen gelegentlich zu knapp
  // (Zeilenreste links) — deshalb wird mit ESP-IDF gebaut (firmware-idf/): Code im PSRAM, Display-Interrupt im IRAM.
  c.bounce_buffer_size_px = 10 * LCD_W;
  c.dma_burst_size = 64;
  c.hsync_gpio_num = 46;
  c.vsync_gpio_num = 3;
  c.de_gpio_num = 5;
  c.pclk_gpio_num = 7;
  c.disp_gpio_num = -1;
  // B3..B7, G2..G7, R3..R7 (Waveshare-Belegung)
  const int d[16] = {14, 38, 18, 17, 10, 39, 0, 45, 48, 47, 21, 1, 2, 42, 41, 40};
  for (int i = 0; i < 16; i++) c.data_gpio_nums[i] = d[i];
  c.flags.fb_in_psram = 1;
  if (esp_lcd_new_rgb_panel(&c, &rgbPanel) != ESP_OK) return false;
  esp_lcd_panel_reset(rgbPanel);
  esp_lcd_panel_init(rgbPanel);
  void* fb0 = nullptr;
  if (esp_lcd_rgb_panel_get_frame_buffer(rgbPanel, 1, &fb0) == ESP_OK && fb0) memset(fb0, 0, LCD_W * LCD_H * 2);
  return true;
}

// in Portionen zu 8 Zeilen mit kurzer Pause: 64 KB am Stück ins PSRAM zu schreiben bremste das Nachfüllen des Bounce-Buffers
static void rgbPushBand(int y, int h, const void* buf) {
  const uint16_t* p = (const uint16_t*)buf;
  for (int r = 0; r < h; r += 8) {
    int n = min(8, h - r);
    esp_lcd_panel_draw_bitmap(rgbPanel, 0, y + r, LCD_W, y + r + n, p + r * LCD_W);
    vTaskDelay(1);
  }
}
