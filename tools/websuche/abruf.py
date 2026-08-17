"""Eine einzelne Seite holen und ihren Fließtext extrahieren.

Bewusst ohne Kenntnis der Suchquelle: was hier hereinkommt, ist eine URL, was
herausgeht, ist entweder Text oder eine Fehlermeldung — nie beides.

WAS DAS ZEITBUDGET WIRKLICH LEISTET
-----------------------------------
`hole_text(timeout=T)` deckelt Namensaufloesung, robots.txt, alle
Weiterleitungen und den Rumpf gemeinsam. Durchgesetzt wird das an drei
Stellen: eine eigene Frist fuer `getaddrinfo`, `min(Restbudget,
SOCKET_FRIST)` auf jeder einzelnen Socket-Operation und eine Fristpruefung
nach jedem Leseschritt (`read1`, nicht `iter_content` — siehe dort).

Es ist trotzdem KEINE harte Garantie, und das ist eine Eigenschaft der
blockierenden Sockets von Python, keine Nachlaessigkeit hier: ein Lesevorgang
laesst sich von aussen nicht abbrechen, und es gibt Antworten, bei denen
urllib3 intern weiterliest, ohne uns dazwischen zu lassen. Gemessen gegen
echte Server bei 1,0 s Budget:

    troepfelnde Seite (8 Bytes/50 ms)      1,03 s   (vorher 30,0 s)
    troepfelnde robots.txt                 1,04 s   (vorher 30,0 s; in der
                                                     Praxis 81 s gemessen)
    Server schweigt nach den Kopfzeilen    1,00 s
    gueltige, leer dekodierende
      gzip-Bloecke (Z_SYNC_FLUSH)         30,01 s   <- Restrisiko
    troepfelnde chunked-Groessenzeile     20,05 s   <- Restrisiko

Die beiden letzten Formen haben dieselbe Wurzel: der Angreifer sendet
staendig gueltige Bytes, die keinen einzigen Nutzbyte ergeben, und die
Schleife, die darauf wartet, liegt in urllib3 bzw. http.client — unterhalb
jeder Stelle, an der wir die Frist pruefen koennten. Der normale Fall und der
gewoehnliche langsame Server enden im Budget; ein gezielt darauf gebauter
Server kann es ueberziehen, bis er selbst die Verbindung schliesst.

Folge fuer `websuche.recherchiere`: die Annahme "ein aufgegebener Thread
endet von selbst kurz nach dem Seitenbudget" traegt nicht mehr. Sie war die
Begruendung dafuer, auf einen Waechter fuer die Abruf-Threads zu verzichten.
Solange es keinen gibt, zaehlt und meldet `recherchiere` die aufgegebenen
Abrufe wenigstens, statt sie still zu verlieren.
"""
from __future__ import annotations

import ipaddress
import re
import socket
import threading
import time
import urllib.robotparser
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import requests
import urllib3
from bs4 import BeautifulSoup

USER_AGENT = ("WHITESTAG-Websuche/1.0 "
              "(Recherche-Agent; kontakt: ws@whitestag.ai)")

# Sagt dem Server, was wir verwerten koennen. Ersetzt keine Pruefung — viele
# Server ignorieren Accept —, spart aber die Uebertragung offensichtlicher
# Binaerformate.
ACCEPT = "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1"

# Alles ausserhalb dieser Liste ist kein Fliesstext. Ein PDF lieferte bisher
# 12.000 Zeichen "%PDF-1.4 ..." als `text`, zaehlte damit als verwertbare
# Quelle und unterdrueckte den Hinweis auf zu wenige Quellen.
TEXT_MIMES = {"text/html", "application/xhtml+xml", "text/plain",
              "application/xml", "text/xml", "text/markdown"}

# Weiterleitungen werden selbst gefahren, damit jedes Ziel vor dem Abruf
# geprueft werden kann. Fuenf Spruenge decken die ueblichen
# http->https->www->Sprachpfad-Ketten ab.
MAX_WEITERLEITUNGEN = 5
WEITERLEITUNGS_CODES = (301, 302, 303, 307, 308)

# Obergrenze fuer den gelesenen Rumpf. `timeout` von requests ist ein
# Lesetimeout ZWISCHEN Bytes, kein Gesamtdeckel: ohne diese Grenze landet eine
# 500-MB-Datei vollstaendig im Speicher. 2 MB HTML sind weit mehr, als fuer
# 12.000 Zeichen Fliesstext je gebraucht werden.
MAX_RUMPF_BYTES = 2_000_000

