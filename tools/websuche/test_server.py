import time

import pytest

from backends import BackendFehler
from server import _zu_bool, behandle_suche

ERGEBNIS = {"frage": "f", "abgerufen_am": "2026-08-10", "quellen": [],
            "hinweis": "Keine Quelle lieferte verwertbaren Text."}


def test_suche_liefert_200_und_ergebnis():
    code, rumpf = behandle_suche({"frage": "f"},
                                 rechercheur=lambda *a, **k: ERGEBNIS)
    assert code == 200
    assert rumpf == ERGEBNIS


def test_fehlende_frage_gibt_400():
    code, rumpf = behandle_suche({}, rechercheur=lambda *a, **k: ERGEBNIS)
    assert code == 400
    assert "frage" in rumpf["fehler"]


def test_leere_frage_gibt_400():
    code, rumpf = behandle_suche({"frage": "   "},
                                 rechercheur=lambda *a, **k: ERGEBNIS)
    assert code == 400


def test_backend_fehler_gibt_503():
    def rechercheur(*a, **k):
        raise BackendFehler("SearXNG nicht erreichbar")

    code, rumpf = behandle_suche({"frage": "f"}, rechercheur=rechercheur)
    assert code == 503
    assert "SearXNG nicht erreichbar" in rumpf["fehler"]
    assert "quellen" not in rumpf


def test_parameter_werden_durchgereicht():
    gesehen = {}

    def rechercheur(frage, **kwargs):
        gesehen.update(kwargs, frage=frage)
        return ERGEBNIS

    behandle_suche({"frage": "f", "quellen": 5, "zeichen": 500,
                    "deadline": 40, "gleiche_domain_erlauben": True},
                   rechercheur=rechercheur)
    assert gesehen == {"frage": "f", "quellen": 5, "zeichen": 500,
                       "deadline": 40.0, "gleiche_domain_erlauben": True}


def test_standardwerte_ohne_parameter():
    gesehen = {}

    def rechercheur(frage, **kwargs):
        gesehen.update(kwargs)
        return ERGEBNIS

    behandle_suche({"frage": "f"}, rechercheur=rechercheur)
    assert gesehen == {"quellen": 3, "zeichen": 12000, "deadline": 25.0,
                       "gleiche_domain_erlauben": False}


def test_unerwarteter_fehler_gibt_500():
    def rechercheur(*a, **k):
        raise RuntimeError("kaputt")

    code, rumpf = behandle_suche({"frage": "f"}, rechercheur=rechercheur)
    assert code == 500
    assert "kaputt" in rumpf["fehler"]


def test_nicht_objekt_gibt_400():
    """Nicht-objekthafte Bodies (Array, String, Zahl) ergeben HTTP 400."""
    for body in [[1, 2, 3], "string", 42, True, None]:
        code, rumpf = behandle_suche(body, rechercheur=lambda *a, **k: ERGEBNIS)
        assert code == 400
        assert "Objekt" in rumpf["fehler"]


def test_string_false_wird_falsch():
    """Der String 'false' soll zu False konvertiert werden, nicht True."""
    gesehen = {}

    def rechercheur(frage, **kwargs):
        gesehen.update(kwargs)
        return ERGEBNIS

    behandle_suche({"frage": "f", "gleiche_domain_erlauben": "false"},
                   rechercheur=rechercheur)
    assert gesehen["gleiche_domain_erlauben"] is False

    # Auch "0", "", "nein" sollen False sein
    for wert in ["0", "", "nein"]:
        gesehen.clear()
        behandle_suche({"frage": "f", "gleiche_domain_erlauben": wert},
                       rechercheur=rechercheur)
        assert gesehen["gleiche_domain_erlauben"] is False, f"'{wert}' sollte False sein"


# --- Eingabepruefung (I3) -------------------------------------------------

def test_unlesbare_zahl_gibt_400_statt_500():
    """int("drei") ergab HTTP 500 — ein Serverfehler fuer einen Client-Fehler."""
    code, rumpf = behandle_suche({"frage": "f", "quellen": "drei"},
                                 rechercheur=lambda *a, **k: ERGEBNIS)
    assert code == 400
    assert "quellen" in rumpf["fehler"]


