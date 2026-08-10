import os
import subprocess
import sys
import time

import pytest

from backends import BackendFehler
from cli import als_markdown, main

HIER = os.path.dirname(os.path.abspath(__file__))

ERGEBNIS = {
    "frage": "foerdermittel nrw",
    "abgerufen_am": "2026-08-10",
    "quellen": [
        {"url": "https://a.de/1", "titel": "Titel A", "domain": "a.de",
         "abgerufen_am": "2026-08-10", "text": "Inhalt A"},
        {"url": "https://b.org/2", "titel": "Titel B", "domain": "b.org",
         "abgerufen_am": "2026-08-10", "fehler": "HTTP 403"},
    ],
    "hinweis": None,
}


def test_markdown_nennt_url_titel_und_abrufdatum():
    text = als_markdown(ERGEBNIS)
    assert "Titel A" in text
    assert "https://a.de/1" in text
    assert "2026-08-10" in text
    assert "Inhalt A" in text


def test_markdown_zeigt_fehlerquelle_als_fehler():
    text = als_markdown(ERGEBNIS)
    assert "HTTP 403" in text


def test_markdown_zeigt_hinweis_wenn_gesetzt():
    text = als_markdown({**ERGEBNIS, "hinweis": "Nur eine Quelle."})
    assert "Nur eine Quelle." in text


def test_main_gibt_markdown_aus(capsys):
    code = main(["frage"], rechercheur=lambda *a, **k: ERGEBNIS)
    assert code == 0
    assert "Titel A" in capsys.readouterr().out


def test_main_json_flag_gibt_json_aus(capsys):
    code = main(["frage", "--json"], rechercheur=lambda *a, **k: ERGEBNIS)
    assert code == 0
    import json
    assert json.loads(capsys.readouterr().out)["frage"] == "foerdermittel nrw"


def test_main_reicht_parameter_durch():
    gesehen = {}

    def rechercheur(frage, **kwargs):
        gesehen.update(kwargs, frage=frage)
        return ERGEBNIS

    main(["meine frage", "--quellen", "5", "--zeichen", "500",
          "--deadline", "40", "--gleiche-domain-erlauben"],
         rechercheur=rechercheur)
    assert gesehen["frage"] == "meine frage"
    assert gesehen["quellen"] == 5
    assert gesehen["zeichen"] == 500
    assert gesehen["deadline"] == 40.0
    assert gesehen["gleiche_domain_erlauben"] is True


def test_main_standardwerte():
    gesehen = {}

    def rechercheur(frage, **kwargs):
        gesehen.update(kwargs)
        return ERGEBNIS

    main(["frage"], rechercheur=rechercheur)
    assert gesehen["quellen"] == 3
    assert gesehen["zeichen"] == 12000
    assert gesehen["deadline"] == 25.0
    assert gesehen["gleiche_domain_erlauben"] is False


def test_backend_fehler_gibt_exit_code_ungleich_null(capsys):
    def rechercheur(*a, **k):
        raise BackendFehler("SearXNG nicht erreichbar")

    code = main(["frage"], rechercheur=rechercheur)
    assert code == 2
    ausgabe = capsys.readouterr()
    assert "SearXNG nicht erreichbar" in ausgabe.err
    assert ausgabe.out.strip() == ""


class Beendet(Exception):
    """Steht fuer os._exit: ab hier laeuft im echten Prozess nichts mehr."""


def test_beende_leert_beide_puffer_vor_dem_harten_ende(monkeypatch):
    """Der Prozess darf nicht auf noch laufende Abruf-Threads warten.

    Pythons atexit joint die Worker des ThreadPoolExecutor; gemessen kehrte
    recherchiere() nach 0,21 s zurueck, der Prozess endete erst nach 3,04 s.
    Unter shell_exec zaehlt die Prozesslaufzeit, nicht die Funktionslaufzeit.

    Der Ersatz fuer os._exit bricht den Kontrollfluss ab, statt
    zurueckzukehren — sonst waere die Reihenfolge egal und der Test koennte
    eine vertauschte Reihenfolge im Produktivcode nicht sehen: os._exit
    umgeht die normale Aufraeumroutine, ein Flush DANACH kaeme nie an.
    """
    import cli as c

    geleert, beim_ende = [], {}

    def falsches_exit(code):
        # Zustandsaufnahme im Moment des Endes, nicht danach.
        beim_ende["code"] = code
        beim_ende["geleert"] = list(geleert)
        raise Beendet()

    monkeypatch.setattr(c.sys.stdout, "flush", lambda: geleert.append("out"))
    monkeypatch.setattr(c.sys.stderr, "flush", lambda: geleert.append("err"))
    monkeypatch.setattr(c.os, "_exit", falsches_exit)

    with pytest.raises(Beendet):
        c.beende(2)

    assert beim_ende["code"] == 2
    assert beim_ende["geleert"] == ["out", "err"], (
        "Beim Aufruf von os._exit waren nicht beide Puffer geleert: "
        f"{beim_ende['geleert']}")


