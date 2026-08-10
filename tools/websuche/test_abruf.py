import pytest
import requests
import requests_mock

from abruf import (AbrufErgebnis, extrahiere_text, hole_text, kappe,
                   darf_abrufen)

SEITE = """
<html><head><title>T</title><style>p{color:red}</style></head>
<body>
  <nav>Startseite Kontakt Impressum</nav>
  <header>Kopfzeile</header>
  <main><p>Der erste Absatz.</p><p>Der zweite Absatz.</p></main>
  <aside>Werbung</aside>
  <footer>Fusszeile</footer>
  <script>var x = 1;</script>
</body></html>
"""


def test_extrahiere_text_liefert_fliesstext_ohne_beiwerk():
    text = extrahiere_text(SEITE)
    assert "Der erste Absatz." in text
    assert "Der zweite Absatz." in text
    for beiwerk in ("Startseite Kontakt Impressum", "Kopfzeile", "Werbung",
                    "Fusszeile", "var x = 1", "color:red"):
        assert beiwerk not in text


def test_extrahiere_text_faltet_leerraum():
    text = extrahiere_text("<html><body><p>a</p>\n\n\n<p>b</p></body></html>")
    assert "\n\n\n" not in text


def test_kappe_laesst_kurzen_text_unveraendert():
    assert kappe("kurz", 100) == "kurz"


def test_kappe_setzt_sichtbare_marke():
    text = kappe("x" * 50, 20)
    assert text.endswith("… [gekappt bei 20 Zeichen]")
    assert text.startswith("x" * 20)


def test_hole_text_liefert_text():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/seite", text=SEITE)
        ergebnis = hole_text("https://a.de/seite", max_zeichen=12000)
    assert ergebnis.fehler is None
    assert "Der erste Absatz." in ergebnis.text


def test_hole_text_meldet_http_fehler_statt_zu_werfen():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/gesperrt", status_code=403)
        ergebnis = hole_text("https://a.de/gesperrt")
    assert ergebnis.text is None
    assert "403" in ergebnis.fehler


def test_hole_text_meldet_timeout():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/lahm", exc=requests.exceptions.Timeout)
        ergebnis = hole_text("https://a.de/lahm")
    assert ergebnis.text is None
    assert "Zeit" in ergebnis.fehler


def test_hole_text_respektiert_robots_txt():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt",
              text="User-agent: *\nDisallow: /privat")
        ergebnis = hole_text("https://a.de/privat/seite")
    assert ergebnis.text is None
    assert "robots.txt" in ergebnis.fehler


def test_hole_text_kappt_auf_max_zeichen():
    langes = "<html><body><p>" + ("wort " * 5000) + "</p></body></html>"
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/lang", text=langes)
        ergebnis = hole_text("https://a.de/lang", max_zeichen=100)
    assert ergebnis.text.endswith("… [gekappt bei 100 Zeichen]")


def test_pdf_wird_nicht_als_quelltext_ausgegeben():
    """Ein PDF-Treffer lieferte bisher 12.000 Zeichen '%PDF-1.4 ...' als text,
    zaehlte damit als verwertbare Quelle und unterdrueckte den Hinweis.
    Fuer Foerdermittel- und Behoerdenfragen sind PDFs der Normalfall.
    """
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/merkblatt.pdf",
              content=b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj" + b"\x00" * 200,
              headers={"Content-Type": "application/pdf"})
        ergebnis = hole_text("https://a.de/merkblatt.pdf")
    assert ergebnis.text is None
    assert "application/pdf" in ergebnis.fehler


def test_bildformat_wird_abgelehnt():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/bild.png", content=b"\x89PNG\r\n\x1a\n" + b"\x00" * 50,
              headers={"Content-Type": "image/png"})
        ergebnis = hole_text("https://a.de/bild.png")
    assert ergebnis.text is None
    assert "image/png" in ergebnis.fehler


def test_klartext_wird_akzeptiert():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/liste.txt", text="Erste Zeile\nZweite Zeile",
              headers={"Content-Type": "text/plain; charset=utf-8"})
        ergebnis = hole_text("https://a.de/liste.txt")
    assert ergebnis.fehler is None
    assert "Erste Zeile" in ergebnis.text


def test_html_mit_charset_wird_akzeptiert():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/seite", text=SEITE,
              headers={"Content-Type": "text/html; charset=ISO-8859-1"})
        ergebnis = hole_text("https://a.de/seite")
    assert ergebnis.fehler is None


def test_binaerinhalt_ohne_content_type_wird_abgelehnt():
    """Kein Content-Type ist keine Erlaubnis: der Rumpf entscheidet."""
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/datei",
              content=b"%PDF-1.7\n" + b"\x00\x01\x02" * 100,
              headers={"Content-Type": ""})
        ergebnis = hole_text("https://a.de/datei")
    assert ergebnis.text is None
    assert "Binaer" in ergebnis.fehler or "binaer" in ergebnis.fehler


def test_hole_text_sendet_accept_header_fuer_text():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/seite", text=SEITE)
        hole_text("https://a.de/seite")
        accept = m.request_history[-1].headers["Accept"]
    assert "text/html" in accept


def test_hole_text_sendet_ehrlichen_user_agent():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/seite", text=SEITE)
        hole_text("https://a.de/seite")
        kopf = m.request_history[-1].headers["User-Agent"]
    assert "WHITESTAG" in kopf and "@" in kopf


def test_robots_unerreichbar_erlaubt_abruf():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", exc=requests.exceptions.ConnectionError)
        assert darf_abrufen("https://a.de/seite") is True


def test_abruf_ergebnis_hat_nie_text_und_fehler():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/seite", text=SEITE)
        ergebnis = hole_text("https://a.de/seite")
    assert isinstance(ergebnis, AbrufErgebnis)
    assert (ergebnis.text is None) != (ergebnis.fehler is None)


def test_hole_text_fangt_extraktion_fehler_auf(monkeypatch):
    """hole_text darf nie eine Ausnahme nach oben werfen, auch nicht wenn
    extrahiere_text kaputtes HTML nicht verarbeiten kann."""
    def werfende_extraktion(html: str) -> str:
        raise RecursionError("Pathologisch verschachteltes HTML")

    monkeypatch.setattr("abruf.extrahiere_text", werfende_extraktion)

    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/seite", text=SEITE)
        ergebnis = hole_text("https://a.de/seite")

    assert ergebnis.text is None
    assert "Text-Extraktion fehlgeschlagen" in ergebnis.fehler
