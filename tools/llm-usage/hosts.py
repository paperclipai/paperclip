#!/usr/bin/env python3
"""Wo laeuft welches Modell? — Zuordnung Modell-ID -> Ausfuehrungsort.

Warum es das gibt: `cost_events` kennt keinen Host. Es gibt nur `provider`
(`anthropic` / `lmstudio`) und `model`; alle Agenten zeigen auf
`http://localhost:1234`, und LM Link routet von dort unsichtbar auf die
Maschine, die das Modell haelt. Aus dem Datensatz allein laesst sich der Ort
also nicht ablesen.

Zwei Wege fuehren zusammen:

1. **Die Tabelle `ZUORDNUNG` unten** ist die Quelle fuer den Report. Sie
   funktioniert auch fuer Modelle, die gerade nicht geladen sind — die RTX ist
   nachts aus, und ein Modell kann tagsueber tausend Aufrufe gehabt haben und
   abends entladen sein.
2. **`lms ps` als Selbstkontrolle.** Beim Digest-Lauf wird die Live-Belegung
   gegen die Tabelle gehalten; jede Abweichung wird in der Mail gemeldet
   (`abweichungen()`). Ohne diesen Abgleich veraltet die Tabelle still —
   `gemma-4-31b` ist seit Juli 2026 dreimal umgezogen (Studio -> MacBook -> RTX).

Grundregel wie in `pricing.py`: **lieber `unbekannt` als geraten.** Ein
`-mlx`-Suffix ist KEIN Geraetemerkmal — `gemma4-31b-it` hat keines und laeuft
auf der RTX, `qwen/qwen3-coder-30b` hat keines und laeuft auf der Studio.

VORBEHALT, der auch in der Mail steht: die Angabe ist der Ort von *heute*,
nicht der vom Tag des Aufrufs. Fuer die Vortagstabelle stimmt das praktisch
immer, fuer den 7-Tage-Block nach einem Umzug nicht.
"""
import os
import re
import subprocess
from datetime import date
from typing import Optional

CLOUD = "Cloud"
UNBEKANNT = "unbekannt"

# Bis zu diesem Tag war der Mac Studio der EINZIGE LLM-Server. Erst mit der
# Lastverteilung vom 06.07.2026 kamen MacBook (ueber LM Link) und RTX dazu.
# Fuer alles davor ist der Ort damit unabhaengig von der Tabelle bekannt —
# `gemma-4-31b-it-mlx` liegt heute auf dem MacBook, lief im Mai aber auf der
# Studio. Ohne diesen Stichtag bekaeme die Vault-Historie ab dem 16.04. rund
# tausend Zeilen mit dem falschen Geraet.
VERTEILUNG_AB = date(2026, 7, 6)

# Klarnamen fuer die DEVICE-Spalte von `lms ps`. "Local" ist die Maschine, auf
# der LM Studio selbst laeuft — das ist der Mac Studio M4 (128 GB), auf dem
# auch Paperclip, n8n und der PII-Proxy liegen.
GERAETE = {
    "Local": "Mac Studio",
    "MacbookM5Mx128": "MacBook",
    "RTX Pro 6000": "RTX",
}

