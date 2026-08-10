#!/usr/bin/env python3
"""CLI-Huelle um `websuche.recherchiere` — der Weg fuer Paperclip-Agenten.

Aufruf ueber shell_exec. Standard-Ausgabe ist Markdown, weil lokale Modelle
Fliesstext mit Ueberschriften spuerbar besser verwerten als verschachteltes
JSON; Gemma neigt bei JSON-Eingaben dazu, das Format zu imitieren statt den
Inhalt zu nutzen.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from backends import BackendFehler
from websuche import recherchiere


def als_markdown(ergebnis: dict) -> str:
    zeilen = [f"# Rechercheergebnis: {ergebnis['frage']}",
              f"Abgerufen am {ergebnis['abgerufen_am']}", ""]
    if ergebnis.get("hinweis"):
        zeilen += [f"**Hinweis:** {ergebnis['hinweis']}", ""]
    for nr, quelle in enumerate(ergebnis["quellen"], start=1):
        zeilen.append(f"## Quelle {nr}: {quelle['titel'] or quelle['domain']}")
        zeilen.append(f"URL: {quelle['url']}")
        zeilen.append(f"Abgerufen am: {quelle['abgerufen_am']}")
        zeilen.append("")
        if "text" in quelle:
            zeilen += [quelle["text"], ""]
        else:
            zeilen += [f"**Nicht abrufbar:** {quelle['fehler']}", ""]
    if not ergebnis["quellen"]:
        zeilen.append("_Keine Quellen._")
    return "\n".join(zeilen).rstrip() + "\n"


def main(argv: list[str], rechercheur=None) -> int:
    rechercheur = rechercheur or recherchiere
    p = argparse.ArgumentParser(
        prog="websuche",
        description="Sucht im Web, ruft die Seiten ab und gibt sie zitierfaehig aus.")
    p.add_argument("frage")
    p.add_argument("--quellen", type=int, default=3,
                   help="Anzahl verschiedener Quellen (Standard: 3)")
    p.add_argument("--zeichen", type=int, default=12000,
                   help="Zeichenbudget pro Quelle (Standard: 12000)")
    p.add_argument("--deadline", type=float, default=25.0,
                   help="Gesamt-Deadline in Sekunden (Standard: 25). Hoehere "
                        "Werte brauchen ein passendes timeout am shell_exec-Aufruf.")
    p.add_argument("--gleiche-domain-erlauben", action="store_true",
                   help="Mehrere Seiten derselben Domain als eigene Quellen zulassen")
    p.add_argument("--json", action="store_true", help="JSON statt Markdown ausgeben")
    args = p.parse_args(argv)

    try:
        ergebnis = rechercheur(
            args.frage,
            quellen=args.quellen,
            zeichen=args.zeichen,
            deadline=args.deadline,
            gleiche_domain_erlauben=args.gleiche_domain_erlauben,
        )
    except BackendFehler as e:
        # Bewusst kein leeres Ergebnis auf stdout: das laese sich als
        # "nichts gefunden" lesen.
        print(f"Websuche nicht moeglich: {e}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(ergebnis, ensure_ascii=False, indent=2))
    else:
        print(als_markdown(ergebnis), end="")
    return 0


def beende(code: int) -> None:
    """Beendet den Prozess sofort, ohne auf Hintergrund-Threads zu warten.

    Die Deadline aus `websuche.recherchiere()` begrenzt, wann die Funktion
    zurueckkehrt — nicht, wann der Prozess endet. Pythons atexit joint die
    Worker des ThreadPoolExecutor, ein noch laufender Seitenabruf haelt den
    Prozess also weiter auf (gemessen: Funktion 0,21 s, Prozess 3,04 s).
    Unter shell_exec zaehlt die Prozesslaufzeit — deshalb os._exit.

    Die Puffer werden vorher geleert: os._exit umgeht die normale
    Aufraeumroutine, sonst ginge die Ausgabe verloren.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    beende(main(sys.argv[1:]))