# Auch die robots.txt wird gedeckelt gelesen. RFC 9309, 2.5 verlangt von
# Crawlern, mindestens 500 KiB zu verarbeiten — mehr ist keine Regeldatei,
# sondern ein Speicherangriff unter freundlichem Namen.
MAX_ROBOTS_BYTES = 512_000

# Anteil des Seitenbudgets, das der robots.txt-Abruf hoechstens verbrauchen darf.
ROBOTS_TIMEOUT = 5.0

ROBOTS_ACCEPT = "text/plain,*/*;q=0.1"

# Groesse eines Leseschritts. Kein Deckel, sondern eine Obergrenze: gelesen
# wird mit `read1()`, das zurueckkehrt, sobald ueberhaupt etwas da ist.
LESE_STUECK = 16384

# Obergrenze fuer eine EINZELNE Socket-Operation (Verbinden bzw. ein recv).
# Sie begrenzt den Fall "Server schweigt": ohne sie stuende dort das volle
# Restbudget noch einmal. Ein Server, der laenger als 5 s gar nichts sendet,
# ist fuer eine Recherche ohnehin verloren. Gegen einen Server, der
# ununterbrochen gueltige Bytes ohne Nutzinhalt schickt, hilft sie nicht —
# siehe Modul-Docstring.
SOCKET_FRIST = 5.0

# Eigene Schranke fuer die Namensaufloesung: `socket.getaddrinfo` kennt kein
# timeout-Argument und haengt an einem stummen Resolver, bis das System
# aufgibt. Ohne diese Schranke laeuft die Zielpruefung selbst aus dem Budget.
DNS_FRIST = 3.0

# Alles, was auf jeder Seite steht und in keinem Zitat etwas verloren hat.
BEIWERK = ("script", "style", "nav", "header", "footer", "aside", "noscript",
           "form", "iframe")


@dataclass(frozen=True)
class AbrufErgebnis:
    text: str | None = None
    fehler: str | None = None


def _aufloesen(host: str) -> list[str]:
    """Namensaufloesung als eigene Funktion, damit Tests sie ersetzen koennen."""
    return [eintrag[4][0]
            for eintrag in socket.getaddrinfo(host, None,
                                              type=socket.SOCK_STREAM)]


def _aufloesen_mit_frist(host: str, sekunden: float) -> list[str]:
    """`_aufloesen` mit Zeitschranke.

    `socket.getaddrinfo` nimmt kein timeout entgegen und laesst sich nicht
    unterbrechen. Der Aufrufer bekommt seine Frist deshalb ueber einen
    Hilfsfaden zurueck; die Aufloesung selbst laeuft dort weiter, bis der
    System-Resolver aufgibt. Der Faden ist ein Daemon und haelt weder den
    Dienst noch das CLI beim Beenden auf.
    """
    ergebnis: dict = {}

    def arbeite():
        try:
            ergebnis["adressen"] = _aufloesen(host)
        except BaseException as e:  # noqa: BLE001 — wird unten weitergeworfen
            ergebnis["fehler"] = e

    faden = threading.Thread(target=arbeite, daemon=True,
                             name=f"dns-{host}")
    faden.start()
    faden.join(max(0.0, sekunden))
    if faden.is_alive():
        # TimeoutError ist ein OSError — der Aufrufer faengt beides gemeinsam.
        raise TimeoutError(f"Aufloesung ueberschritt {sekunden:.1f}s")
    if "fehler" in ergebnis:
        raise ergebnis["fehler"]
    return ergebnis.get("adressen", [])


