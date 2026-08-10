"""Eine einzelne Seite holen und ihren Fließtext extrahieren.

Bewusst ohne Kenntnis der Suchquelle: was hier hereinkommt, ist eine URL, was
herausgeht, ist entweder Text oder eine Fehlermeldung — nie beides.
"""
from __future__ import annotations

import re
import urllib.robotparser
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

USER_AGENT = ("WHITESTAG-Websuche/1.0 "
              "(Recherche-Agent; kontakt: ws@whitestag.ai)")

# Alles, was auf jeder Seite steht und in keinem Zitat etwas verloren hat.
BEIWERK = ("script", "style", "nav", "header", "footer", "aside", "noscript",
           "form", "iframe")


@dataclass(frozen=True)
class AbrufErgebnis:
    text: str | None = None
    fehler: str | None = None


def extrahiere_text(html: str) -> str:
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


def hole_text(url: str, max_zeichen: int = 12000,
              timeout: float = 10.0) -> AbrufErgebnis:
    if not darf_abrufen(url):
        return AbrufErgebnis(fehler="Abruf laut robots.txt nicht erlaubt")
    try:
        antwort = requests.get(url, timeout=timeout,
                               headers={"User-Agent": USER_AGENT})
        antwort.raise_for_status()
    except requests.exceptions.Timeout:
        return AbrufErgebnis(fehler=f"Zeit überschritten nach {timeout}s")
    except requests.exceptions.HTTPError as e:
        return AbrufErgebnis(fehler=f"HTTP {e.response.status_code}")
    except requests.exceptions.RequestException as e:
        return AbrufErgebnis(fehler=f"Abruf fehlgeschlagen: {e}")

    try:
        text = kappe(extrahiere_text(antwort.text), max_zeichen)
    except Exception as e:
        return AbrufErgebnis(fehler=f"Text-Extraktion fehlgeschlagen: {e}")
    if not text:
        return AbrufErgebnis(fehler="Seite enthielt keinen lesbaren Text")
    return AbrufErgebnis(text=text)
