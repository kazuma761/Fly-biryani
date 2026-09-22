#!/usr/bin/env python3
"""Static server. No build step, no bundler, no node_modules.

    python3 serve.py          # then open http://localhost:8080/

Three.js comes from a CDN import map, and every data file is local, so the only
thing this needs the network for is the first load of three.js itself.
"""
import http.server, socketserver, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.json': 'application/json', '.bin': 'application/octet-stream',
        '.u32': 'application/octet-stream', '.stl': 'model/stl',
    }
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, fmt, *args):
        if '200' not in str(args): super().log_message(fmt, *args)

with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Biryani Center on http://localhost:{PORT}/')
    httpd.serve_forever()
