#!/usr/bin/env python3
"""Kleiner lokaler HTTP-Dienst um vault_lookup — für Luna (n8n) + Jarvis (Python).
POST /lookup  {"mode":"kontakt|termin|mail|wissen|dokument","query":"...","vault":"whitestag|clara"}  → JSON.
`vault` ist optional; fehlt es, gilt der Default (whitestag).
Nur 127.0.0.1, nur lesend, keine Auth (lokal gebunden)."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import vault_lookup

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            out = vault_lookup.lookup(body.get("mode", "kontakt"),
                                      body.get("query", ""),
                                      body.get("vault"))
            code = 200
        except Exception as e:  # noqa: BLE001
            out = {"fehler": str(e)}; code = 400
        data = json.dumps(out, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"vault-lookup ok")
    def log_message(self, *a): pass

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 7788), H).serve_forever()
