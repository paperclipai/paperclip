"""Eine einzelne Seite holen und ihren Fließtext extrahieren.

Bewusst ohne Kenntnis der Suchquelle: was hier hereinkommt, ist eine URL, was
herausgeht, ist entweder Text oder eine Fehlermeldung — nie beides.
"""
from __future__ import annotations

import ipaddress
import re
import socket
import time
import urllib.robotparser
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import requests
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

# Anteil des Seitenbudgets, das der robots.txt-Abruf hoechstens verbrauchen darf.
ROBOTS_TIMEOUT = 5.0

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


def pruefe_ziel(url: str) -> str | None:
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
            adressen = [ipaddress.ip_address(a) for a in _aufloesen(host)]
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


def darf_abrufen(url: str, timeout: float = 5.0) -> bool:
    teile = urlparse(url)
    robots_url = urljoin(f"{teile.scheme}://{teile.netloc}", "/robots.txt")
    try:
        antwort = requests.get(robots_url, timeout=timeout,
                               headers={"User-Agent": USER_AGENT})
    except requests.exceptions.RequestException:
        # Keine erreichbare robots.txt ist keine Verbotsregel.
        return True
    if antwort.status_code != 200:
        return True
    parser = urllib.robotparser.RobotFileParser()
    parser.parse(antwort.text.splitlines())
    return parser.can_fetch(USER_AGENT, url)


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


def _lies_gedeckelt(antwort, frist: float) -> tuple[bytes, str | None]:
    """Liest stroemend bis zur Groessen- oder Zeitgrenze.

    Der Groessendeckel kappt nur (die 12.000 Zeichen Fliesstext stecken laengst
    in den ersten Bytes); die Zeitgrenze ist ein Fehler, weil ein
    troepfelnder Server sonst das Budget aller anderen Quellen mitverbrennt.
    """
    rumpf = bytearray()
    for stueck in antwort.iter_content(16384):
        rumpf.extend(stueck)
        if len(rumpf) >= MAX_RUMPF_BYTES:
            return bytes(rumpf[:MAX_RUMPF_BYTES]), None
        if time.monotonic() >= frist:
            return bytes(rumpf), "abgelaufen"
    return bytes(rumpf), None


def hole_text(url: str, max_zeichen: int = 12000,
              timeout: float = 10.0) -> AbrufErgebnis:
    # `timeout` ist ab hier das GESAMTbudget dieser Seite: robots.txt, alle
    # Weiterleitungen und der Rumpf zusammen.
    frist = time.monotonic() + timeout
    zeit_aus = AbrufErgebnis(fehler=f"Zeit überschritten nach {timeout}s")

    aktuell = url
    for _sprung in range(MAX_WEITERLEITUNGEN + 1):
        grund = pruefe_ziel(aktuell)
        if grund:
            return AbrufErgebnis(fehler=grund)

        rest = frist - time.monotonic()
        if rest <= 0:
            return zeit_aus
        if not darf_abrufen(aktuell, timeout=min(rest, ROBOTS_TIMEOUT)):
            return AbrufErgebnis(fehler="Abruf laut robots.txt nicht erlaubt")

        rest = frist - time.monotonic()
        if rest <= 0:
            return zeit_aus
        try:
            antwort = requests.get(
                aktuell, timeout=(min(rest, 5.0), rest),
                headers={"User-Agent": USER_AGENT, "Accept": ACCEPT},
                allow_redirects=False, stream=True)
        except requests.exceptions.Timeout:
            return zeit_aus
        except requests.exceptions.RequestException as e:
            return AbrufErgebnis(fehler=f"Abruf fehlgeschlagen: {e}")

        if antwort.status_code in WEITERLEITUNGS_CODES:
            ziel = antwort.headers.get("Location")
            antwort.close()
            if not ziel:
                return AbrufErgebnis(
                    fehler=f"Weiterleitung (HTTP {antwort.status_code}) "
                           f"ohne Zieladresse")
            # Jedes neue Ziel geht oben wieder durch pruefe_ziel().
            aktuell = urljoin(aktuell, ziel)
            continue
        break
    else:
        return AbrufErgebnis(
            fehler=f"Mehr als {MAX_WEITERLEITUNGEN} Weiterleitungen — Kette "
                   f"abgebrochen (letztes Ziel: {aktuell})")

    try:
        antwort.raise_for_status()
    except requests.exceptions.HTTPError as e:
        antwort.close()
        return AbrufErgebnis(fehler=f"HTTP {e.response.status_code}")

    typ = antwort.headers.get("Content-Type", "")
    # Erst der Header — ein 500-MB-PDF muss nicht gelesen werden, um als
    # PDF erkannt zu werden.
    fehler = _formatfehler(typ, b"")
    if fehler:
        antwort.close()
        return AbrufErgebnis(fehler=fehler)

    try:
        rumpf, zeitfehler = _lies_gedeckelt(antwort, frist)
    except requests.exceptions.Timeout:
        return zeit_aus
    except requests.exceptions.RequestException as e:
        return AbrufErgebnis(fehler=f"Abruf fehlgeschlagen: {e}")
    finally:
        antwort.close()
    if zeitfehler:
        return zeit_aus

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