def pruefe_ziel(url: str, aufloese_frist: float = DNS_FRIST) -> str | None:
    """`None`, wenn die URL abgerufen werden darf, sonst der Grund im Klartext.

    Hintergrund: auf dieser Maschine laufen mehrere auth-freie Dienste auf
    Loopback (vault-lookup :7788, Brain :7777/:7778, n8n :5678, Paperclip
    :3100, PII-Proxy :4711) — auth-frei genau deshalb, weil sie als nur lokal
    erreichbar gelten. Eine Trefferseite, die uns dorthin umleitet, wuerde
    deren Antwort als "Quelltext" ins Dossier tragen.

    Geprueft wird die aufgeloeste Adresse, nicht nur das URL-Literal: ein
    Hostname kann per DNS ebenso auf 127.0.0.1 zeigen. Gegen einen aktiven
    DNS-Rebinding-Angreifer (Antwort wechselt zwischen Pruefung und Verbindung)
    schuetzt das nicht — dafuer muesste die Verbindung auf die gepruefte IP
    festgenagelt werden. Der hier abgewehrte Fall ist die umleitende Fremdseite.
    """
    teile = urlparse(url)
    if teile.scheme not in ("http", "https"):
        return (f"Schema '{teile.scheme}' nicht erlaubt — abgerufen werden "
                f"nur http und https")
    host = teile.hostname
    if not host:
        return f"URL ohne Hostnamen: {url}"

    try:
        adressen = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            adressen = [ipaddress.ip_address(a)
                        for a in _aufloesen_mit_frist(host, aufloese_frist)]
        except (OSError, ValueError) as e:
            return f"Hostname '{host}' nicht aufloesbar: {e}"
    if not adressen:
        return f"Hostname '{host}' liefert keine Adresse"

    for adresse in adressen:
        # ::ffff:127.0.0.1 ist Loopback, auch wenn es als IPv6 daherkommt.
        adresse = getattr(adresse, "ipv4_mapped", None) or adresse
        if (adresse.is_private or adresse.is_loopback or adresse.is_link_local
                or adresse.is_reserved or adresse.is_multicast
                or adresse.is_unspecified):
            return (f"Ziel '{host}' zeigt auf die lokale/private Adresse "
                    f"{adresse} — Abruf verweigert: dort laufen Hausdienste, "
                    f"deren Antwort keine Quelle ist")
    return None


def extrahiere_text(html) -> str:
    suppe = BeautifulSoup(html, "html.parser")
    for tag in suppe(BEIWERK):
        tag.decompose()
    text = suppe.get_text("\n")
    # Mehrfache Leerzeilen falten — sie kosten Kontext und tragen nichts.
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*", "\n\n", text)
    return text.strip()


def kappe(text: str, max_zeichen: int) -> str:
    if len(text) <= max_zeichen:
        return text
    # Die Marke muss sichtbar sein, sonst haelt das Modell die Seite fuer
    # zu Ende gelesen und zitiert einen abgeschnittenen Satz als Befund.
    return text[:max_zeichen] + f"… [gekappt bei {max_zeichen} Zeichen]"


ALLES_ERLAUBT = "alles erlaubt"
ALLES_VERBOTEN = "alles verboten"


def _hole_robots(url: str, timeout: float):
    """Holt die robots.txt einer Domain und gibt die Regel zurueck.

    Laeuft ueber denselben Kern wie der Seitenabruf. Vorher stand hier ein
    blankes `requests.get()`: Weiterleitungen wurden blind verfolgt, ohne
    Zielpruefung, ohne Deckel, ohne echte Zeitgrenze. Eine robots.txt, die
    auf einen Hausdienst umleitete, loeste dort eine echte Anfrage aus — der
    Rumpf landete zwar in keinem Ergebnis, aber bei auth-freien Diensten ist
    die ausgeloeste Anfrage selbst der Schaden (n8n-Webhook).
    """
    teile = urlparse(url)
    robots_url = urljoin(f"{teile.scheme}://{teile.netloc}", "/robots.txt")
    roh = _hole_gedeckelt(
        robots_url, time.monotonic() + timeout, accept=ROBOTS_ACCEPT,
        max_bytes=MAX_ROBOTS_BYTES,
        # Nur ein 200 hat einen Rumpf, der uns interessiert.
        kopf_pruefung=lambda a: (None if a.status_code == 200
                                 else f"HTTP {a.status_code}"))

    if roh.status >= 500:
        # RFC 9309, 2.3.1.4: ein "unreachable" robots.txt bedeutet komplettes
        # Verbot. Bisher galt jeder Status ausser 200 als Freibrief — genau
        # verkehrt herum fuer den Fall, dass der Server gerade taumelt.
        return ALLES_VERBOTEN
    if roh.status != 200:
        # Deckt auch status == 0 ab: Netzfehler, abgelaufene Zeit und das
        # verweigerte Umleitungsziel. Keine erreichbare robots.txt ist keine
        # Verbotsregel — und das verweigerte Ziel ist kein Schlupfloch, denn
        # wer die Weiterleitung setzt, ist der Seitenbetreiber selbst; der
        # koennte genauso gut eine leere robots.txt ausliefern.
        return ALLES_ERLAUBT
    parser = urllib.robotparser.RobotFileParser()
    # RFC 9309, 2.3: robots.txt ist UTF-8. `requests` haette hier ohne
    # charset-Angabe ISO-8859-1 geraten.
    parser.parse(roh.rumpf.decode("utf-8", "replace").splitlines())
    return parser