def test_unlesbare_deadline_gibt_400():
    code, rumpf = behandle_suche({"frage": "f", "deadline": "bald"},
                                 rechercheur=lambda *a, **k: ERGEBNIS)
    assert code == 400
    assert "deadline" in rumpf["fehler"]


@pytest.mark.parametrize("feld,wert", [
    ("quellen", 0), ("quellen", -3), ("quellen", 500),
    ("zeichen", 0), ("zeichen", 5_000_000),
    ("deadline", 0), ("deadline", -1), ("deadline", 3600),
])
def test_zahlen_ausserhalb_der_grenzen_geben_400(feld, wert):
    """Ein fehlerhafter n8n-Ausdruck darf den Dienst nicht minutenlang
    blockieren — und 500 Quellen waeren 1500 Seitenabrufe."""
    code, rumpf = behandle_suche({"frage": "f", feld: wert},
                                 rechercheur=lambda *a, **k: ERGEBNIS)
    assert code == 400, f"{feld}={wert} wurde durchgelassen"
    assert feld in rumpf["fehler"]


def test_werte_an_den_grenzen_kommen_durch():
    gesehen = {}

    def rechercheur(frage, **kwargs):
        gesehen.update(kwargs)
        return ERGEBNIS

    code, _ = behandle_suche({"frage": "f", "quellen": 10, "zeichen": 100,
                              "deadline": 120}, rechercheur=rechercheur)
    assert code == 200
    assert gesehen["quellen"] == 10 and gesehen["deadline"] == 120.0


def test_bool_ist_keine_zahl():
    code, rumpf = behandle_suche({"frage": "f", "quellen": True},
                                 rechercheur=lambda *a, **k: ERGEBNIS)
    assert code == 400


def test_zahl_als_string_wird_akzeptiert():
    """n8n schickt Zahlen haeufig als Strings."""
    gesehen = {}

    def rechercheur(frage, **kwargs):
        gesehen.update(kwargs)
        return ERGEBNIS

    code, _ = behandle_suche({"frage": "f", "quellen": "5"},
                             rechercheur=rechercheur)
    assert code == 200
    assert gesehen["quellen"] == 5


def test_zu_bool_kennt_die_ueblichen_neins():
    for wert in ["no", "No", "off", "OFF", "n", "N", " false ", "  nein  ",
                 " 0 ", "false", "0", "", "nein"]:
        assert _zu_bool(wert) is False, f"'{wert}' sollte False sein"
    for wert in ["ja", "yes", "true", "1", " an "]:
        assert _zu_bool(wert) is True, f"'{wert}' sollte True sein"


# --- Nebenlaeufigkeit (I2) ------------------------------------------------

def test_dienst_bearbeitet_anfragen_nebenlaeufig(monkeypatch):
    """HTTPServer verarbeitet genau eine Anfrage gleichzeitig — bei bis zu
    25 s je Anfrage und drei erklaerten Nutzern (n8n, Jarvis, Luna) wartet
    der zweite Aufrufer die volle Zeit des ersten ab.
    """
    import json as _json
    import threading
    import urllib.request

    import server as s

    def langsam(frage, **kwargs):
        time.sleep(0.6)
        return ERGEBNIS

    monkeypatch.setattr(s, "recherchiere", langsam)

    dienst = s.baue(0)
    port = dienst.server_address[1]
    threading.Thread(target=dienst.serve_forever, daemon=True).start()
    try:
        antworten = []

        def anfrage():
            daten = _json.dumps({"frage": "f"}).encode()
            bitte = urllib.request.Request(
                f"http://127.0.0.1:{port}/suche", data=daten,
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(bitte, timeout=10) as antwort:
                antworten.append(antwort.status)

        start = time.monotonic()
        faeden = [threading.Thread(target=anfrage) for _ in range(3)]
        for faden in faeden:
            faden.start()
        for faden in faeden:
            faden.join()
        dauer = time.monotonic() - start
    finally:
        dienst.shutdown()
        dienst.server_close()

    assert antworten == [200, 200, 200]
    assert dauer < 1.2, (f"3 Anfragen a 0,6 s brauchten {dauer:.2f}s — "
                         f"sie liefen nacheinander")
