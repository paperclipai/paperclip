"""Vault-Lookup — gemeinsame Nachschlage-Logik für die Chat-Bots (Luna/Jarvis).

Hybrid, alles lokal + nur lesend:
  - kontakt / termin / mail  → direkter, strukturierter Ordner-Zugriff (exakt)
  - wissen                   → semantische Brain-Suche (:7777) für Thematisches

Bewusst stdlib-only, damit es überall (n8n-Aufruf, Python-Bot) leicht läuft.
"""
from __future__ import annotations

import glob
import json
import os
import re
import urllib.request
from datetime import date, datetime, timedelta


def _token(env_name, default):
    return os.environ.get(env_name, default)


VAULTS = {
    "whitestag": {
        "path": os.path.expanduser("~/Obsidian/WHITESTAG-Vault"),
        "brain_url": "http://localhost:7777/",
        "brain_token": _token(
            "BRAIN_TOKEN",
            "5bc3675e4fc5e83977107dce675e2fde2038fda0b70b818f24aa99dbf90fe764"),
    },
    "clara": {
        # Lokaler Read-only-Mirror von /Volumes/homes/cw/Obsidian/Clara-Vault
        # (SMB). Der launchd-Daemon kann das SMB-Netzlaufwerk nicht lesen; die
        # Datei-Modi (kontakt/termin/mail/dokument) lesen deshalb die lokale
        # Kopie. `wissen` läuft weiter über den Clara-Brain (:7778, eigener
        # Index). Sync: sync-clara-mirror.sh (rsync NAS->lokal, nur .md).
        "path": os.path.expanduser("~/.paperclip/clara-vault-mirror"),
        "brain_url": "http://localhost:7778/",
        "brain_token": _token(
            "BRAIN_TOKEN_CLARA",
            "ad3cae15e8264696f5943ded6cf9edba2ff9de14a12a9b49a1f3ea5a0019d03e"),
    },
}
DEFAULT_VAULT = "whitestag"


def resolve_vault(vault):
    """Liefert die Vault-Config; unbekannter/None-Wert -> Default (WHITESTAG)."""
    return VAULTS.get(vault or DEFAULT_VAULT, VAULTS[DEFAULT_VAULT])

_WORD = re.compile(r"[A-Za-zÄÖÜäöüß0-9.@-]{2,}")


def _tokens(s: str) -> list[str]:
    return [t.lower() for t in _WORD.findall(s or "")]


# ---------------------------------------------------------------- Kontakte ---
def lookup_kontakt(query, cfg, limit=3):
    """Findet Kontaktkarten per Namens-/Domain-Match. Gibt vollen Kartentext
    zurück, damit das LLM die konkret gefragte Angabe (Tel/Mail/…) rauszieht."""
    base = cfg["path"]
    kontakte = os.path.join(base, "Kontakte")
    if not os.path.isdir(kontakte):
        return []
    qtoks = [t for t in _tokens(query) if t not in ("kontakt", "nummer", "telefon",
             "telefonnummer", "mail", "email", "adresse", "von", "der", "die", "das")]
    scored = []
    for path in glob.glob(os.path.join(kontakte, "*.md")):
        try:
            text = open(path, encoding="utf-8").read()
        except OSError:
            continue
        hay = (os.path.basename(path) + "\n" + text[:600]).lower()
        score = sum(1 for t in qtoks if t in hay)
        if score:
            scored.append((score, path, text))
    scored.sort(key=lambda x: -x[0])
    out = []
    for score, path, text in scored[:limit]:
        out.append({"quelle": os.path.relpath(path, base), "score": score,
                    "inhalt": text.strip()[:1500]})
    return out


# ----------------------------------------------------------------- Termine ---
def _parse_datumsfenster(query: str):
    q = (query or "").lower()
    today = date.today()
    if "heute" in q:
        return today, today
    if "morgen" in q:
        d = today + timedelta(days=1); return d, d
    if "woche" in q:
        start = today - timedelta(days=today.weekday())
        return start, start + timedelta(days=6)
    m = re.search(r"(\d{4}-\d{2}-\d{2})", q)
    if m:
        d = datetime.strptime(m.group(1), "%Y-%m-%d").date(); return d, d
    return today, today + timedelta(days=13)  # Default: nächste 2 Wochen


def lookup_termine(query, cfg, limit=15):
    base = cfg["path"]
    termine = os.path.join(base, "Termine")
    if not os.path.isdir(termine):
        return []
    start, end = _parse_datumsfenster(query)
    out = []
    for path in sorted(glob.glob(os.path.join(termine, "*.md"))):
        m = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(path))
        if not m:
            continue
        try:
            d = datetime.strptime(m.group(1), "%Y-%m-%d").date()
        except ValueError:
            continue
        if start <= d <= end:
            try:
                text = open(path, encoding="utf-8").read()
            except OSError:
                continue
            out.append({"datum": m.group(1), "quelle": os.path.relpath(path, base),
                        "inhalt": text.strip()[:600]})
    return out[:limit]


