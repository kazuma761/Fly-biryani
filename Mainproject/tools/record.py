#!/usr/bin/env python3
"""Dev-only server: serves the app and accepts recorded clips.

    python3 tools/record.py [port]

Identical to serve.py, plus POST /record?name=<clip>.webm which writes the body
into recordings/. Used to pull MediaRecorder output out of the page without
needing screen-recording permission or capturing the rest of the desktop.

Not part of the app. Nothing in orders.html or kitchen.html talks to this.
"""
import http.server, socketserver, sys, os, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'recordings'
OUT.mkdir(exist_ok=True)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8081


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.json': 'application/json', '.bin': 'application/octet-stream',
        '.u32': 'application/octet-stream', '.stl': 'model/stl',
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        if not self.path.startswith('/record'):
            self.send_error(404)
            return
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        name = (q.get('name', ['clip'])[0] or 'clip').replace('/', '_')
        n = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(n)
        (OUT / name).write_bytes(data)
        print(f'  saved {name}  {len(data)/1e6:.1f} MB')
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, fmt, *args):
        if '200' not in str(args):
            super().log_message(fmt, *args)


with socketserver.TCPServer(('', PORT), Handler) as httpd:
    httpd.allow_reuse_address = True
    print(f'recorder on http://localhost:{PORT}/  -> {OUT}')
    httpd.serve_forever()
