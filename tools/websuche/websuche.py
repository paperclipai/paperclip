"""Orchestrierung: suchen, nach Domain deduplizieren, parallel abrufen.

Der einzige Einstiegspunkt für Aufrufer ist `recherchiere()`. CLI und
HTTP-Dienst sind duenne Huellen darum.
"""
from __future__ import annotations

import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import date
from urllib.parse import urlparse

import abruf
from backends import SearxngBackend

# Pause zwischen zwei Abrufen derselben Domain. Greift praktisch nur bei
# gleiche_domain_erlauben=True — sonst verhindert die Deduplizierung den Fall.
PAUSE_GLEICHE_DOMAIN = 1.0

# Zaehler der Abrufe, deren Thread beim Ueberschreiten der Deadline
# zurueckgelassen wurde. Kein Ersatz fuer einen Waechter, aber der Unterschied
# zwischen einem Leck, das jemand sieht, und einem, das niemand sieht. Der
# HTTP-Dienst weist den Stand unter GET / aus.
_aufgabe_sperre = threading.Lock()
_aufgegebene_abrufe = 0


def aufgegebene_abrufe() -> int:
    """Wie viele Abruf-Threads seit dem Start aufgegeben wurden."""
    with _aufgabe_sperre:
        return _aufgegebene_abrufe


def _vermerke_aufgabe(url: str, lauf, start: float) -> None:
    global _aufgegebene_abrufe
    with _aufgabe_sperre:
        _aufgegebene_abrufe += 1
        stand = _aufgegebene_abrufe
    print(f"[websuche] Abruf bei Deadline aufgegeben, Thread laeuft weiter: "
          f"{url} (aufgegeben seit Start: {stand})", file=sys.stderr, flush=True)

    def spaet_fertig(_zukunft):
        # Zeigt im Log, wie weit ueber das Budget der Thread wirklich lief —
        # daran laesst sich ablesen, ob ein Waechter dringend wird.
        print(f"[websuche] aufgegebener Abruf endete erst nach "
              f"{time.monotonic() - start:.1f}s: {url}",
              file=sys.stderr, flush=True)

    lauf.add_done_callback(spaet_fertig)

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


def _hinweis(quellen: list[dict], backend_warnung: str | None = None) -> str | None:
    mit_text = sum(1 for q in quellen if "text" in q)
    if mit_text >= 2:
        satz = None
    elif mit_text == 1:
        satz = ("Nur eine Quelle lieferte verwertbaren Text. Fuer eine belastbare "
                "Aussage sind mindestens zwei unabhaengige Quellen noetig — "
                "Suche mit anderen Begriffen wiederholen oder --quellen erhoehen.")
    else:
        satz = ("Keine Quelle lieferte verwertbaren Text. Suche mit anderen "
                "Begriffen wiederholen; die Frage ggf. enger fassen.")
    # Die Backend-Warnung (ausgefallene Engines) ergaenzt den Quellen-Hinweis,
    # statt ihn zu ersetzen: beides sind eigenstaendige Luecken im Ergebnis.
    teile = [t for t in (satz, backend_warnung) if t]
    return " ".join(teile) if teile else None