def _bewerte(regel, url: str) -> bool:
    if regel is ALLES_ERLAUBT:
        return True
    if regel is ALLES_VERBOTEN:
        return False
    return regel.can_fetch(USER_AGENT, url)


class RobotsSpeicher:
    """Merkt die robots.txt je Host fuer die Dauer EINES Laufs.

    Ohne das holt jede Seite ihre robots.txt neu — bei mehreren Seiten
    derselben Domain (--gleiche-domain-erlauben) und bei Weiterleitungen
    innerhalb einer Domain ist das reine Budgetverschwendung.

    Bewusst kein Prozess-Cache mit TTL: der Dienst laeuft wochenlang, und
    eine veraltete robots.txt waere ein leiser Regelbruch. Ein Lauf dauert
    Sekunden — so lange ist die Datei sicher gueltig.
    """

    def __init__(self):
        self._regeln = {}
        self._sperren = {}
        self._verwaltung = threading.Lock()

    def _sperre_fuer(self, host: str) -> threading.Lock:
        # Feingranular je Host: der Abruf laeuft parallel, und eine lahme
        # robots.txt darf nicht die Abrufe anderer Domains aufhalten.
        with self._verwaltung:
            return self._sperren.setdefault(host, threading.Lock())

    def darf(self, url: str, timeout: float = ROBOTS_TIMEOUT) -> bool:
        teile = urlparse(url)
        host = f"{teile.scheme}://{teile.netloc}".lower()
        with self._sperre_fuer(host):
            if host not in self._regeln:
                self._regeln[host] = _hole_robots(url, timeout)
            regel = self._regeln[host]
        return _bewerte(regel, url)


def darf_abrufen(url: str, timeout: float = ROBOTS_TIMEOUT) -> bool:
    """Einzelabfrage ohne Cache — fuer Aufrufer ausserhalb eines Laufs."""
    return _bewerte(_hole_robots(url, timeout), url)


def _formatfehler(content_type: str, rumpf: bytes) -> str | None:
    """Gibt eine Fehlermeldung zurueck, wenn der Inhalt kein Fliesstext ist."""
    mime = (content_type or "").split(";")[0].strip().lower()
    if mime:
        if mime.startswith("text/") or mime in TEXT_MIMES:
            return None
        return (f"Kein auswertbarer Text, sondern {mime} — Inhalt nicht "
                f"zitierfaehig extrahierbar")
    # Ohne Content-Type entscheidet der Rumpf: Nullbytes und die bekannten
    # Dateisignaturen sind sichere Zeichen fuer Binaerinhalt.
    probe = rumpf[:1024]
    if b"\x00" in probe or probe.startswith((b"%PDF", b"\x89PNG", b"\xff\xd8\xff",
                                             b"PK\x03\x04", b"GIF8")):
        return "Binaerinhalt ohne Content-Type — nicht zitierfaehig extrahierbar"
    return None


def _lies_gedeckelt(antwort, frist: float,
                    max_bytes: int) -> tuple[bytes, str | None]:
    """Liest stroemend bis zur Groessen- oder Zeitgrenze.

    Gelesen wird mit `raw.read1()` statt mit `iter_content()`. Der
    Unterschied ist der ganze Punkt: `iter_content(n)` kehrt erst zurueck,
    wenn n Bytes beisammen sind — bei 8 Bytes alle 20 ms sind das fuer 16 KB
    ueber 40 Sekunden, und die Fristpruefung zwischen den Stuecken kommt in
    dieser Zeit kein einziges Mal an die Reihe (gemessen: 30 s bei 1 s
    Budget). `read1()` gibt zurueck, was da ist, sobald etwas da ist — erst
    damit wird die Fristpruefung wirksam.

    Der Groessendeckel kappt nur (die 12.000 Zeichen Fliesstext stecken laengst
    in den ersten Bytes); die Zeitgrenze ist ein Fehler, weil ein
    troepfelnder Server sonst das Budget aller anderen Quellen mitverbrennt.
    """
    rumpf = bytearray()
    while True:
        stueck = antwort.raw.read1(LESE_STUECK, decode_content=True)
        if not stueck:
            return bytes(rumpf), None
        rumpf.extend(stueck)
        if len(rumpf) >= max_bytes:
            return bytes(rumpf[:max_bytes]), None
        if time.monotonic() >= frist:
            return bytes(rumpf), "abgelaufen"


