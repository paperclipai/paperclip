import contextlib
import socket
import threading
import time

import pytest
import requests
import requests_mock
import urllib3

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
            frist = kwargs["timeout"]
            # timeout ist ein (Verbindungs-, Lese-)Paar, seit robots und Seite
            # denselben Kern benutzen.
            time.sleep(max(frist) if isinstance(frist, tuple) else frist)
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


# --- R1: der robots-Abruf untersteht derselben Disziplin ------------------
#
# Der Seitenabruf prueft jedes Ziel vor dem Verbindungsaufbau, faehrt die
# Weiterleitungen selbst und liest stroemend mit Deckel. Der robots-Abruf war
# davon ausgenommen: `requests.get()` mit Standardwerten folgte blind. Eine
# robots.txt, die auf 127.0.0.1:5678 umleitet, loeste damit eine echte
# Anfrage an n8n aus — der Rumpf landete zwar nirgends, aber bei auth-freien
# Hausdiensten IST die ausgeloeste Anfrage der Schaden.

def test_robots_umleitung_in_lokalen_dienst_loest_keine_anfrage_aus():
    """Die robots.txt einer Trefferseite darf uns nicht nach n8n schicken.

    Ein Webhook liesse sich sonst von aussen ausloesen: es genuegt, mit einer
    Seite in die Trefferliste zu kommen und deren robots.txt umleiten zu
    lassen. Gemessen wird nicht das Ergebnis, sondern ob die Anfrage
    ueberhaupt gestellt wurde.
    """
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=302,
              headers={"Location": "http://127.0.0.1:5678/webhook/mail-versand"})
        webhook = m.get("http://127.0.0.1:5678/webhook/mail-versand", text="ok")
        m.get("https://a.de/seite", text=SEITE)
        hole_text("https://a.de/seite")
    assert webhook.call_count == 0, "n8n wurde ueber die robots.txt angefragt!"


def test_robots_umleitung_auf_namen_der_lokal_aufloest_loest_keine_anfrage_aus():
    DNS["intern.beispiel.de"] = ["127.0.0.1"]
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=301,
              headers={"Location": "http://intern.beispiel.de:7777/denk"})
        brain = m.get("http://intern.beispiel.de:7777/denk", text="BRAIN")
        m.get("https://a.de/seite", text=SEITE)
        hole_text("https://a.de/seite")
    assert brain.call_count == 0, "Brain wurde ueber die robots.txt angefragt!"


def test_robots_umleitung_ins_lan_loest_keine_anfrage_aus():
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=307,
              headers={"Location": "http://192.168.2.40:1234/v1/models"})
        lan = m.get("http://192.168.2.40:1234/v1/models", text="MODELLE")
        m.get("https://a.de/seite", text=SEITE)
        hole_text("https://a.de/seite")
    assert lan.call_count == 0


def test_robots_umleitung_auf_oeffentliches_ziel_wird_gefolgt():
    """RFC 9309, 2.3.1.2: mindestens fuenf Weiterleitungen sollen verfolgt
    werden. Die Sprungkontrolle darf die Regeln nicht verschlucken."""
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=301,
              headers={"Location": "https://cdn.a.de/robots.txt"})
        m.get("https://cdn.a.de/robots.txt",
              text="User-agent: *\nDisallow: /privat")
        gesperrt = m.get("https://a.de/privat/x", text=SEITE)
        ergebnis = hole_text("https://a.de/privat/x")
    assert ergebnis.text is None
    assert "robots.txt" in ergebnis.fehler
    assert gesperrt.call_count == 0


def test_robots_weiterleitungskette_bricht_ab():
    with requests_mock.Mocker() as m:
        for nr in range(20):
            m.get(f"https://a{nr}.de/robots.txt", status_code=302,
                  headers={"Location": f"https://a{nr + 1}.de/robots.txt"})
        seite = m.get("https://a0.de/seite", text=SEITE)
        hole_text("https://a0.de/seite")
        gefragt = [r.url for r in m.request_history if r.url.endswith("robots.txt")]
    # Nicht endlos: die Kette endet bei MAX_WEITERLEITUNGEN + 1 Anfragen.
    assert len(gefragt) <= abruf.MAX_WEITERLEITUNGEN + 1, gefragt
    assert seite.call_count == 1


