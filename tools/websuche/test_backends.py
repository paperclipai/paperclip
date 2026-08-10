import pytest
import requests
import requests_mock

from backends import BackendFehler, SearxngBackend, Treffer

ANTWORT = {
    "results": [
        {"url": "https://a.de/x", "title": "Titel A", "content": "Ausschnitt A"},
        {"url": "https://b.org/y", "title": "Titel B", "content": "Ausschnitt B"},
    ]
}


def test_suche_wandelt_searxng_antwort_in_treffer():
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search", json=ANTWORT)
        treffer = SearxngBackend().suche("foerdermittel nrw", limit=10)
    assert treffer == [
        Treffer(url="https://a.de/x", titel="Titel A", snippet="Ausschnitt A"),
        Treffer(url="https://b.org/y", titel="Titel B", snippet="Ausschnitt B"),
    ]


def test_suche_uebergibt_frage_und_json_format():
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search", json=ANTWORT)
        SearxngBackend().suche("klimabilanz", limit=5)
        anfrage = m.request_history[0]
    assert anfrage.qs["q"] == ["klimabilanz"]
    assert anfrage.qs["format"] == ["json"]


def test_suche_kappt_auf_limit():
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search", json=ANTWORT)
        treffer = SearxngBackend().suche("egal", limit=1)
    assert len(treffer) == 1


def test_backend_nicht_erreichbar_wirft_statt_leerer_liste():
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search", exc=requests.exceptions.ConnectionError)
        with pytest.raises(BackendFehler) as e:
            SearxngBackend().suche("egal", limit=10)
    assert "nicht erreichbar" in str(e.value)


def test_backend_http_fehler_wirft():
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search", status_code=500)
        with pytest.raises(BackendFehler):
            SearxngBackend().suche("egal", limit=10)


def test_backend_unlesbare_antwort_wirft():
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search", text="kein json")
        with pytest.raises(BackendFehler):
            SearxngBackend().suche("egal", limit=10)


def test_leere_trefferliste_bei_blockierten_engines_wirft_und_nennt_sie():
    """HTTP 200 mit leerer Trefferliste ist der gefaehrlichste Fall.

    SearXNG antwortet genau so, wenn seine Engines in CAPTCHA oder Rate-Limit
    laufen. Live gemessen: unresponsive_engines = [['startpage',
    'Suspended: CAPTCHA'], ['brave', 'too many requests']]. Ohne Auswertung
    liest der Agent das als "zu dieser Frage gibt es nichts".
    """
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search",
              json={"results": [],
                    "unresponsive_engines": [["startpage", "Suspended: CAPTCHA"],
                                             ["brave", "too many requests"]]})
        with pytest.raises(BackendFehler) as e:
            SearxngBackend().suche("egal", limit=10)
    meldung = str(e.value)
    assert "startpage" in meldung and "brave" in meldung
    assert "CAPTCHA" in meldung
    # Die Ursache muss im Klartext dastehen, sonst zitiert der Agent das
    # Nichts als Rechercheergebnis.
    assert "ausgefallen" in meldung.lower()


def test_leere_trefferliste_ohne_ausfall_wirft_ebenfalls():
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search",
              json={"results": [], "unresponsive_engines": []})
        with pytest.raises(BackendFehler) as e:
            SearxngBackend().suche("egal", limit=10)
    assert "keine Engine" in str(e.value)


def test_unresponsive_engines_als_dicts_werden_verstanden():
    """Aeltere/neuere SearXNG-Staende liefern Objekte statt Paare."""
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search",
              json={"results": [],
                    "unresponsive_engines": [{"name": "duckduckgo",
                                              "error": "timeout"}]})
        with pytest.raises(BackendFehler) as e:
            SearxngBackend().suche("egal", limit=10)
    assert "duckduckgo" in str(e.value) and "timeout" in str(e.value)


def test_viele_ausgefallene_engines_warnen_ohne_zu_blockieren():
    """Treffer da, aber halbe Flotte tot: Ergebnis durchlassen, Warnung merken."""
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search",
              json={**ANTWORT,
                    "unresponsive_engines": [["startpage", "CAPTCHA"],
                                             ["brave", "429"],
                                             ["duckduckgo", "429"]]})
        backend = SearxngBackend()
        treffer = backend.suche("egal", limit=10)
    assert len(treffer) == 2  # Ergebnis kommt durch
    assert backend.letzte_warnung is not None
    assert "startpage" in backend.letzte_warnung


def test_wenige_ausgefallene_engines_warnen_nicht():
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search",
              json={**ANTWORT, "unresponsive_engines": [["startpage", "CAPTCHA"]]})
        backend = SearxngBackend()
        backend.suche("egal", limit=10)
    assert backend.letzte_warnung is None


def test_warnung_wird_bei_jedem_lauf_zurueckgesetzt():
    backend = SearxngBackend()
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search",
              json={**ANTWORT,
                    "unresponsive_engines": [["a", "x"], ["b", "y"], ["c", "z"]]})
        backend.suche("egal", limit=10)
    assert backend.letzte_warnung is not None
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search", json=ANTWORT)
        backend.suche("egal", limit=10)
    assert backend.letzte_warnung is None


def test_treffer_ohne_url_werden_verworfen():
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search",
              json={"results": [{"title": "Ohne URL", "content": "x"},
                                {"url": "https://c.de/z", "title": "C", "content": "y"}]})
        treffer = SearxngBackend().suche("egal", limit=10)
    assert [t.url for t in treffer] == ["https://c.de/z"]
