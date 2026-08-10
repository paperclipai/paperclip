import time

import pytest

import abruf
from abruf import AbrufErgebnis
from backends import BackendFehler, Treffer
from websuche import recherchiere, registrierbare_domain


class FakeBackend:
    def __init__(self, treffer):
        self.treffer = treffer
        self.limit = None

    def suche(self, frage, limit):
        self.limit = limit
        return self.treffer


class KaputtesBackend:
    def suche(self, frage, limit):
        raise BackendFehler("SearXNG nicht erreichbar")


def t(url, titel="T"):
    return Treffer(url=url, titel=titel, snippet="s")


def abrufer_ok(url, max_zeichen, timeout):
    return AbrufErgebnis(text=f"Text von {url}")


def test_registrierbare_domain_einfach():
    assert registrierbare_domain("https://www.beispiel.de/a/b") == "beispiel.de"


def test_registrierbare_domain_mehrteilige_endung():
    assert registrierbare_domain("https://shop.firma.co.uk/x") == "firma.co.uk"


def test_registrierbare_domain_ohne_subdomain():
    assert registrierbare_domain("https://bmwk.de/") == "bmwk.de"


def test_dedupliziert_nach_domain():
    backend = FakeBackend([t("https://bmwk.de/a"), t("https://bmwk.de/b"),
                           t("https://eu.int/c"), t("https://ihk.de/d")])
    ergebnis = recherchiere("f", quellen=3, backend=backend,
                            abrufer=abrufer_ok)
    domains = [q["domain"] for q in ergebnis["quellen"]]
    assert domains == ["bmwk.de", "eu.int", "ihk.de"]


def test_gleiche_domain_erlauben_hebt_deduplizierung_auf():
    backend = FakeBackend([t("https://bmwk.de/a"), t("https://bmwk.de/b"),
                           t("https://bmwk.de/c")])
    ergebnis = recherchiere("f", quellen=3, gleiche_domain_erlauben=True,
                            backend=backend, abrufer=abrufer_ok)
    assert len(ergebnis["quellen"]) == 3


def test_fragt_backend_ueberzaehlig_ab():
    backend = FakeBackend([t("https://a.de/1")])
    recherchiere("f", quellen=3, backend=backend, abrufer=abrufer_ok)
    assert backend.limit == 10  # max(10, 3*3)


def test_ueberzaehliges_limit_skaliert_mit_quellen():
    backend = FakeBackend([t("https://a.de/1")])
    recherchiere("f", quellen=5, backend=backend, abrufer=abrufer_ok)
    assert backend.limit == 15  # max(10, 5*3)


def test_backend_fehler_wird_durchgereicht():
    with pytest.raises(BackendFehler):
        recherchiere("f", backend=KaputtesBackend(), abrufer=abrufer_ok)


def test_einzelne_fehlerquelle_kippt_den_lauf_nicht():
    def abrufer(url, max_zeichen, timeout):
        if "b.de" in url:
            return AbrufErgebnis(fehler="HTTP 403")
        return AbrufErgebnis(text="ok")

    backend = FakeBackend([t("https://a.de/1"), t("https://b.de/2"),
                           t("https://c.de/3")])
    ergebnis = recherchiere("f", quellen=3, backend=backend, abrufer=abrufer)
    nach_domain = {q["domain"]: q for q in ergebnis["quellen"]}
    assert nach_domain["b.de"]["fehler"] == "HTTP 403"
    assert "text" not in nach_domain["b.de"]
    assert nach_domain["a.de"]["text"] == "ok"
    assert ergebnis["hinweis"] is None


def test_hinweis_wenn_weniger_als_zwei_quellen_mit_text():
    def abrufer(url, max_zeichen, timeout):
        if "a.de" in url:
            return AbrufErgebnis(text="ok")
        return AbrufErgebnis(fehler="HTTP 403")

    backend = FakeBackend([t("https://a.de/1"), t("https://b.de/2")])
    ergebnis = recherchiere("f", quellen=2, backend=backend, abrufer=abrufer)
    assert ergebnis["hinweis"] is not None
    assert "eine" in ergebnis["hinweis"].lower()


def test_hinweis_wenn_gar_keine_treffer():
    backend = FakeBackend([])
    ergebnis = recherchiere("f", backend=backend, abrufer=abrufer_ok)
    assert ergebnis["quellen"] == []
    assert ergebnis["hinweis"] is not None


class WarnendesBackend(FakeBackend):
    def __init__(self, treffer, warnung):
        super().__init__(treffer)
        self.letzte_warnung = warnung


def test_backend_warnung_landet_im_hinweis():
    """Ausgefallene Engines duerfen das Ergebnis nicht kippen, aber sie
    muessen im Ergebnis sichtbar sein — sonst haelt der Agent eine
    halbierte Trefferliste fuer die volle Lage."""
    backend = WarnendesBackend([t("https://a.de/1"), t("https://b.de/2")],
                               "3 Suchmaschinen waren ausgefallen (startpage, brave, ddg)")
    ergebnis = recherchiere("f", quellen=2, backend=backend, abrufer=abrufer_ok)
    assert len(ergebnis["quellen"]) == 2  # nicht blockiert
    assert "startpage" in ergebnis["hinweis"]


def test_backend_warnung_verdraengt_den_quellen_hinweis_nicht():
    def abrufer(url, max_zeichen, timeout):
        if "a.de" in url:
            return AbrufErgebnis(text="ok")
        return AbrufErgebnis(fehler="HTTP 403")

    backend = WarnendesBackend([t("https://a.de/1"), t("https://b.de/2")],
                               "3 Suchmaschinen waren ausgefallen")
    ergebnis = recherchiere("f", quellen=2, backend=backend, abrufer=abrufer)
    assert "Nur eine Quelle" in ergebnis["hinweis"]
    assert "ausgefallen" in ergebnis["hinweis"]


