#!/usr/bin/env python3
"""Modell-Steckbrief: Quantisierung, Kontextfenster und Thinking.

Anders als der Ausfuehrungsort ([[hosts.py]]) laesst sich das hier **messen** —
es braucht keine handgepflegte Tabelle:

* **Quantisierung und Kontextfenster** kommen aus `GET :1234/api/v0/models`.
  Die `quantization` steht dort auch bei `state: not-loaded`; das geladene
  Fenster (`loaded_context_length`) naturgemaess nur bei geladenen Modellen.
* **Thinking** kommt aus den LM-Studio-Logs: jede Vorhersage protokolliert
  `usage.completion_tokens_details.reasoning_tokens`. Ausgewiesen wird der
  Anteil der Vorhersagen mit Reasoning — keine Schaltung, sondern eine Quote.
  Gemessen ueber 36.000 Vorhersagen (22./23.08.2026) reicht sie von 0,0 %
  (`gemma-4-31b-it-mlx`) ueber 1,2 % (`gemma4-31b-it`, Jinja-Vorlage gepatcht)
  bis 97,0 % (`qwen3.6-35b-a3b-mlx`). Ein blosses „off" wuerde die Restquote
  verschweigen, deshalb steht sie in Klammern dabei.

Weil die RTX nachts aus ist und ein Modell entladen sein kann, merkt sich der
Report die zuletzt gesehenen Katalogwerte in `state/steckbrief-cache.json`.
Das pflegt sich selbst — im Gegensatz zur Ortstabelle braucht hier niemand
etwas nachzutragen.

**Anthropic:** keine Quantisierung (Cloud, `–`), Fenster bekannt (200K, bei der
`[1m]`-Variante 1M), Thinking **nicht ermittelbar** — `cost_events` fuehrt keine
Reasoning-Token und die `claude_local`-Agenten haben kein Thinking-Feld in der
`adapter_config`. Dort steht `?`, nicht `off`.
"""
import json
import os
import re
import urllib.request
from datetime import date
from typing import Optional

KATALOG_URL = "http://localhost:1234/api/v0/models"
LOG_DIR = os.path.expanduser("~/.lmstudio/server-logs")
DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DATEI = os.path.join(DIR, "state", "steckbrief-cache.json")

UNBEKANNT = "?"
CLOUD_QUANT = "–"
ANTHROPIC_CTX = 200_000
ANTHROPIC_CTX_1M = 1_000_000

# Ab dieser Quote gilt Thinking als eingeschaltet. Bewusst nicht 0: eine
# gepatchte Vorlage laesst eine Restquote von rund einem Prozent uebrig, und
# das ist etwas anderes als ein Modell, das bei jedem zweiten Aufruf denkt.
THINKING_SCHWELLE = 0.05

# Netz fuer Modelle, die aus dem Katalog verschwunden sind (deinstalliert oder
# auf einem abgeschalteten Geraet) und deshalb auch nie in den Cache kommen.
# Nur Werte mit Beleg — geraten wird hier nichts.
ERSATZ = {
    # unsloth/Qwen3.6-35B-A3B-MLX-8bit auf dem MacBook; MLX "context auto-fit"
    # zieht das Fenster auf das Modellmaximum hoch (262144), unabhaengig von -c.
    "qwen3.6-35b-a3b-mlx": {"quant": "8bit", "ctx": 262144},
}

_PRED = re.compile(r"\[INFO\]\[([^\]]+)\] Generated prediction: \{")


# --------------------------------------------------------------------------- #
# Katalog
# --------------------------------------------------------------------------- #
def parse_katalog(payload) -> dict:
    """Antwort von /api/v0/models -> {modell_id: {'quant':…, 'ctx':…}}."""
    eintraege = (payload or {}).get("data")
    if not isinstance(eintraege, list):
        return {}
    raus = {}
    for e in eintraege:
        if not isinstance(e, dict) or not e.get("id"):
            continue
        raus[e["id"]] = {
            "quant": e.get("quantization") or None,
            "ctx": e.get("loaded_context_length") or None,
        }
    return raus


def lade_katalog(timeout: int = 15) -> dict:
    """Live-Katalog — leeres dict, wenn LM Studio nicht erreichbar ist.

    Faellt still aus: der Steckbrief ist Beiwerk und darf den Report nie kippen.
    """
    try:
        with urllib.request.urlopen(KATALOG_URL, timeout=timeout) as r:
            return parse_katalog(json.load(r))
    except Exception:  # noqa: BLE001 — Netz, JSON, alles gleich unkritisch
        return {}


