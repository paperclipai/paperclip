from backends import BackendFehler
from server import behandle_suche

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
