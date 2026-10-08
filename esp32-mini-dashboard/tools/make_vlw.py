#!/usr/bin/env python3
"""Erzeugt geglättete VLW-Fonts (8-bit Graustufen, LovyanGFX/TFT_eSPI-Format) als C-Header.

    python3 tools/make_vlw.py /Applications/OpenOffice.app/Contents/share/fonts/truetype/DejaVuSans-Bold.ttf \\
        firmware/SukiMiniDash/fonts_bold.h 40 56 72

Größe N = Pixel pro em (wie bei den LovyanGFX-DejaVu-Fonts: DejaVuN ≈ N px).
Zeichensatz: druckbares ASCII + Grad- und Mittelpunkt-Zeichen.
"""
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

ttf, out, sizes = sys.argv[1], sys.argv[2], [int(s) for s in sys.argv[3:]]
CHARS = [chr(c) for c in range(0x20, 0x7F)] + ['°', '·']


def vlw(size):
    f = ImageFont.truetype(ttf, size)
    asc = -f.getbbox('d', anchor='ls')[1]
    desc = f.getbbox('p', anchor='ls')[3]
    table, bitmaps = b'', b''
    for ch in CHARS:
        x0, y0, x1, y1 = f.getbbox(ch, anchor='ls')
        adv = round(f.getlength(ch))
        w, h = max(0, x1 - x0), max(0, y1 - y0)
        if ch == ' ' or w == 0 or h == 0:
            w = h = 0
            x0 = y0 = 0
        else:
            img = Image.new('L', (w, h), 0)
            ImageDraw.Draw(img).text((-x0, -y0), ch, font=f, anchor='ls', fill=255)
            bitmaps += img.tobytes()
        table += struct.pack('>7i', ord(ch), h, w, adv, -y0, x0, 0)
    head = struct.pack('>6i', len(CHARS), 11, size, 0, asc, desc)
    return head + table + bitmaps


with open(out, 'w') as o:
    o.write('// Automatisch erzeugt von tools/make_vlw.py aus DejaVu Sans Bold (freie Lizenz, dejavu-fonts.github.io)\n')
    o.write('// Geglättete VLW-Fonts für LovyanGFX (lgfx::VLWfont + PointerWrapper)\n#pragma once\n#include <pgmspace.h>\n\n')
    for n in sizes:
        data = vlw(n)
        o.write(f'// DejaVu Sans Bold {n} px, {len(data)} Bytes\nconst uint8_t font_bold{n}[{len(data)}] PROGMEM = {{\n')
        for i in range(0, len(data), 24):
            o.write('  ' + ','.join(str(b) for b in data[i:i + 24]) + ',\n')
        o.write('};\n\n')
        print(f'{n}px: {len(data)} Bytes')
