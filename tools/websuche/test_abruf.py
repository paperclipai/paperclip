import time

import pytest
import requests
import requests_mock

import abruf
from abruf import (AbrufErgebnis, extrahiere_text, hole_text, kappe,
                   darf_abrufen, pruefe_ziel)

# Namensaufloesung fuer die Tests: Standard ist eine oeffentliche Adresse,
# einzelne Tests tragen hier gezielt eine lokale ein. Ohne das wuerde die
# Suite echtes DNS brauchen — sie muss aber ohne Netz laufen.
DNS = {}


@pytest.fixture(autouse=True)
def dns_ohne_netz(monkeypatch):
    DNS.clear()
    monkeypatch.setattr(abruf, "_aufloesen",
                        lambda host: DNS.get(host, ["93.184.216.34"]))
    yield
    DNS.clear()

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


# --- Weiterleitungen, Ziel-Pruefung, Groessen- und Zeitdeckel (I1) ---------

def test_weiterleitung_in_lokalen_dienst_wird_verweigert():
    """Eine Trefferseite darf uns nicht auf vault-lookup, Brain, n8n oder
    Paperclip umleiten — die sind auth-frei, weil sie als nur lokal
    erreichbar gelten. Deren Antwort als 'Quelltext' im Dossier waere ein
    Datenabfluss durch die Hintertuer.
    """
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/umleitung", status_code=302,
              headers={"Location": "http://127.0.0.1:7788/suche?q=gehalt"})
        lokal = m.get("http://127.0.0.1:7788/suche", text="GEHEIM")
        ergebnis = hole_text("https://a.de/umleitung")
    assert ergebnis.text is None
    assert "127.0.0.1" in ergebnis.fehler
    assert lokal.call_count == 0, "Der lokale Dienst wurde tatsaechlich angefragt!"


def test_weiterleitung_ins_lan_wird_verweigert():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/umleitung", status_code=301,
              headers={"Location": "http://192.168.2.40:1234/v1/models"})
        lan = m.get("http://192.168.2.40:1234/v1/models", text="MODELLE")
        ergebnis = hole_text("https://a.de/umleitung")
    assert ergebnis.text is None
    assert "192.168.2.40" in ergebnis.fehler
    assert lan.call_count == 0


def test_weiterleitung_auf_namen_der_lokal_aufloest_wird_verweigert():
    """Nicht nur IP-Literale: ein Name, der per DNS auf 127.0.0.1 zeigt,
    fuehrt genauso in die lokalen Dienste."""
    DNS["intern.beispiel.de"] = ["127.0.0.1"]
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/umleitung", status_code=302,
              headers={"Location": "http://intern.beispiel.de:7777/"})
        intern = m.get("http://intern.beispiel.de:7777/", text="BRAIN")
        ergebnis = hole_text("https://a.de/umleitung")
    assert ergebnis.text is None
    assert "127.0.0.1" in ergebnis.fehler
    assert intern.call_count == 0


def test_weiterleitung_auf_ipv6_loopback_wird_verweigert():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/umleitung", status_code=302,
              headers={"Location": "http://[::1]:7789/suche"})
        ergebnis = hole_text("https://a.de/umleitung")
    assert ergebnis.text is None
    assert "::1" in ergebnis.fehler


def test_ursprungs_url_im_lokalen_netz_wird_gar_nicht_erst_abgerufen():
    with requests_mock.Mocker() as m:
        lokal = m.get("http://127.0.0.1:3100/dashboard", text="PAPERCLIP")
        robots = m.get("http://127.0.0.1:3100/robots.txt", status_code=404)
        ergebnis = hole_text("http://127.0.0.1:3100/dashboard")
    assert ergebnis.text is None
    assert lokal.call_count == 0 and robots.call_count == 0


def test_fremdes_schema_wird_verweigert():
    ergebnis = hole_text("file:///etc/passwd")
    assert ergebnis.text is None
    assert "file" in ergebnis.fehler


def test_weiterleitung_auf_oeffentliches_ziel_kommt_durch():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://b.de/robots.txt", status_code=404)
        m.get("https://a.de/alt", status_code=301,
              headers={"Location": "https://b.de/neu"})
        m.get("https://b.de/neu", text=SEITE)
        ergebnis = hole_text("https://a.de/alt")
    assert ergebnis.fehler is None
    assert "Der erste Absatz." in ergebnis.text


def test_zu_viele_weiterleitungen_brechen_ab():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        for nr in range(20):
            m.get(f"https://a.de/{nr}", status_code=302,
                  headers={"Location": f"https://a.de/{nr + 1}"})
        ergebnis = hole_text("https://a.de/0")
    assert ergebnis.text is None
    assert "Weiterleitung" in ergebnis.fehler


def test_weiterleitung_ohne_ziel_ist_ein_fehler():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/kaputt", status_code=302)
        ergebnis = hole_text("https://a.de/kaputt")
    assert ergebnis.text is None
    assert "Weiterleitung" in ergebnis.fehler


def test_grosse_antwort_wird_bei_der_obergrenze_gekappt(monkeypatch):
    """requests' timeout ist ein Lesetimeout zwischen Bytes, kein Deckel:
    ohne Obergrenze landet eine 500-MB-Datei vollstaendig im Speicher."""
    monkeypatch.setattr(abruf, "MAX_RUMPF_BYTES", 5000)
    riesig = "<html><body><p>" + ("wort " * 200000) + "</p></body></html>"
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/riesig", text=riesig)
        ergebnis = hole_text("https://a.de/riesig", max_zeichen=12000)
    assert ergebnis.fehler is None
    # Gelesen wurde hoechstens die Obergrenze, nicht die volle Seite.
    assert len(ergebnis.text) <= 5000


