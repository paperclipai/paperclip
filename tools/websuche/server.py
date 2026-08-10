#!/usr/bin/env python3
"""Kleiner lokaler HTTP-Dienst um `websuche` — fuer n8n, Jarvis und Luna.

POST /suche  {"frage": "...", "quellen": 3, "zeichen": 12000,
              "deadline": 25, "gleiche_domain_erlauben": false}  -> JSON
Nur 127.0.0.1, keine Auth (lokal gebunden) — dieselbe Bauform wie
tools/vault-lookup/server.py.
"""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from backends import BackendFehler
from websuche import recherchiere

PORT = 7789

NEIN_WOERTER = ("false", "0", "", "nein", "no", "off", "n", "f")

# Ober- und Untergrenzen der Zahlenfelder: (Typ, min, max).
# Ohne sie reicht ein fehlerhafter n8n-Ausdruck, um den Dienst minutenlang
# zu blockieren (deadline) oder ihn in hunderte Seitenabrufe zu schicken
# (quellen — abgefragt wird ueberzaehlig mit quellen * 3).
# 120 s als Deckel entspricht dem MAX_TIMEOUT_MS des lmstudio-Adapters.
GRENZEN = {
    "quellen": (int, 1, 10),
    "zeichen": (int, 100, 100_000),
    "deadline": (float, 1.0, 120.0),
}


class FeldFehler(ValueError):
    """Der Aufrufer hat ein Feld falsch gefuellt — HTTP 400, nicht 500."""


def _zu_bool(wert, standard=False):
    """String-sichere Bool-Konversion.

    - True/False: direkt durchlässig
    - "false", "0", "", "nein", "no", "off", "n", "f" (auch mit Leerraum
      und in Grossschreibung): False
    - Alle anderen Strings: True (nicht leer)
    - Andere Typen: bool()
    """
    if isinstance(wert, bool):
        return wert
    if isinstance(wert, str):
        return wert.strip().lower() not in NEIN_WOERTER
    return bool(wert) if wert is not None else standard


def _zahl(rumpf: dict, feld: str, standard):
    """Liest ein Zahlenfeld und haelt es in seinen Grenzen."""
    typ, klein, gross = GRENZEN[feld]
    roh = rumpf.get(feld, standard)
    # bool ist in Python ein int: True wuerde sonst klaglos zu 1 Quelle.
    if isinstance(roh, bool) or isinstance(roh, (list, dict, type(None))):
        raise FeldFehler(f"Feld '{feld}' muss eine Zahl sein, nicht {roh!r}")
    try:
        wert = typ(roh)
    except (TypeError, ValueError):
        raise FeldFehler(
            f"Feld '{feld}' muss eine Zahl sein, nicht {roh!r}") from None
    if wert != wert or wert in (float("inf"), float("-inf")):
        raise FeldFehler(f"Feld '{feld}' ist keine endliche Zahl: {roh!r}")
    if not klein <= wert <= gross:
        raise FeldFehler(
            f"Feld '{feld}' liegt ausserhalb des erlaubten Bereichs "
            f"{klein}..{gross}: {wert}")
    return wert


def behandle_suche(rumpf: dict, rechercheur=None) -> tuple[int, dict]:
    rechercheur = rechercheur or recherchiere
    if not isinstance(rumpf, dict):
        return 400, {"fehler": "Body muss ein JSON-Objekt sein"}
    frage = (rumpf.get("frage") or "").strip()
    if not frage:
        return 400, {"fehler": "Feld 'frage' fehlt oder ist leer"}
    try:
        quellen = _zahl(rumpf, "quellen", 3)
        zeichen = _zahl(rumpf, "zeichen", 12000)
        deadline = _zahl(rumpf, "deadline", 25.0)
    except FeldFehler as e:
        return 400, {"fehler": str(e)}
    try:
        ergebnis = rechercheur(
            frage,
            quellen=quellen,
            zeichen=zeichen,
            deadline=deadline,
            gleiche_domain_erlauben=_zu_bool(rumpf.get("gleiche_domain_erlauben", False)),
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


def baue(port: int = PORT) -> ThreadingHTTPServer:
    """ThreadingHTTPServer statt HTTPServer.

    Der einfache HTTPServer bearbeitet genau eine Anfrage gleichzeitig. Bei
    bis zu 25 Sekunden je Anfrage und drei erklaerten Nutzern (n8n, Jarvis,
    Luna) wartet der zweite Aufrufer die volle Zeit des ersten ab und laeuft
    dabei in sein eigenes Timeout.

    `port=0` waehlt einen freien Port — dafuer gedacht, dass Tests den
    echten Dienst starten koennen, ohne 7789 zu belegen.
    """
    dienst = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    # Kein Warten auf offene Verbindungen beim Beenden: die Abrufe sind
    # ohnehin durch das Seitenbudget gedeckelt.
    dienst.daemon_threads = True
    return dienst


def starte(port: int = PORT):
    baue(port).serve_forever()


if __name__ == "__main__":
    starte()
