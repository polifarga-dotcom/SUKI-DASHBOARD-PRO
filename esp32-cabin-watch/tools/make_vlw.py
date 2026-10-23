#!/usr/bin/env python3
"""Erzeugt geglättete VLW-Fonts (LovyanGFX) als C-Header – nur die Zeichen, die gebraucht werden.

    python3 tools/make_vlw.py firmware/CabinWatch/fonts.h \\
        Cond:104:digits:fClock Cond:66:digits:fBig Bold:26:ascii:fB26 Bold:18:ascii:fB18 Bold:14:ascii:fB14 Book:13:ascii:fR13

Stil Bold/Book/Cond = DejaVuSans-Bold / DejaVuSans / DejaVuSansCondensed-Bold, Größe = Pixel pro em, Zeichensatz digits|ascii.
"""
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

TTF = {'Bold': '/Applications/OpenOffice.app/Contents/share/fonts/truetype/DejaVuSans-Bold.ttf',
       'Book': '/Applications/OpenOffice.app/Contents/share/fonts/truetype/DejaVuSans.ttf',
       'Cond': '/Applications/OpenOffice.app/Contents/share/fonts/truetype/DejaVuSansCondensed-Bold.ttf'}
SETS = {'digits': ' -.:0123456789', 'ascii': ''.join(chr(c) for c in range(0x20, 0x7F)) + '°·–'}


def vlw(ttf, size, chars):
    f = ImageFont.truetype(ttf, size)
    asc = -f.getbbox('d', anchor='ls')[1]
    desc = f.getbbox('p', anchor='ls')[3]
    table, bitmaps = b'', b''
    for ch in sorted(chars, key=ord):   # LovyanGFX sucht binär → aufsteigend sortiert
        x0, y0, x1, y1 = f.getbbox(ch, anchor='ls')
        adv = round(f.getlength(ch))
        w, h = max(0, x1 - x0), max(0, y1 - y0)
        if ch == ' ' or w == 0 or h == 0:
            w = h = x0 = y0 = 0
        else:
            img = Image.new('L', (w, h), 0)
            ImageDraw.Draw(img).text((-x0, -y0), ch, font=f, anchor='ls', fill=255)
            bitmaps += img.tobytes()
        table += struct.pack('>7i', ord(ch), h, w, adv, -y0, x0, 0)
    return struct.pack('>6i', len(chars), 11, size, 0, asc, desc) + table + bitmaps


out = sys.argv[1]
with open(out, 'w') as o:
    o.write('// generiert von tools/make_vlw.py – nicht von Hand bearbeiten\n#pragma once\n#include <pgmspace.h>\n')
    for spec in sys.argv[2:]:
        style, size, cs, name = spec.split(':')
        data = vlw(TTF[style], int(size), SETS[cs])
        o.write(f'const uint8_t {name}[{len(data)}] PROGMEM = {{\n')
        for i in range(0, len(data), 24):
            o.write(','.join(str(b) for b in data[i:i + 24]) + ',\n')
        o.write('};\n')
        print(name, len(data), 'B')