# Modell-ID exakt so, wie sie in `cost_events.model` steht -> Ort.
# Stand 2026-08-23, abgeglichen gegen `lms ps`.
ZUORDNUNG = {
    # --- RTX Pro 6000 (96 GB, CUDA; nachts aus) ---
    "gemma4-31b-it":                            "RTX",
    "abiray/qwen3.6-35b-a3b":                   "RTX",
    "google/gemma-4-12b-qat":                   "RTX",
    # --- MacBook Pro M5 Max (128 GB, MLX) ---
    "gemma-4-31b-it-mlx":                       "MacBook",
    "qwen3.6-35b-a3b-mlx":                      "MacBook",
    "mistral-small-3.2-24b-instruct-2506-mlx":  "MacBook",
    "openbiollm-llama3-8b.gguf":                "MacBook",
    # --- Mac Studio M4 (128 GB, "Local") ---
    "google/gemma-4-12b":                       "Mac Studio",
    "qwen/qwen3-coder-30b":                     "Mac Studio",
    "text-embedding-bge-m3":                    "Mac Studio",

    # --- Stillgelegt: letzter bekannter Ort, eingefroren ---
    # Die kumulative Vault-CSV reicht bis zum 16.04.2026 zurueck. Diese Modelle
    # sind deinstalliert, koennen also nicht mehr umziehen und tauchen in
    # `lms ps` nie wieder auf — ohne Eintrag stuenden ihre Zeilen dauerhaft auf
    # 'unbekannt'. Bis Anfang Juli 2026 war der Mac Studio der einzige
    # LLM-Server; erst danach kamen MacBook (LM Link) und RTX dazu.
    "qwen3.6-35b":                              "Mac Studio",   # bis 19.06.
    "qwen/qwen3.6-35b-a3b":                     "Mac Studio",   # bis 23.04.
    "gemma-4-31b-it":                           "Mac Studio",   # bis 19.06.
    "google/gemma-4-26b-a4b":                   "Mac Studio",   # bis 14.05.
    "qwen2.5-32b-instruct-mlx":                 "Mac Studio",   # bis 23.04.
    "qwen3.6-35b-a3b-turboquant-mlx":           "Mac Studio",   # bis 15.06.
    "qwen3.6-35b-a3b-ud-mlx":                   "Mac Studio",   # bis 21.05.
    "mistralai/mistral-small-3.2":              "Mac Studio",   # bis 21.05.
    "mistral-small-3.2-24b-instruct-2506":      "Mac Studio",   # bis 15.05.
    "mistral-small-3.2-24b-instruct-2506@q8_0": "Mac Studio",   # bis 22.05.
    "mistral-small-3.2-24b-instruct-2506@q4_k_m": "Mac Studio",  # bis 22.05.
    # Der Q8-Zwilling OHNE Suffix lag auf der RTX — nicht mit
    # `qwen3.6-35b-a3b-mlx` (MacBook) verwechseln; laut Memory ist genau diese
    # Namensnaehe die groesste Fehlerklasse der Flotte.
    "qwen3.6-35b-a3b":                          "RTX",          # 13.-18.07.
    "qwen/qwen3-coder-next":                    "RTX",          # bis 29.07.
    "openai/gpt-oss-120b":                      "MacBook",      # 06.07.
}

LMS_CLI = os.path.expanduser("~/.lmstudio/bin/lms")


def normalisiere(model) -> str:
    """Modell-ID auf den Tabellen-Schluessel bringen (wie pricing.normalisiere)."""
    m = (model or "").strip()
    if m.endswith("[1m]"):
        m = m[:-4]
    return m


def ist_cloud(model) -> bool:
    """Negativtest auf `claude-` — identisch zur Logik in `pricing.ist_lokal()`.

    So kann ein neues Anthropic-Modell nie als 'unbekannt' erscheinen: sein
    Ort steht auch ohne Tabelleneintrag fest.
    """
    return normalisiere(model).startswith("claude-")


def _als_datum(tag):
    """`date`, ISO-String oder None -> `date` oder None.

    Die Tag-Spalte kommt je nach Weg als `date` (psycopg2) oder als String
    ('YYYY-MM-DD', so reicht digest.py den Vortag durch). Ein Vergleich
    zwischen str und date wuerfe eine TypeError — mitten im 08:00-Lauf.
    """
    if tag is None or isinstance(tag, date):
        return tag
    try:
        return date.fromisoformat(str(tag))
    except ValueError:
        return None


def ort(model, tag: Optional[date] = None) -> str:
    """'Cloud', 'Mac Studio', 'MacBook', 'RTX' — oder 'unbekannt'.

    `tag` ist der Kalendertag des Aufrufs. Liegt er vor `VERTEILUNG_AB`, war
    der Mac Studio die einzige Maschine und die Tabelle (= heutiger Stand)
    gilt nicht. Ohne `tag` wird der heutige Ort ausgewiesen — das ist die
    richtige Antwort fuer die 7-Tage-Tabelle, die keinen einzelnen Tag hat.
    """
    m = normalisiere(model)
    if not m:
        return UNBEKANNT
    if ist_cloud(m):
        return CLOUD
    if _als_datum(tag) is not None and _als_datum(tag) < VERTEILUNG_AB:
        return "Mac Studio"
    return ZUORDNUNG.get(m, UNBEKANNT)