# --------------------------------------------------------------------------- #
# Thinking aus den LM-Studio-Logs
# --------------------------------------------------------------------------- #
def parse_denk_log(text: str) -> dict:
    """Eine Logdatei -> {modell: [vorhersagen, davon_mit_reasoning]}.

    Der JSON-Block wird klammerweise gelesen statt per Regex: er ist mehrzeilig
    eingerueckt. Die Datei der laufenden Stunde endet mitten im Block — ein
    unvollstaendiger Rest wird verworfen, nicht als Fehler behandelt.
    """
    raus = {}
    for m in _PRED.finditer(text):
        modell = m.group(1)
        i = text.index("{", m.end() - 1)
        tiefe, ende = 0, None
        for j in range(i, min(i + 20000, len(text))):
            if text[j] == "{":
                tiefe += 1
            elif text[j] == "}":
                tiefe -= 1
                if tiefe == 0:
                    ende = j
                    break
        if ende is None:
            continue
        try:
            d = json.loads(text[i:ende + 1])
        except ValueError:
            continue
        usage = d.get("usage") or {}
        det = usage.get("completion_tokens_details") or {}
        r = det.get("reasoning_tokens", usage.get("reasoning_tokens", 0)) or 0
        eintrag = raus.setdefault(modell, [0, 0])
        eintrag[0] += 1
        if r > 0:
            eintrag[1] += 1
    return raus


def _tagesliste(tage) -> list:
    """Ein Tag oder viele -> Liste von 'YYYY-MM-DD'."""
    if tage is None:
        return []
    if isinstance(tage, (str, date)):
        tage = [tage]
    return [t.isoformat() if isinstance(t, date) else str(t) for t in tage]


def denk_zaehler(tage, log_dir: str = LOG_DIR) -> dict:
    """Logdateien eines oder mehrerer Tage -> {modell: [vorhersagen, mit_reason]}.

    Rund 220 MB und 23 Dateien je Tag, gemessen ~2 s — vertretbar im
    08:00-Lauf. Das Excel blickt sieben Tage zurueck, deshalb wird ueber den
    ganzen Zeitraum summiert. Fehlt der Ordner (anderer Rechner, Logs
    aufgeraeumt), kommt ein leeres dict und die Spalte zeigt '?'.
    """
    raus = {}
    for tag in _tagesliste(tage):
        ordner = os.path.join(log_dir, tag[:7])      # ~/.lmstudio/server-logs/2026-08
        if not os.path.isdir(ordner):
            continue
        for name in sorted(os.listdir(ordner)):
            if not (name.startswith(tag + ".") and name.endswith(".log")):
                continue
            try:
                with open(os.path.join(ordner, name), encoding="utf-8",
                          errors="replace") as fh:
                    teil = parse_denk_log(fh.read())
            except OSError:
                continue
            for modell, (n, r) in teil.items():
                e = raus.setdefault(modell, [0, 0])
                e[0] += n
                e[1] += r
    return raus


