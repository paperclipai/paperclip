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


def test_beende_leert_puffer_und_beendet_sofort(monkeypatch):
    """Der Prozess darf nicht auf noch laufende Abruf-Threads warten.

    Pythons atexit joint die Worker des ThreadPoolExecutor; gemessen kehrte
    recherchiere() nach 0,21 s zurueck, der Prozess endete erst nach 3,04 s.
    Unter shell_exec zaehlt die Prozesslaufzeit, nicht die Funktionslaufzeit.
    """
    import cli as c

    geleert, beendet = [], []
    monkeypatch.setattr(c.sys.stdout, "flush", lambda: geleert.append("out"))
    monkeypatch.setattr(c.sys.stderr, "flush", lambda: geleert.append("err"))
    monkeypatch.setattr(c.os, "_exit", lambda code: beendet.append(code))

    c.beende(2)
    assert beendet == [2]
    assert set(geleert) == {"out", "err"}


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