def test_beende_kehrt_nicht_zurueck(monkeypatch):
    """Nach beende() darf keine Zeile mehr laufen — sonst haelt genau das den
    Prozess auf, den os._exit beenden sollte."""
    import cli as c

    danach = []

    def falsches_exit(code):
        raise Beendet()

    monkeypatch.setattr(c.os, "_exit", falsches_exit)
    try:
        c.beende(0)
        danach.append("weitergelaufen")
    except Beendet:
        pass
    assert danach == []


TREIBER = '''
import sys, time
sys.path.insert(0, {pfad!r})
import abruf, cli
from backends import Treffer
from websuche import recherchiere


class Backend:
    letzte_warnung = None

    def suche(self, frage, limit):
        return [Treffer(url="https://a.de/1", titel="T", snippet="s")]


def haengender_abruf(url, zeichen, timeout):
    time.sleep(30)          # Seite, die nie antwortet
    return abruf.AbrufErgebnis(text="nie")


def rechercheur(frage, **kwargs):
    kwargs["deadline"] = 0.3
    return recherchiere(frage, backend=Backend(), abrufer=haengender_abruf,
                        **kwargs)


cli.beende(cli.main(["frage"], rechercheur=rechercheur))
'''


def test_prozesslaufzeit_bleibt_im_budget(tmp_path):
    """Misst die PROZESS-, nicht die Funktionslaufzeit.

    Der Deadline-Test in test_websuche.py misst, wann recherchiere()
    zurueckkehrt — und genau davon ist belegt, dass es die Sache nicht trifft
    (gemessen: Funktion 0,21 s, Prozess 3,04 s, weil Pythons atexit die
    ThreadPool-Worker joint). Unter shell_exec zaehlt aber die
    Prozesslaufzeit gegen den 30-Sekunden-Default des Adapters.

    Hier haengt ein Abruf-Thread 30 s. Ohne os._exit in cli.beende() haengt
    der Prozess mit.
    """
    treiber = tmp_path / "treiber.py"
    treiber.write_text(TREIBER.format(pfad=HIER))

    start = time.monotonic()
    try:
        lauf = subprocess.run([sys.executable, str(treiber)],
                              capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        pytest.fail("Prozess lief in den 20s-Deckel — er wartet auf den "
                    "haengenden Abruf-Thread")
    dauer = time.monotonic() - start

    assert lauf.returncode == 0, lauf.stderr
    # Die Ausgabe muss VOR dem harten Ende geschrieben sein.
    assert "Rechercheergebnis" in lauf.stdout
    assert "Abbruch" in lauf.stdout  # die haengende Quelle als Fehlerquelle
    assert dauer < 3.0, f"Prozess lief {dauer:.2f}s trotz 0,3s Deadline"


def test_shebang_zeigt_auf_einen_venv_interpreter():
    """`python3` ist auf dieser Maschine 3.9 ohne bs4 — live nachgewiesen:
    der Agent bekaeme einen Traceback statt eines Rechercheergebnisses."""
    with open(os.path.join(HIER, "cli.py")) as datei:
        erste = datei.readline().strip()
    assert erste.startswith("#!")
    assert erste != "#!/usr/bin/env python3"
    assert "venv" in erste, f"Shebang ohne venv-Interpreter: {erste}"


def test_shebang_interpreter_hat_die_abhaengigkeiten():
    with open(os.path.join(HIER, "cli.py")) as datei:
        pfad = datei.readline().strip()[2:]
    if not os.path.exists(pfad):
        pytest.skip(f"Interpreter {pfad} auf dieser Maschine nicht vorhanden")
    lauf = subprocess.run([pfad, "-c", "import bs4, requests"],
                          capture_output=True, text=True)
    assert lauf.returncode == 0, lauf.stderr


def test_markdown_gibt_fehlerquellen_kein_abrufdatum():
    """Ein "Abgerufen am" direkt ueber "Nicht abrufbar" laedt das Modell ein,
    die URL trotzdem zu zitieren — obwohl nie jemand die Seite gelesen hat."""
    text = als_markdown(ERGEBNIS)
    fehlerteil = text.split("## Quelle 2")[1]
    assert "Nicht abrufbar" in fehlerteil
    assert "Abgerufen am" not in fehlerteil
    # Die gelesene Quelle behaelt ihr Abrufdatum.
    gelesen = text.split("## Quelle 1")[1].split("## Quelle 2")[0]
    assert "Abgerufen am: 2026-08-10" in gelesen