# ------------------------------------------------------------------- Mails ---
def lookup_mail(query, cfg, limit=5):
    base = cfg["path"]
    emails = os.path.join(base, "E-Mails")
    if not os.path.isdir(emails):
        return []
    qtoks = [t for t in _tokens(query) if t not in ("mail", "email", "von", "letzte", "der")]
    scored = []
    for path in glob.glob(os.path.join(emails, "*.md")):
        base_name = os.path.basename(path)
        try:
            head = open(path, encoding="utf-8").read(700)
        except OSError:
            continue
        hay = (base_name + "\n" + head).lower()
        score = sum(1 for t in qtoks if t in hay)
        if score:
            scored.append((score, base_name[:10], path, head))
    scored.sort(key=lambda x: (-x[0], x[1]), reverse=False)
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)  # score desc, dann Datum desc
    out = []
    for score, _d, path, head in scored[:limit]:
        out.append({"quelle": os.path.relpath(path, base), "score": score,
                    "auszug": head.strip()[:500]})
    return out


# ------------------------------------------------------------------ Wissen ---
def search_wissen(query, cfg, limit=5):
    """Semantische Brain-Suche für thematische/Wissensfragen."""
    body = json.dumps({"tool": "search_vault",
                       "args": {"query": query, "limit": limit}}).encode()
    req = urllib.request.Request(cfg["brain_url"], data=body, method="POST",
        headers={"Authorization": "Bearer " + cfg["brain_token"],
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        return [{"fehler": f"Brain nicht erreichbar: {e}"}]
    res = data.get("result", [])
    return [{"quelle": h.get("path"), "score": round(h.get("score", 0), 3),
             "auszug": (h.get("snippet") or h.get("text") or "")[:400]}
            for h in (res if isinstance(res, list) else [])]


# --------------------------------------------------------------- Dokumente ---
_RG = "/opt/homebrew/bin/rg"
_DOC_STOP = {"der","die","das","und","von","mit","fuer","für","ist","ein","eine",
    "dem","den","im","in","auf","zu","nach","bitte","mir","mal","suche","such",
    "dokument","dokumente","dokumenten","allen","alle","finde","was","wo","gibt",
    "es","du","ich","hast","haben","kannst","bitte"}


def lookup_dokument(query, cfg, limit=6):
    """Volltextsuche (ripgrep) ueber den GANZEN Vault — findet exakte Begriffe
    in jedem Dokument, unabhaengig vom Brain-Index."""
    import subprocess
    from collections import Counter
    base = cfg["path"]
    toks = [t for t in _tokens(query) if len(t) > 2 and t.lower() not in _DOC_STOP]
    if not toks:
        return []
    score = Counter()
    # Token-Cap bewusst niedrig (4): jede Runde ist ein rg-Vollscan; über den
    # Clara-SMB-Mount kostet ein Token ~6-7s. 4 Tokens × rg + Snippets bleibt
    # unter dem 60s-Client-Timeout (vault_client.lookup). Recall-Verlust nur bei
    # sehr langen Anfragen (>4 sinnvolle Begriffe), praktisch selten.
    for tok in toks[:4]:
        try:
            r = subprocess.run([_RG, "-li", "--no-messages", "-g", "*.md", tok, base],
                               capture_output=True, text=True, timeout=20)
        except Exception:
            continue
        for path in r.stdout.strip().splitlines():
            score[path] += 1
    ranked = []
    for path, s in score.items():
        base_name = os.path.basename(path).lower()
        bonus = sum(1 for t in toks if t.lower() in base_name)
        ranked.append((s + bonus, s, path))
    ranked.sort(reverse=True)
    out = []
    pat = "|".join(re.escape(t) for t in toks)
    for _rank, s, path in ranked[:limit]:
        snippet = ""
        try:
            r = subprocess.run([_RG, "-i", "--no-messages", "-m", "3", pat, path],
                               capture_output=True, text=True, timeout=10)
            snippet = r.stdout.strip()[:400]
        except Exception:
            pass
        out.append({"quelle": os.path.relpath(path, base),
                    "treffer_begriffe": s, "auszug": snippet})
    return out


# -------------------------------------------------------------- Dispatcher ---
def lookup(mode, query, vault=DEFAULT_VAULT):
    if vault and vault not in VAULTS:
        return {"mode": mode, "query": query, "treffer": [],
                "fehler": "unbekannter Vault: {}".format(vault),
                "vault_unknown": True}
    cfg = resolve_vault(vault)
    fn = {"kontakt": lookup_kontakt, "termin": lookup_termine,
          "mail": lookup_mail, "wissen": search_wissen,
          "dokument": lookup_dokument}.get(mode)
    if not fn:
        return {"mode": mode, "fehler": "unbekannter Modus (kontakt|termin|mail|wissen|dokument)"}
    return {"mode": mode, "query": query, "treffer": fn(query, cfg)}


if __name__ == "__main__":
    import sys
    m = sys.argv[1] if len(sys.argv) > 1 else "kontakt"
    v = os.environ.get("VAULT_SEL", DEFAULT_VAULT)
    q = " ".join(sys.argv[2:]) or "Jana Kostbar"
    print(json.dumps(lookup(m, q, v), ensure_ascii=False, indent=1))