@dataclass(frozen=True)
class RohAntwort:
    """Was der gemeinsame Kern zurueckgibt. `status == 0` heisst: es kam gar
    keine Antwort zustande (Netzfehler, Zeit abgelaufen oder verweigertes
    Ziel) — was davon, steht in `fehler` bzw. `zeit_aus`."""
    status: int = 0
    kopf: dict | None = None
    rumpf: bytes = b""
    fehler: str | None = None
    zeit_aus: bool = False


def _hole_gedeckelt(url: str, frist: float, *, accept: str, max_bytes: int,
                    vor_abruf=None, kopf_pruefung=None) -> RohAntwort:
    """Gemeinsamer Kern von Seiten- und robots-Abruf.

    Es gab diese Logik einmal zweimal: streng fuer die Seite, mit blankem
    `requests.get()` fuer die robots.txt. Genau in der zweiten Kopie fehlten
    Zielpruefung, Sprungkontrolle und Deckel — eine robots.txt, die auf
    127.0.0.1:5678 umleitete, loeste eine echte Anfrage an n8n aus. Eine
    zweite, leicht abweichende Kopie derselben Sicherheitslogik ist der Grund,
    warum solche Luecken entstehen; deshalb steht sie jetzt nur noch hier.

    Zugesichert wird:
    - `pruefe_ziel()` vor jedem Verbindungsaufbau UND vor jedem Sprung,
    - `allow_redirects=False` mit eigener, gedeckelter Sprungkontrolle,
    - stroemendes Lesen mit Groessendeckel und Fristpruefung je Leseschritt,
    - jede einzelne Socket-Operation auf `min(Restbudget, SOCKET_FRIST)`.

    `vor_abruf(ziel)` darf jeden Sprung mit einem Grund ablehnen (die Seite
    haengt dort ihre robots.txt-Pruefung ein). `kopf_pruefung(antwort)` darf
    nach den Kopfzeilen entscheiden, dass der Rumpf gar nicht erst gelesen
    wird — so muss ein 500-MB-PDF nicht gelesen werden, um als PDF zu gelten.
    """
    aktuell = url
    for _sprung in range(MAX_WEITERLEITUNGEN + 1):
        rest = frist - time.monotonic()
        if rest <= 0:
            return RohAntwort(zeit_aus=True)
        # Zuerst die Frist, dann die Aufloesung: `pruefe_ziel` loest Namen auf
        # und bekommt dafuer ausdruecklich nur das, was vom Budget uebrig ist.
        grund = pruefe_ziel(aktuell, aufloese_frist=min(rest, DNS_FRIST))
        if grund:
            return RohAntwort(fehler=grund)

        rest = frist - time.monotonic()
        if rest <= 0:
            return RohAntwort(zeit_aus=True)
        if vor_abruf is not None:
            grund = vor_abruf(aktuell)
            if grund:
                return RohAntwort(fehler=grund)

        rest = frist - time.monotonic()
        if rest <= 0:
            return RohAntwort(zeit_aus=True)
        schritt = min(rest, SOCKET_FRIST)
        try:
            antwort = requests.get(
                aktuell, timeout=(schritt, schritt),
                headers={"User-Agent": USER_AGENT, "Accept": accept},
                allow_redirects=False, stream=True)
        except requests.exceptions.Timeout:
            return RohAntwort(zeit_aus=True)
        except requests.exceptions.RequestException as e:
            return RohAntwort(fehler=f"Abruf fehlgeschlagen: {e}")

        if antwort.status_code in WEITERLEITUNGS_CODES:
            ziel = antwort.headers.get("Location")
            antwort.close()
            if not ziel:
                return RohAntwort(
                    status=antwort.status_code,
                    fehler=f"Weiterleitung (HTTP {antwort.status_code}) "
                           f"ohne Zieladresse")
            # Jedes neue Ziel geht oben wieder durch pruefe_ziel().
            aktuell = urljoin(aktuell, ziel)
            continue
        break
    else:
        return RohAntwort(
            fehler=f"Mehr als {MAX_WEITERLEITUNGEN} Weiterleitungen — Kette "
                   f"abgebrochen (letztes Ziel: {aktuell})")

    kopf = dict(antwort.headers)
    if kopf_pruefung is not None:
        grund = kopf_pruefung(antwort)
        if grund:
            antwort.close()
            return RohAntwort(status=antwort.status_code, kopf=kopf,
                              fehler=grund)

    try:
        rumpf, zeitfehler = _lies_gedeckelt(antwort, frist, max_bytes)
    # `raw.read1()` geht an `requests` vorbei und wirft deshalb die rohen
    # urllib3-Ausnahmen, die `iter_content()` sonst uebersetzt haette.
    except (requests.exceptions.Timeout, urllib3.exceptions.TimeoutError):
        return RohAntwort(status=antwort.status_code, kopf=kopf, zeit_aus=True)
    except (requests.exceptions.RequestException,
            urllib3.exceptions.HTTPError, OSError) as e:
        return RohAntwort(status=antwort.status_code, kopf=kopf,
                          fehler=f"Abruf fehlgeschlagen: {e}")
    finally:
        antwort.close()
    if zeitfehler:
        return RohAntwort(status=antwort.status_code, kopf=kopf, rumpf=rumpf,
                          zeit_aus=True)
    return RohAntwort(status=antwort.status_code, kopf=kopf, rumpf=rumpf)


