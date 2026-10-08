#!/usr/bin/env python3
"""Test-Proxy für das Mini-Dashboard zu Hause.

Das Display ist im Heim-WLAN und erreicht den Pi auf dem Boot (192.168.0.100) nicht – der Mac schon,
über Tailscale. Dieser Proxy reicht NUR die Display-API (/esp-dash/api/...) durch und NUR an die
erlaubten Client-IPs. Der Node-RED-Editor und alles andere bleiben unerreichbar.

    python3 tools/dev_proxy.py --allow 192.168.178.164
"""
import argparse
import http.server
import urllib.error
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=18800)
ap.add_argument('--target', default='http://192.168.0.100:1880')
ap.add_argument('--allow', action='append', required=True, help='erlaubte Client-IP (mehrfach möglich)')
args = ap.parse_args()
PREFIX = '/esp-dash/api/'


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'   # Keep-Alive: das Display hält eine Verbindung offen
    def _forward(self, method):
        if self.client_address[0] not in args.allow or not self.path.startswith(PREFIX) or '..' in self.path:
            self.send_error(403)
            return
        body = None
        if method == 'POST':
            n = int(self.headers.get('Content-Length') or 0)
            if n > 4096:
                self.send_error(413)
                return
            body = self.rfile.read(n)
        req = urllib.request.Request(args.target + self.path, data=body, method=method,
                                     headers={'Content-Type': self.headers.get('Content-Type', 'application/json')})
        try:
            with urllib.request.urlopen(req, timeout=12) as r:
                data, code, ctype = r.read(), r.status, r.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as e:
            data, code, ctype = e.read(), e.code, 'application/json'
        except Exception:
            self.send_error(502)
            return
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._forward('GET')

    def do_POST(self):
        self._forward('POST')

    def log_message(self, fmt, *a):
        if not self.path.endswith('/state'):
            super().log_message(fmt, *a)


print(f'dev_proxy: :{args.port} -> {args.target}{PREFIX}*  erlaubt: {", ".join(args.allow)}')
http.server.ThreadingHTTPServer(('0.0.0.0', args.port), H).serve_forever()