def test_ohne_backend_warnung_bleibt_hinweis_null():
    backend = WarnendesBackend([t("https://a.de/1"), t("https://b.de/2")], None)
    ergebnis = recherchiere("f", quellen=2, backend=backend, abrufer=abrufer_ok)
    assert ergebnis["hinweis"] is None


def test_alle_quellen_eines_laufs_teilen_einen_robots_speicher(monkeypatch):
    """Ohne geteilten Speicher holt jede Seite ihre robots.txt neu und
    verbrennt Zeitbudget, das dem Zielserver fehlt."""
    gesehen = []

    def falsches_hole_text(url, max_zeichen=12000, timeout=10.0, robots=None):
        gesehen.append(robots)
        return AbrufErgebnis(text="ok")

    monkeypatch.setattr(abruf, "hole_text", falsches_hole_text)
    backend = FakeBackend([t("https://a.de/1"), t("https://b.de/2")])
    recherchiere("f", quellen=2, backend=backend)  # kein abrufer: Standardweg
    assert len(gesehen) == 2
    assert gesehen[0] is not None
    assert gesehen[0] is gesehen[1]


def test_jeder_lauf_bekommt_einen_frischen_robots_speicher(monkeypatch):
    gesehen = []

    def falsches_hole_text(url, max_zeichen=12000, timeout=10.0, robots=None):
        gesehen.append(robots)
        return AbrufErgebnis(text="ok")

    monkeypatch.setattr(abruf, "hole_text", falsches_hole_text)
    backend = FakeBackend([t("https://a.de/1")])
    recherchiere("f", quellen=1, backend=backend)
    recherchiere("f", quellen=1, backend=backend)
    assert gesehen[0] is not gesehen[1]


def test_jede_quelle_traegt_abrufdatum_und_url():
    backend = FakeBackend([t("https://a.de/1", titel="Titel A")])
    ergebnis = recherchiere("f", quellen=1, backend=backend,
                            abrufer=abrufer_ok)
    quelle = ergebnis["quellen"][0]
    assert quelle["url"] == "https://a.de/1"
    assert quelle["titel"] == "Titel A"
    assert quelle["abgerufen_am"] == ergebnis["abgerufen_am"]
    assert len(quelle["abgerufen_am"]) == 10  # YYYY-MM-DD


def test_zeichenbudget_wird_an_abrufer_gereicht():
    gesehen = {}

    def abrufer(url, max_zeichen, timeout):
        gesehen["zeichen"] = max_zeichen
        return AbrufErgebnis(text="ok")

    backend = FakeBackend([t("https://a.de/1")])
    recherchiere("f", quellen=1, zeichen=500, backend=backend, abrufer=abrufer)
    assert gesehen["zeichen"] == 500


def test_abrufe_derselben_domain_ueberlappen_nicht(monkeypatch):
    """Mehrere Seiten einer Domain duerfen nicht gleichzeitig abgerufen werden.

    Greift nur bei --gleiche-domain-erlauben; im Normalfall verhindert die
    Deduplizierung den Fall ohnehin.
    """
    import threading

    import websuche as w
    monkeypatch.setattr(w, "PAUSE_GLEICHE_DOMAIN", 0.01)

    gleichzeitig, hoechststand, sperre = 0, [0], threading.Lock()

    def abrufer(url, max_zeichen, timeout):
        nonlocal gleichzeitig
        with sperre:
            gleichzeitig += 1
            hoechststand[0] = max(hoechststand[0], gleichzeitig)
        time.sleep(0.05)
        with sperre:
            gleichzeitig -= 1
        return AbrufErgebnis(text="ok")

    backend = FakeBackend([t("https://a.de/1"), t("https://a.de/2"),
                           t("https://a.de/3")])
    recherchiere("f", quellen=3, gleiche_domain_erlauben=True,
                 backend=backend, abrufer=abrufer)
    assert hoechststand[0] == 1


def test_abrufe_verschiedener_domains_laufen_parallel(monkeypatch):
    import threading

    import websuche as w
    monkeypatch.setattr(w, "PAUSE_GLEICHE_DOMAIN", 0.01)

    gleichzeitig, hoechststand, sperre = 0, [0], threading.Lock()

    def abrufer(url, max_zeichen, timeout):
        nonlocal gleichzeitig
        with sperre:
            gleichzeitig += 1
            hoechststand[0] = max(hoechststand[0], gleichzeitig)
        time.sleep(0.05)
        with sperre:
            gleichzeitig -= 1
        return AbrufErgebnis(text="ok")

    backend = FakeBackend([t("https://a.de/1"), t("https://b.de/2"),
                           t("https://c.de/3")])
    recherchiere("f", quellen=3, backend=backend, abrufer=abrufer)
    assert hoechststand[0] > 1


def test_gesamt_deadline_wird_durchgesetzt():
    """Ein Abrufer, der die Deadline weit ueberschreitet, darf recherchiere()
    nicht laenger als das Deadline-Budget blockieren — sonst reisst der
    30s-Deckel von shell_exec, der ueber der 25s-Default-Deadline liegt.
    """
    def abrufer(url, max_zeichen, timeout):
        time.sleep(1.0)
        return AbrufErgebnis(text="ok")

    backend = FakeBackend([t("https://a.de/1")])
    start = time.monotonic()
    ergebnis = recherchiere("f", quellen=1, deadline=0.2, backend=backend,
                            abrufer=abrufer)
    dauer = time.monotonic() - start
    assert dauer < 0.8  # deutlich unter dem 1.0s-Schlaf des Abrufers
    quelle = ergebnis["quellen"][0]
    assert "fehler" in quelle
    assert "text" not in quelle