def _seiten_kopf_pruefung(antwort) -> str | None:
    if antwort.status_code >= 400:
        return f"HTTP {antwort.status_code}"
    # Erst der Header — ein 500-MB-PDF muss nicht gelesen werden, um als
    # PDF erkannt zu werden.
    return _formatfehler(antwort.headers.get("Content-Type", ""), b"")


def hole_text(url: str, max_zeichen: int = 12000, timeout: float = 10.0,
              robots: "RobotsSpeicher | None" = None) -> AbrufErgebnis:
    """Holt eine Seite und gibt ihren Fliesstext zurueck.

    `timeout` ist das Budget dieser Seite — Namensaufloesung, robots.txt,
    alle Weiterleitungen und der Rumpf zusammen. Wie hart dieses Budget
    wirklich ist und wo es sich brechen laesst, steht im Modul-Docstring
    unter "WAS DAS ZEITBUDGET WIRKLICH LEISTET" — mit Messwerten.
    """
    frist = time.monotonic() + timeout
    zeit_aus = AbrufErgebnis(fehler=f"Zeit überschritten nach {timeout}s")

    def robots_tor(ziel: str) -> str | None:
        rest = frist - time.monotonic()
        budget = min(max(0.0, rest), ROBOTS_TIMEOUT)
        erlaubt = (robots.darf(ziel, budget) if robots is not None
                   else darf_abrufen(ziel, timeout=budget))
        return None if erlaubt else "Abruf laut robots.txt nicht erlaubt"

    roh = _hole_gedeckelt(url, frist, accept=ACCEPT,
                          max_bytes=MAX_RUMPF_BYTES, vor_abruf=robots_tor,
                          kopf_pruefung=_seiten_kopf_pruefung)
    if roh.zeit_aus:
        return zeit_aus
    if roh.fehler:
        return AbrufErgebnis(fehler=roh.fehler)

    typ = (roh.kopf or {}).get("Content-Type", "")
    rumpf = roh.rumpf
    # Zweiter Durchgang: ohne Content-Type entscheidet der Rumpf.
    fehler = _formatfehler(typ, rumpf)
    if fehler:
        return AbrufErgebnis(fehler=fehler)

    try:
        # Bytes statt str an bs4: dessen Encoding-Erkennung (UnicodeDammit)
        # trifft es besser als requests' ISO-8859-1-Default fuer text/html
        # ohne charset — sonst stehen deutsche Umlaute als Moji im Zitat.
        text = kappe(extrahiere_text(rumpf), max_zeichen)
    except Exception as e:
        return AbrufErgebnis(fehler=f"Text-Extraktion fehlgeschlagen: {e}")
    if not text:
        return AbrufErgebnis(fehler="Seite enthielt keinen lesbaren Text")
    return AbrufErgebnis(text=text)
