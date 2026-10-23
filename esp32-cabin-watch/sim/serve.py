#!/usr/bin/env python3
"""Mac-Testserver für den SUKI Cabin Watch Simulator.

Liefert sim/index.html aus und reicht NUR den lesenden State-Abruf an Node-RED auf dem Pi durch
(GET /api/state -> /esp-dash/api/state?ais=0). Keine POSTs: Quittieren/Anker-Aktionen bleiben im
Simulator lokal, damit beim Testen nichts am echten Ankeralarm verändert wird.

    python3 serve.py [--port 8091] [--target http://192.168.0.100:1880]
"""
import argparse
import http.server
import os
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=8091)
ap.add_argument('--target', default='http://192.168.0.100:1880')
args = ap.parse_args()
ROOT = os.path.dirname(os.path.abspath(__file__))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path.split('?')[0] != '/api/state':
            return super().do_GET()
        try:
            with urllib.request.urlopen(args.target + '/esp-dash/api/state?ais=0', timeout=6) as r:
                data, code = r.read(), r.status
        except Exception:
            self.send_error(502)
            return
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *a):
        if '/api/state' not in self.path:
            super().log_message(fmt, *a)


http.server.ThreadingHTTPServer(('127.0.0.1', args.port), H).serve_forever()
