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


def test_treffer_ohne_url_werden_verworfen():
    with requests_mock.Mocker() as m:
        m.get("http://127.0.0.1:8888/search",
              json={"results": [{"title": "Ohne URL", "content": "x"},
                                {"url": "https://c.de/z", "title": "C", "content": "y"}]})
        treffer = SearxngBackend().suche("egal", limit=10)
    assert [t.url for t in treffer] == ["https://c.de/z"]
