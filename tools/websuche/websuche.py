"""Orchestrierung: suchen, nach Domain deduplizieren, parallel abrufen.

Der einzige Einstiegspunkt für Aufrufer ist `recherchiere()`. CLI und
HTTP-Dienst sind duenne Huellen darum.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from urllib.parse import urlparse

import abruf
from backends import SearxngBackend

# Pause zwischen zwei Abrufen derselben Domain. Greift praktisch nur bei
# gleiche_domain_erlauben=True — sonst verhindert die Deduplizierung den Fall.
PAUSE_GLEICHE_DOMAIN = 1.0

# Mehrteilige oeffentliche Endungen, die in unseren Recherchefeldern real
# vorkommen. Bewusst eine kurze Liste statt einer PSL-Abhaengigkeit: tldextract
# laedt die Public Suffix List zur Laufzeit nach, und dieser Dienst muss auch
# dann funktionieren, wenn genau das Netz gerade klemmt. Fehlt eine Endung,
# ist die Folge eine zu strenge Deduplizierung, kein falsches Zitat.
MEHRTEILIGE_ENDUNGEN = {
    "co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "net.au", "org.au",
    "co.nz", "co.jp", "com.br", "co.za", "com.tr",
}


def registrierbare_domain(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    teile = host.split(".")
    if len(teile) >= 3 and ".".join(teile[-2:]) in MEHRTEILIGE_ENDUNGEN:
        return ".".join(teile[-3:])
    if len(teile) >= 2:
        return ".".join(teile[-2:])
    return host


def _waehle_treffer(treffer, quellen, gleiche_domain_erlauben):
    gewaehlt, gesehen = [], set()
    for kandidat in treffer:
        domain = registrierbare_domain(kandidat.url)
        if not gleiche_domain_erlauben and domain in gesehen:
            continue
        gesehen.add(domain)
        gewaehlt.append((kandidat, domain))
        if len(gewaehlt) >= quellen:
            break
    return gewaehlt


def _hinweis(quellen: list[dict]) -> str | None:
    mit_text = sum(1 for q in quellen if "text" in q)
    if mit_text >= 2:
        return None
    if mit_text == 1:
        return ("Nur eine Quelle lieferte verwertbaren Text. Fuer eine belastbare "
                "Aussage sind mindestens zwei unabhaengige Quellen noetig — "
                "Suche mit anderen Begriffen wiederholen oder --quellen erhoehen.")
    return ("Keine Quelle lieferte verwertbaren Text. Suche mit anderen "
            "Begriffen wiederholen; die Frage ggf. enger fassen.")


def recherchiere(frage: str, *, quellen: int = 3, zeichen: int = 12000,
                 deadline: float = 25.0, gleiche_domain_erlauben: bool = False,
                 backend=None, abrufer=None) -> dict:
    backend = backend or SearxngBackend()
    abrufer = abrufer or abruf.hole_text

    # Ueberzaehlig abfragen: die Deduplizierung verwirft Treffer, und ohne
    # Reserve bleiben sonst regelmaessig weniger Quellen uebrig als angefordert.
    kandidaten = backend.suche(frage, limit=max(10, quellen * 3))
    gewaehlt = _waehle_treffer(kandidaten, quellen, gleiche_domain_erlauben)

    heute = date.today().isoformat()
    # Der Seitenabruf laeuft parallel: bei 10s pro Seite waeren drei Quellen
    # sequenziell schon ueber der 25s-Deadline.
    seiten_timeout = min(10.0, deadline)

    # Eine Sperre je Domain: verschiedene Domains laufen parallel, mehrere
    # Seiten derselben Domain nacheinander mit Pause dazwischen. Die Sperren
    # werden vorab angelegt, damit sie nicht selbst zur Race Condition werden.
    sperren = {domain: threading.Lock() for _, domain in gewaehlt}
    bereits_abgerufen: set[str] = set()

    def hole(url: str, domain: str):
        with sperren[domain]:
            if domain in bereits_abgerufen:
                time.sleep(PAUSE_GLEICHE_DOMAIN)
            bereits_abgerufen.add(domain)
            return abrufer(url, zeichen, seiten_timeout)

    with ThreadPoolExecutor(max_workers=max(1, len(gewaehlt))) as pool:
        laeufe = [pool.submit(hole, k.url, domain) for k, domain in gewaehlt]
        ergebnisse = []
        for lauf in laeufe:
            try:
                ergebnisse.append(lauf.result(timeout=deadline))
            except Exception as e:  # noqa: BLE001 — eine Seite darf den Lauf nie kippen
                ergebnisse.append(abruf.AbrufErgebnis(fehler=f"Abbruch: {e}"))

    ausgabe = []
    for (kandidat, domain), ergebnis in zip(gewaehlt, ergebnisse):
        eintrag = {"url": kandidat.url, "titel": kandidat.titel,
                   "domain": domain, "abgerufen_am": heute}
        if ergebnis.text is not None:
            eintrag["text"] = ergebnis.text
        else:
            eintrag["fehler"] = ergebnis.fehler
        ausgabe.append(eintrag)

    return {"frage": frage, "abgerufen_am": heute, "quellen": ausgabe,
            "hinweis": _hinweis(ausgabe)}