def test_riesige_robots_txt_wird_gedeckelt(monkeypatch):
    """Auch die robots.txt wird stroemend und mit Deckel gelesen — sonst
    laedt eine 500-MB-Datei unter dem Namen robots.txt in den Speicher."""
    monkeypatch.setattr(abruf, "MAX_ROBOTS_BYTES", 2000)
    riesig = "User-agent: *\n" + ("# Fuellzeile\n" * 5000) + "Disallow: /\n"
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", text=riesig)
        m.get("https://a.de/seite", text=SEITE)
        ergebnis = hole_text("https://a.de/seite")
    # Die Disallow-Zeile steht hinter dem Deckel und wurde nie gelesen.
    assert ergebnis.fehler is None


# --- R2: das Zeitbudget gegen einen echten, boesartig langsamen Server ----
#
# `timeout` von requests misst zwischen zwei gelesenen Stuecken, nicht die
# Gesamtdauer. Ein nachgebautes Antwortobjekt kann diese Luecke nicht zeigen:
# dessen iter_content liefert sofort. Deshalb hier ein echter Socket-Server,
# der die Verbindung offen haelt und tropfenweise sendet.

def _rinnsal(art):
    """Die Bytes, die der Server tropfenweise nachschiebt — je Angriffsform.

    Alle drei Formen sind aus Sicht des Protokolls einwandfrei. Sie
    unterscheiden sich nur darin, WO die wartende Schleife sitzt:

    - "text":    Nutzbytes. Die Schleife sitzt in `_lies_gedeckelt`, die
                 Fristpruefung dort greift.
    - "gzip":    gueltige, aber leer dekodierende Deflate-Bloecke
                 (Z_SYNC_FLUSH). `read1` bekommt Bytes, gibt aber nichts
                 zurueck — die Schleife sitzt in urllib3s Dekoder.
    - "chunked": die Groessenzeile eines Chunks, Ziffer fuer Ziffer. Die
                 Schleife sitzt in `http.client.readline()`.

    Gibt (Kopfzeilen, Nachschub-Funktion) zurueck.
    """
    if art == "gzip":
        import zlib
        packer = zlib.compressobj(9, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
        kopf = (b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n"
                b"Content-Encoding: gzip\r\nContent-Length: 100000000\r\n"
                b"Connection: close\r\n\r\n")
        return kopf, lambda: packer.compress(b"") + packer.flush(
            zlib.Z_SYNC_FLUSH)
    if art == "chunked":
        kopf = (b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n"
                b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
        return kopf, lambda: b"0"
    kopf = (b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n"
            b"Content-Length: 100000000\r\nConnection: close\r\n\r\n")
    return kopf, lambda: b"<p>x</p>"


def _starte_troepfel_server(troepfelnde_pfade, dauer=3.0, pause=0.02,
                            art="text", nachlauf=0.0):
    """Antwortet auf `troepfelnde_pfade` mit einem nie endenden Rinnsal,
    auf alles andere sofort mit 404. Gibt (Port, Socket) zurueck.

    `art` waehlt die Angriffsform (siehe `_rinnsal`). `nachlauf` laesst den
    Server nach dem Rinnsal verstummen, OHNE die Verbindung zu schliessen —
    nur so laesst sich pruefen, ob die Socket-Frist wirklich nachgezogen wird
    (ein Verbindungsabbau wuerde den Lesevorgang sofort beenden).
    """
    lauscher = socket.socket()
    lauscher.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    lauscher.bind(("127.0.0.1", 0))
    lauscher.listen(8)
    port = lauscher.getsockname()[1]

    def bediene(verbindung):
        try:
            anfrage = verbindung.recv(65536).decode("latin1", "replace")
            pfad = anfrage.split(" ")[1] if anfrage.count(" ") >= 2 else "/"
            if not any(pfad.startswith(p) for p in troepfelnde_pfade):
                verbindung.sendall(
                    b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n"
                    b"Content-Length: 4\r\nConnection: close\r\n\r\nleer")
                return
            kopf, nachschub = _rinnsal(art)
            verbindung.sendall(kopf)
            ende = time.monotonic() + dauer
            while time.monotonic() < ende:
                time.sleep(pause)
                verbindung.sendall(nachschub())
            if nachlauf:
                time.sleep(nachlauf)
        except OSError:
            pass
        finally:
            with contextlib.suppress(OSError):
                verbindung.close()

    def nimm_an():
        while True:
            try:
                verbindung, _ = lauscher.accept()
            except OSError:
                return
            threading.Thread(target=bediene, args=(verbindung,),
                             daemon=True).start()

    threading.Thread(target=nimm_an, daemon=True).start()
    return port, lauscher


@pytest.fixture
def troepfel(monkeypatch):
    """Startet den Rinnsal-Server und laesst 127.0.0.1 fuer diesen Test zu.

    Die Zielpruefung wird bewusst ausgehebelt: geprueft wird hier das
    Zeitbudget, und ein echter Server ist nur auf Loopback erreichbar.
    """
    monkeypatch.setattr(abruf, "pruefe_ziel", lambda url, **k: None)
    offen = []

    def starte(pfade, dauer=3.0, pause=0.02, art="text", nachlauf=0.0):
        port, lauscher = _starte_troepfel_server(
            pfade, dauer=dauer, pause=pause, art=art, nachlauf=nachlauf)
        offen.append(lauscher)
        return port

    yield starte
    for lauscher in offen:
        with contextlib.suppress(OSError):
            lauscher.close()


def test_troepfelnde_seite_endet_im_zeitbudget(troepfel):
    """Der Rumpf wurde mit iter_content(16384) gelesen: dieser Aufruf kehrt
    erst zurueck, wenn 16 KB beisammen sind. Die Fristpruefung ZWISCHEN den
    Stuecken kam bei 8 Bytes alle 20 ms nie an die Reihe.
    """
    port = troepfel(["/troepfel"])
    start = time.monotonic()
    ergebnis = hole_text(f"http://127.0.0.1:{port}/troepfel", timeout=0.3)
    dauer = time.monotonic() - start
    assert dauer < 1.5, f"lief {dauer:.2f}s trotz 0,3s Budget"
    assert ergebnis.text is None
    assert "Zeit" in ergebnis.fehler


def test_troepfelnde_robots_txt_endet_im_zeitbudget(troepfel):
    """Gemessen wurden 81 s bei timeout=1.0 — der robots-Abruf lief blind."""
    port = troepfel(["/robots.txt"])
    start = time.monotonic()
    ergebnis = hole_text(f"http://127.0.0.1:{port}/seite", timeout=0.3)
    dauer = time.monotonic() - start
    assert dauer < 1.5, f"lief {dauer:.2f}s trotz 0,3s Budget"
    assert ergebnis.text is None


def test_stiller_server_endet_im_zeitbudget(troepfel):
    """Kein Rinnsal, sondern voelliges Schweigen nach den Kopfzeilen: hier
    greift nicht die Fristpruefung zwischen den Stuecken, sondern das
    Lesetimeout des Sockets. Beides muss auf das Restbudget gestellt sein."""
    port = troepfel(["/still"], dauer=3.0, pause=3.0)
    start = time.monotonic()
    ergebnis = hole_text(f"http://127.0.0.1:{port}/still", timeout=0.3)
    dauer = time.monotonic() - start
    assert dauer < 1.5, f"lief {dauer:.2f}s trotz 0,3s Budget"
    assert ergebnis.text is None


def test_haengende_namensaufloesung_endet_im_zeitbudget(monkeypatch):
    """`pruefe_ziel` loeste Namen ohne Zeitgrenze auf — und tat das, bevor
    die Frist ueberhaupt geprueft wurde. Ein DNS-Server, der nicht antwortet,
    haengt den Abruf damit beliebig lange auf."""
    def lahme_aufloesung(host):
        time.sleep(3.0)
        return ["93.184.216.34"]

    monkeypatch.setattr(abruf, "_aufloesen", lahme_aufloesung)
    start = time.monotonic()
    ergebnis = hole_text("https://lahm.example/seite", timeout=0.3)
    dauer = time.monotonic() - start
    assert dauer < 1.5, f"lief {dauer:.2f}s trotz 0,3s Budget"
    assert ergebnis.text is None


def test_pruefe_ziel_haelt_seine_eigene_aufloesungsfrist(monkeypatch):
    def lahme_aufloesung(host):
        time.sleep(3.0)
        return ["93.184.216.34"]

    monkeypatch.setattr(abruf, "_aufloesen", lahme_aufloesung)
    start = time.monotonic()
    grund = pruefe_ziel("https://lahm.example/x", aufloese_frist=0.2)
    dauer = time.monotonic() - start
    assert dauer < 1.5, f"lief {dauer:.2f}s trotz 0,2s Frist"
    assert grund is not None and "lahm.example" in grund


# --- Der Socket-Waechter ---------------------------------------------------
#
# Die beiden Formen unten galten als unbehebbar: die wartende Schleife liegt
# in urllib3s Dekoder bzw. in `http.client.readline()`, also unterhalb jeder
# Stelle, an der dieser Code eine Frist pruefen koennte. Das stimmt — und ist
# trotzdem kein Grund aufzugeben: ein blockierender Lesevorgang laesst sich
# zwar nicht UNTERBRECHEN, der Socket darunter aber aus einem zweiten Faden
# SCHLIESSEN. Genau das tut `_Fristwaechter`.

def test_leere_gzip_bloecke_enden_im_zeitbudget(troepfel):
    """Gueltige Deflate-Bloecke, die zu null Nutzbytes dekodieren.

    `read1()` bekommt staendig Bytes und gibt trotzdem nichts zurueck: die
    Schleife dreht in urllib3, die Fristpruefung in `_lies_gedeckelt` kommt
    nie an die Reihe. Gemessen ohne Waechter: 4,02 s bei 0,3 s Budget.
    """
    port = troepfel(["/gzip"], dauer=4.0, art="gzip")
    start = time.monotonic()
    ergebnis = hole_text(f"http://127.0.0.1:{port}/gzip", timeout=0.3)
    dauer = time.monotonic() - start
    assert dauer < 1.5, f"lief {dauer:.2f}s trotz 0,3s Budget"
    assert ergebnis.text is None


def test_troepfelnde_chunked_groessenzeile_endet_im_zeitbudget(troepfel):
    """Die Laengenzeile eines Chunks, Ziffer fuer Ziffer.

    Hier wartet `http.client.readline()` auf das Zeilenende — noch eine Ebene
    tiefer als der Dekoder. Gemessen ohne Waechter: 4,00 s bei 0,3 s Budget.
    """
    port = troepfel(["/chunk"], dauer=4.0, art="chunked")
    start = time.monotonic()
    ergebnis = hole_text(f"http://127.0.0.1:{port}/chunk", timeout=0.3)
    dauer = time.monotonic() - start
    assert dauer < 1.5, f"lief {dauer:.2f}s trotz 0,3s Budget"
    assert ergebnis.text is None


def test_troepfelnder_server_der_verstummt_zieht_die_frist_nach(troepfel,
                                                               monkeypatch):
    """Die Socket-Frist wurde einmal beim Anfragestart berechnet und nie
    nachgezogen.

    Folge: ein Server, der bis kurz vor die Frist tropft und dann schweigt,
    haengt danach noch eine volle SOCKET_FRIST an — gemessen 2,93 s bei 2,0 s
    Budget und SOCKET_FRIST=1,0. Mit den Produktionswerten waeren das 15 s
    statt 10 s. Der Waechter deckelt das auf die Frist.
    """
    monkeypatch.setattr(abruf, "SOCKET_FRIST", 1.0)
    port = troepfel(["/spaet"], dauer=0.45, pause=0.02, nachlauf=5.0)
    start = time.monotonic()
    ergebnis = hole_text(f"http://127.0.0.1:{port}/spaet", timeout=0.5)
    dauer = time.monotonic() - start
    assert dauer < 0.9, (f"lief {dauer:.2f}s bei 0,5s Budget — die "
                         f"SOCKET_FRIST von 1,0s wurde angehaengt")
    assert ergebnis.text is None


def test_socket_kette_greift_bei_einer_echten_antwort(troepfel):
    """Der Waechter greift ueber private urllib3-Interna auf den Socket zu.

    Dieser Test wird rot, wenn keine Stufe der Kette mehr passt — ohne ihn
    waere der Waechter nach einem urllib3-Update still wirkungslos, und die
    beiden Tests darueber wuerden es erst am Zeitverbrauch merken.
    """
    port = troepfel(["/troepfel"], dauer=4.0)
    antwort = requests.get(f"http://127.0.0.1:{port}/troepfel", stream=True,
                           timeout=(2.0, 2.0))
    try:
        assert abruf._socket_zuklappen(antwort) is True, (
            "keine Stufe der Attributkette griff — der Waechter ist wirkungslos")
    finally:
        antwort.close()


def test_privater_rueckfallweg_zum_socket_passt_noch(troepfel):
    """Der Rueckfallweg fuer den Fall, dass `raw.shutdown()` verschwindet.

    Nebenbefund, der in die Kette gehoert: `raw._connection.sock` — der in
    aelteren urllib3-Staenden ueblich war — ist unter 2.7.0 immer `None`, weil
    die Verbindung den Socket beim `getresponse()` an die Antwort abgibt.
    Deshalb steht dieser Weg in der Kette hinten, nicht vorn.
    """
    port = troepfel(["/troepfel"], dauer=4.0)
    antwort = requests.get(f"http://127.0.0.1:{port}/troepfel", stream=True,
                           timeout=(2.0, 2.0))
    try:
        rueckfall = antwort.raw._fp.fp.raw._sock
        assert isinstance(rueckfall, socket.socket)
    finally:
        antwort.close()


def test_socket_waechter_bricht_ab_wenn_kein_weg_greift():
    """Private Attribute duerfen verschwinden — sie duerfen nur nicht mit
    einer Ausnahme mitten im Abruf verschwinden."""
    class Nichts:
        pass

    attrappe = Nichts()
    attrappe.raw = Nichts()
    assert abruf._socket_zuklappen(attrappe) is False
    assert abruf._socket_zuklappen(Nichts()) is False


def test_waechter_bestellt_seinen_timer_ab():
    """Ein nicht abbestellter Timer haelt je Abruf einen Faden bis zur Frist
    am Leben — bei 10 s Seitenbudget und einem wochenlang laufenden Dienst
    ist das ein Fadenleck mit Ansage."""
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/seite", text=SEITE,
              headers={"Content-Type": "text/html"})
        ergebnis = hole_text("https://a.de/seite", timeout=30.0)
    assert ergebnis.text is not None

    def waechter_faeden():
        return [f for f in threading.enumerate()
                if f.name.startswith(abruf.WAECHTER_FADEN_NAME)]

    # `cancel()` weckt den Faden nur — bis er wirklich austritt, vergeht ein
    # Scheduler-Moment. Zwei Sekunden Geduld; ein NICHT abbestellter Timer
    # laege hier volle 30 s (das Budget oben) und faellt sicher durch.
    ende = time.monotonic() + 2.0
    while waechter_faeden() and time.monotonic() < ende:
        time.sleep(0.01)
    assert not waechter_faeden(), (
        f"Timer nicht abbestellt: {waechter_faeden()}")


# --- Kopfzeilen sind case-insensitiv (RFC 9110, 5.1) -----------------------

def test_kleingeschriebener_content_type_wird_erkannt():
    """`dict(antwort.headers)` warf requests' CaseInsensitiveDict weg.

    Der zweite Formatdurchgang in `hole_text` suchte danach `"Content-Type"`
    und fand bei einem Server, der `content-type:` klein schreibt, nichts —
    der Rumpf entschied dann allein, und UTF-16-Text ist voller Nullbytes.
    Gemessen an identischer Seite: gross geschrieben Text extrahiert, klein
    geschrieben "Binaerinhalt ohne Content-Type". Das kostet still eine Quelle.
    """
    seite = "<html><body><p>Der erste Absatz.</p></body></html>".encode("utf-16")
    with requests_mock.Mocker() as m:
        m.get("https://a.de/robots.txt", status_code=404)
        m.get("https://a.de/seite", content=seite,
              headers={"content-type": "text/html; charset=utf-16"})
        ergebnis = hole_text("https://a.de/seite")
    assert ergebnis.fehler is None, ergebnis.fehler
    assert "Der erste Absatz." in ergebnis.text


def test_kopf_der_rohantwort_ist_case_insensitiv():
    """Dieselbe Zusicherung eine Ebene tiefer, damit auch kuenftige Leser von
    `RohAntwort.kopf` sie bekommen."""
    with requests_mock.Mocker() as m:
        m.get("https://a.de/x", text="hallo",
              headers={"content-type": "text/plain"})
        roh = abruf._hole_gedeckelt("https://a.de/x", time.monotonic() + 5.0,
                                    accept="*/*", max_bytes=1000)
    assert roh.kopf["Content-Type"] == "text/plain"
    assert roh.kopf["CONTENT-TYPE"] == "text/plain"


# --- urllib3 ist eine direkte Abhaengigkeit --------------------------------

def test_requirements_deklariert_urllib3_mit_2er_spanne():
    """`abruf.py` importiert urllib3 direkt und haengt an `raw.read1(...)`
    und `raw.shutdown()` — beides gibt es nur in urllib3 2.x.

    In `requirements.txt` stand urllib3 gar nicht, und `deploy.sh` baut das
    venv damit neu auf. Ein Neuaufbau, der ueber requests' weite Spanne
    (>=1.21.1,<3) bei 1.26 landet, macht aus jedem Abruf einen AttributeError
    — den das breite `except Exception` in `recherchiere` je Quelle in ein
    harmloses "Abbruch: ..." verwandelt. Der Dienst liefe scheinbar weiter
    und faende nie wieder etwas.
    """
    import pathlib
    import re as _re

    zeilen = (pathlib.Path(__file__).with_name("requirements.txt")
              .read_text().splitlines())
    genannt = [z.strip() for z in zeilen
               if z.strip().lower().startswith("urllib3")]
    assert genannt, "requirements.txt nennt urllib3 nicht"
    zeile = genannt[0]
    assert _re.search(r">=\s*2(\.|\b)", zeile), (
        f"keine 2.x-Untergrenze in {zeile!r}")
    assert _re.search(r"<\s*3(\.|\b)", zeile), f"keine Obergrenze in {zeile!r}"


def test_installiertes_urllib3_erfuellt_die_deklarierte_spanne():
    """Damit die Spanne nicht bloss auf dem Papier steht: die beiden APIs,
    an denen `abruf.py` haengt, muessen im installierten Stand da sein."""
    assert int(urllib3.__version__.split(".")[0]) == 2, urllib3.__version__
    assert hasattr(urllib3.response.HTTPResponse, "read1")
    assert hasattr(urllib3.response.HTTPResponse, "shutdown")
