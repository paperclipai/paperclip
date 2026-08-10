#!/usr/bin/env python3
"""Kleiner lokaler HTTP-Dienst um `websuche` — fuer n8n, Jarvis und Luna.

POST /suche  {"frage": "...", "quellen": 3, "zeichen": 12000,
              "deadline": 25, "gleiche_domain_erlauben": false}  -> JSON
Nur 127.0.0.1, keine Auth (lokal gebunden) — dieselbe Bauform wie
tools/vault-lookup/server.py.
"""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer

from backends import BackendFehler
from websuche import recherchiere

PORT = 7789


def behandle_suche(rumpf: dict, rechercheur=None) -> tuple[int, dict]:
    rechercheur = rechercheur or recherchiere
    frage = (rumpf.get("frage") or "").strip()
    if not frage:
        return 400, {"fehler": "Feld 'frage' fehlt oder ist leer"}
    try:
        ergebnis = rechercheur(
            frage,
            quellen=int(rumpf.get("quellen", 3)),
            zeichen=int(rumpf.get("zeichen", 12000)),
            deadline=float(rumpf.get("deadline", 25.0)),
            gleiche_domain_erlauben=bool(rumpf.get("gleiche_domain_erlauben", False)),
        )
    except BackendFehler as e:
        # 503 statt 200 mit leerer Liste: ein leeres Ergebnis laese sich beim
        # Aufrufer als "nichts gefunden" lesen.
        return 503, {"fehler": str(e)}
    except Exception as e:  # noqa: BLE001
        return 500, {"fehler": str(e)}
    return 200, ergebnis


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path.rstrip("/") != "/suche":
            self._antworte(404, {"fehler": "Unbekannter Pfad"})
            return
        try:
            laenge = int(self.headers.get("Content-Length", 0))
            rumpf = json.loads(self.rfile.read(laenge) or b"{}")
        except (ValueError, TypeError) as e:
            self._antworte(400, {"fehler": f"Ungueltiges JSON: {e}"})
            return
        code, ausgabe = behandle_suche(rumpf)
        self._antworte(code, ausgabe)

    def do_GET(self):
        self._antworte(200, {"dienst": "websuche", "status": "ok"})

    def _antworte(self, code: int, ausgabe: dict):
        daten = json.dumps(ausgabe, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(daten)))
        self.end_headers()
        self.wfile.write(daten)

    def log_message(self, *a):
        pass


def starte(port: int = PORT):
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    starte()