# --------------------------------------------------------------------------- #
# Cache
# --------------------------------------------------------------------------- #
def lies_cache(pfad=CACHE_DATEI) -> dict:
    """Zuletzt gesehene Katalogwerte — {} bei fehlender oder kaputter Datei."""
    try:
        with open(pfad, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def schreibe_cache(katalog: dict, pfad=CACHE_DATEI) -> None:
    try:
        os.makedirs(os.path.dirname(str(pfad)), exist_ok=True)
        with open(pfad, "w", encoding="utf-8") as fh:
            json.dump(katalog, fh, ensure_ascii=False, indent=1, sort_keys=True)
    except OSError:
        pass  # Cache ist Komfort, kein Muss


def verschmelze(alt: dict, neu: dict) -> dict:
    """Live ueber Cache legen — ein heute fehlendes Modell bleibt erhalten."""
    zusammen = dict(alt)
    zusammen.update(neu)
    return zusammen


# --------------------------------------------------------------------------- #
# Darstellung
# --------------------------------------------------------------------------- #
def fmt_ctx(n) -> str:
    """98304 -> '96K', 262144 -> '256K', 200000 -> '200K', 1000000 -> '1M'.

    Zwei Zaehlweisen nebeneinander: LM Studio rechnet binaer (262144 = 256K),
    Anthropic dezimal (200.000 = 200K). 200000/1024 waere '195K' — falsch.
    """
    if not n:
        return UNBEKANNT
    n = int(n)
    if n % 1_000_000 == 0:
        return f"{n // 1_000_000}M"
    if n % 1024 == 0:
        return f"{n // 1024}K"
    if n % 1000 == 0:
        return f"{n // 1000}K"
    return f"{round(n / 1024)}K"


def fmt_thinking(quote: Optional[float]) -> str:
    """0.97 -> 'on (97 %)', 0.001 -> 'off (0,1 %)', None -> '?'.

    Die Quote steht immer dabei: 'off' allein wuerde verschweigen, dass
    `gemma4-31b-it` trotz gepatchter Vorlage noch bei gut einem Prozent denkt.
    """
    if quote is None:
        return UNBEKANNT
    p = quote * 100
    if 0 < p < 1:
        text = f"{p:.1f}".replace(".", ",")
    else:
        text = f"{round(p)}"
    return f"{'on' if quote >= THINKING_SCHWELLE else 'off'} ({text} %)"


# --------------------------------------------------------------------------- #
# Zugriff je Modell
# --------------------------------------------------------------------------- #
def _normalisiere(model) -> str:
    m = (model or "").strip()
    return m[:-4] if m.endswith("[1m]") else m


def _ist_cloud(model) -> bool:
    return _normalisiere(model).startswith("claude-")


def _eintrag(model, sb: dict) -> dict:
    m = _normalisiere(model)
    return (sb or {}).get("katalog", {}).get(m) or ERSATZ.get(m) or {}


def quant(model, sb: dict) -> str:
    if _ist_cloud(model):
        return CLOUD_QUANT
    return _eintrag(model, sb).get("quant") or UNBEKANNT


def ctx(model, sb: dict) -> str:
    if _ist_cloud(model):
        gross = str(model or "").strip().endswith("[1m]")
        return fmt_ctx(ANTHROPIC_CTX_1M if gross else ANTHROPIC_CTX)
    return fmt_ctx(_eintrag(model, sb).get("ctx"))


def denk_quote(model, sb: dict) -> Optional[float]:
    """Anteil der Vorhersagen mit Reasoning — None, wenn nichts gemessen wurde."""
    if _ist_cloud(model):
        return None
    z = (sb or {}).get("denken", {}).get(_normalisiere(model))
    if not z or not z[0]:
        return None
    return z[1] / z[0]


def thinking(model, sb: dict) -> str:
    return fmt_thinking(denk_quote(model, sb))


def unvollstaendig(modelle, sb: dict) -> list:
    """Lokale Modelle, zu denen weder Quantisierung noch Fenster bekannt sind.

    Gleiches Muster wie `pricing.unbekannte()` und `hosts.unbekannte()`: eine
    Luecke soll in der Mail auffallen, statt still als '?' durchzulaufen.
    Thinking bleibt bewusst aussen vor — dass ein Modell an einem Tag keine
    Vorhersage im Log hat, ist keine Luecke, sondern Normalbetrieb.
    """
    return sorted({
        m for m in modelle
        if not _ist_cloud(m)
        and quant(m, sb) == UNBEKANNT and ctx(m, sb) == UNBEKANNT
    })


# --------------------------------------------------------------------------- #
def erhebe(tage=None, cache_pfad=CACHE_DATEI) -> dict:
    """Den Steckbrief fuer einen Berichtszeitraum zusammentragen.

    `tage` ist ein Tag oder eine Liste von Tagen (die Mail nimmt den Vortag,
    das Excel die letzten sieben). Katalog live holen, ueber den Cache legen,
    Ergebnis zurueckschreiben — so ueberlebt ein nachts abgeschaltetes Geraet
    den naechsten Lauf.
    """
    katalog = verschmelze(lies_cache(cache_pfad), lade_katalog())
    if katalog:
        schreibe_cache(katalog, cache_pfad)
    return {"katalog": katalog, "denken": denk_zaehler(tage)}


def letzte_tage(n: int, bis=None) -> list:
    """Die letzten `n` Kalendertage bis einschliesslich `bis` (Vorgabe: heute)."""
    from datetime import timedelta
    ende = bis or date.today()
    if not isinstance(ende, date):
        ende = date.fromisoformat(str(ende))
    return [(ende - timedelta(days=i)).isoformat() for i in range(n)]