def test_troepfelnder_server_reisst_die_gesamtzeit_nicht(monkeypatch):
    """Ein Server, der alle 50 ms ein Byte schickt, laeuft unter reinem
    Lesetimeout beliebig lange weiter."""
    class TroepfelAntwort:
        status_code = 200
        headers = {"Content-Type": "text/html"}
        is_redirect = False

        def iter_content(self, groesse):
            while True:
                time.sleep(0.05)
                yield b"<p>x</p>"

        def raise_for_status(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(abruf, "darf_abrufen", lambda url, timeout=5.0: True)
    monkeypatch.setattr(abruf.requests, "get",
                        lambda *a, **k: TroepfelAntwort())

    start = time.monotonic()
    ergebnis = hole_text("https://a.de/troepfel", timeout=0.5)
    dauer = time.monotonic() - start
    assert dauer < 2.0, f"lief {dauer:.2f}s trotz 0,5s Budget"
    assert ergebnis.text is None
    assert "Zeit" in ergebnis.fehler


def test_pruefe_ziel_erlaubt_oeffentliche_adresse():
    assert pruefe_ziel("https://bmwk.de/foerderung") is None


@pytest.mark.parametrize("url", [
    "http://127.0.0.1:7788/x",       # vault-lookup
    "http://127.0.0.1:7777/x",       # Brain WHITESTAG
    "http://127.0.0.1:5678/webhook", # n8n
    "http://127.0.0.1:3100/",        # Paperclip
    "http://127.0.0.1:4711/",        # PII-Proxy
    "http://10.0.0.5/",
    "http://172.16.3.4/",
    "http://192.168.2.1/",
    "http://[fd00::1]/",             # IPv6 unique local
    "http://[::1]/",                 # IPv6 loopback
    "http://169.254.169.254/latest/", # Link-local (Metadaten-Dienste)
])
def test_pruefe_ziel_verweigert_lokale_und_private_adressen(url):
    assert pruefe_ziel(url) is not None


# --- robots.txt: Zeitbudget, Cache, 5xx (I6) ------------------------------

def test_robots_abruf_bekommt_das_seitenbudget(monkeypatch):
    """hole_text rief darf_abrufen(url) ohne timeout — dort galten dann fest
    5 s. Das Seitenbudget war damit faktisch 15 statt 10 Sekunden, und bei
    kleinem --deadline verbrannte allein der robots-Abruf das Budget, bevor
    der Zielserver ueberhaupt kontaktiert wurde.
    """
    gesehen = {}

    def falsches_darf(url, timeout=5.0):
        gesehen["timeout"] = timeout
        return True

    monkeypatch.setattr(abruf, "darf_abrufen", falsches_darf)
    with requests_mock.Mocker() as m:
        m.get("https://a.de/seite", text=SEITE)
        hole_text("https://a.de/seite", timeout=2.0)
    assert gesehen["timeout"] <= 2.0


def test_haengende_robots_txt_sprengt_die_gesamtzeit_nicht(monkeypatch):
    def lahmes_get(url, **kwargs):
        if url.endswith("/robots.txt"):
            time.sleep(kwargs["timeout"])
            raise requests.exceptions.Timeout()
        raise AssertionError("Zielserver trotz verbrauchtem Budget angefragt")

    monkeypatch.setattr(abruf.requests, "get", lahmes_get)
    start = time.monotonic()
    ergebnis = hole_text("https://a.de/seite", timeout=0.4)
    dauer = time.monotonic() - start
    assert dauer < 2.0, f"lief {dauer:.2f}s trotz 0,4s Budget"
    assert ergebnis.text is None
    assert "Zeit" in ergebnis.fehler


def test_robots_txt_wird_je_domain_nur_einmal_geholt():
    speicher = abruf.RobotsSpeicher()
    with requests_mock.Mocker() as m:
        robots = m.get("https://a.de/robots.txt",
                       text="User-agent: *\nDisallow: /privat")
        m.get("https://a.de/eins", text=SEITE)
        m.get("https://a.de/zwei", text=SEITE)
        eins = hole_text("https://a.de/eins", robots=speicher)
        zwei = hole_text("https://a.de/zwei", robots=speicher)
        gesperrt = hole_text("https://a.de/privat/x", robots=speicher)
    assert robots.call_count == 1, "robots.txt pro Seite neu geholt"
    assert eins.fehler is None and zwei.fehler is None
    # Der Cache darf die Regeln nicht verwaessern:
    assert gesperrt.text is None and "robots.txt" in gesperrt.fehler


def test_robots_speicher_trennt_domains():
    speicher = abruf.RobotsSpeicher()
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", text="User-agent: *\nDisallow: /")
        m.get("https://b.de/robots.txt", status_code=404)
        m.get("https://b.de/seite", text=SEITE)
        a = hole_text("https://a.de/seite", robots=speicher)
        b = hole_text("https://b.de/seite", robots=speicher)
    assert a.text is None and "robots.txt" in a.fehler
    assert b.fehler is None


def test_robots_5xx_gilt_als_verbot():
    """RFC 9309: ein 5xx auf robots.txt bedeutet 'komplett verboten', nicht
    'erlaubt'. Bisher wurde jeder Status ausser 200 als Freibrief gelesen."""
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=503)
        seite = m.get("https://a.de/seite", text=SEITE)
        ergebnis = hole_text("https://a.de/seite")
    assert ergebnis.text is None
    assert "robots.txt" in ergebnis.fehler
    assert seite.call_count == 0, "Seite trotz 5xx auf robots.txt abgerufen"


def test_robots_404_bleibt_ein_freibrief():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/seite", text=SEITE)
        assert hole_text("https://a.de/seite").fehler is None