def recherchiere(frage: str, *, quellen: int = 3, zeichen: int = 12000,
                 deadline: float = 25.0, gleiche_domain_erlauben: bool = False,
                 backend=None, abrufer=None) -> dict:
    backend = backend or SearxngBackend()
    if abrufer is None:
        # Ein robots-Speicher je Lauf: mehrere Seiten derselben Domain (und
        # Weiterleitungen innerhalb einer Domain) holen die robots.txt sonst
        # jedes Mal neu und nehmen dem Zielserver sein Zeitbudget weg. Die
        # Bindung geschieht hier, damit eingesetzte Test-Abrufer bei der
        # schlichten Signatur (url, zeichen, timeout) bleiben duerfen.
        speicher = abruf.RobotsSpeicher()

        def abrufer(url, zeichen_, timeout_):
            return abruf.hole_text(url, zeichen_, timeout_, robots=speicher)

    # Uhr fuer die Gesamt-Deadline laeuft ab hier — sie deckt Suche UND Abruf,
    # denn beides zaehlt fuer den Aufrufer (z.B. der 30s-Deckel von shell_exec).
    start = time.monotonic()

    # Ueberzaehlig abfragen: die Deduplizierung verwirft Treffer, und ohne
    # Reserve bleiben sonst regelmaessig weniger Quellen uebrig als angefordert.
    kandidaten = backend.suche(frage, limit=max(10, quellen * 3))
    # Nicht-blockierende Meldung der Suchquelle (z.B. ausgefallene Engines).
    # Optional per Duck-Typing, damit fremde Backends sie nicht kennen muessen.
    backend_warnung = getattr(backend, "letzte_warnung", None)
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

    # Kein `with`-Block: dessen Ausstieg riefe implizit shutdown(wait=True) auf
    # und wuerde blockieren, bis JEDER Thread fertig ist — auch die, deren
    # Ergebnis wir per Deadline laengst aufgegeben haben. Python-Threads lassen
    # sich nicht von aussen abbrechen, also muss der Aufrufer zurueckkehren
    # duerfen, waehrend ein haengender Thread im Hintergrund weiterlaeuft.
    #
    # Im Dienst (wochenlang laufender Prozess) wird ein solcher Thread nicht
    # eingesammelt — im CLI raeumt os._exit auf.
    #
    # Hier stand frueher, ein Waechter sei nicht noetig, weil `abruf.hole_text`
    # ein HARTES Gesamtbudget je Seite fuehre und ein aufgegebener Thread
    # deshalb von selbst kurz nach `seiten_timeout` ende. Das war unzutreffend
    # und ist es auch nach dem Umbau des Abrufs nur noch fast: der Regelfall
    # und der troepfelnde Server enden im Budget (gemessen 1,03 s bei 1,0 s),
    # aber ein Server, der ununterbrochen gueltige Bytes ohne Nutzinhalt
    # schickt (leere gzip-Bloecke, endlose chunked-Groessenzeile), haelt den
    # Thread in einer Leseschleife unterhalb von urllib3 fest — gemessen 20
    # bis 30 s bei 1,0 s Budget. Siehe abruf.py, "WAS DAS ZEITBUDGET WIRKLICH
    # LEISTET".
    #
    # Ein solcher Thread haelt weiterhin hoechstens MAX_RUMPF_BYTES, aber die
    # Begruendung fuer den fehlenden Waechter traegt nicht mehr. Bis es einen
    # gibt, wird das Aufgeben wenigstens gezaehlt und protokolliert — ein
    # stiller Verlust von Threads und Sockets ist das, was in einem
    # wochenlang laufenden Dienst niemand bemerkt.
    pool = ThreadPoolExecutor(max_workers=max(1, len(gewaehlt)))
    laeufe = [pool.submit(hole, k.url, domain) for k, domain in gewaehlt]

    # Restbudget statt volles `deadline` je Future: sonst summieren sich bei
    # seriellem Abruf derselben Domain mehrere volle Fenster und die
    # Gesamt-Deadline greift nie.
    verstrichen = time.monotonic() - start
    restbudget = max(0.0, deadline - verstrichen)
    fertig, unfertig = wait(laeufe, timeout=restbudget)
    pool.shutdown(wait=False)

    ergebnisse = []
    for lauf, (kandidat, _domain) in zip(laeufe, gewaehlt):
        if lauf in unfertig:
            _vermerke_aufgabe(kandidat.url, lauf, start)
            ergebnisse.append(abruf.AbrufErgebnis(
                fehler=f"Abbruch: Deadline von {deadline}s ueberschritten"))
            continue
        try:
            ergebnisse.append(lauf.result())
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
            "hinweis": _hinweis(ausgabe, backend_warnung)}