def unbekannte(modelle, tag: Optional[date] = None) -> list:
    """Die lokalen Modelle aus `modelle`, fuer die kein Ort hinterlegt ist."""
    return sorted({m for m in modelle if ort(m, tag) == UNBEKANNT})


def parse_lms_ps(text: str) -> dict:
    """Modell-ID -> Ort aus der Textausgabe von `lms ps`.

    Geschnitten wird nach den Spaltenpositionen der Kopfzeile, nicht per
    `split()`: der Geraetename enthaelt Leerzeichen ('RTX Pro 6000') und die
    TTL-Spalte dahinter kann gefuellt sein ('1h / 1h'). Ein Whitespace-Split
    zerlegt beides falsch.

    `lms ps --json` hilft hier nicht — dort steht nur ein Geraete-Hash, die
    Klarnamen gibt es ausschliesslich in der Textausgabe.
    """
    zeilen = (text or "").splitlines()
    kopf_idx = next(
        (i for i, z in enumerate(zeilen)
         if "IDENTIFIER" in z and "DEVICE" in z),
        None,
    )
    if kopf_idx is None:
        return {}

    kopf = zeilen[kopf_idx]
    spalten = [(m.group(), m.start()) for m in re.finditer(r"\S+", kopf)]
    namen = [n for n, _ in spalten]
    if "IDENTIFIER" not in namen or "DEVICE" not in namen:
        return {}

    def _bereich(name):
        i = namen.index(name)
        start = spalten[i][1]
        ende = spalten[i + 1][1] if i + 1 < len(spalten) else None
        return start, ende

    id_start, id_ende = _bereich("IDENTIFIER")
    dev_start, dev_ende = _bereich("DEVICE")

    ergebnis = {}
    for zeile in zeilen[kopf_idx + 1:]:
        if not zeile.strip():
            continue
        ident = zeile[id_start:id_ende].strip()
        geraet = zeile[dev_start:dev_ende].strip() if dev_ende else zeile[dev_start:].strip()
        if not ident or not geraet:
            continue
        # Unbekannte Geraetenamen bleiben woertlich stehen — ein viertes Geraet
        # soll als Abweichung auffallen, nicht stumm verschwinden.
        ergebnis[ident] = GERAETE.get(geraet, geraet)
    return ergebnis


def lade_live(timeout: int = 15) -> dict:
    """Live-Belegung von `lms ps` — leeres dict, wenn das nicht klappt.

    Vollen Pfad nutzen: ein npx-Wrapper aus nvm verdeckt `lms` im PATH und
    endet wirkungslos in einer 'Invalid usage'-Box.

    Faellt still auf {} zurueck. Der Live-Abgleich ist eine Kontrolle, kein
    Datenlieferant — er darf den Report nie kippen.
    """
    try:
        p = subprocess.run([LMS_CLI, "ps"], capture_output=True, text=True,
                           timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return {}
    if p.returncode != 0:
        return {}
    return parse_lms_ps(p.stdout)


def abweichungen(modelle, live: dict) -> list:
    """(modell, laut_tabelle, laut_lms_ps) fuer jedes Modell, das woanders liegt.

    Nicht gemeldet wird, was in `lms ps` fehlt: das heisst 'gerade entladen'
    (RTX nachts aus), nicht 'umgezogen'. Cloud-Modelle laufen nicht in
    LM Studio und werden gar nicht erst gesucht.
    """
    raus = []
    for m in sorted(set(modelle)):
        if ist_cloud(m):
            continue
        ist = live.get(normalisiere(m))
        if ist is None:
            continue
        soll = ort(m)
        if ist != soll:
            raus.append((normalisiere(m), soll, ist))
    return raus
