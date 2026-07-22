---
title: Mandantenfähiger Vault-Lookup für Jarvis (WHITESTAG + Clara)
datum: 2026-07-22
typ: Design-Spec
status: Freigegeben
zusammenfassung: >
  Der Jarvis-Vault-Lookup ist fest auf den WHITESTAG-Vault verdrahtet. Dieser
  Umbau macht ihn mandantenfähig, sodass Claras Büroleiter Claras Vault
  durchsucht statt WHITESTAGs — und schließt damit ein Cross-Tenant-Datenleck.
---

# Mandantenfähiger Vault-Lookup für Jarvis

## Problem

Der Telegram-Bot „Jarvis" (`tools/voice-echo-bot/`) bedient zwei Mandanten:
Walter/WHITESTAG (Telegram `8311805232`) und Clara/Clara Sound (`1220010628`).
Der Bot kennt pro Nachricht bereits den `tenant` (mit `company_id`,
`ceo_agent_id`), **verwirft diese Info aber beim Vault-Lookup**.

Der Vault-Lookup (`tools/vault-lookup/vault_lookup.py`) ist hart auf einen
einzigen Vault verdrahtet:

```python
VAULT = os.path.expanduser("~/Obsidian/WHITESTAG-Vault")   # Zeile 18
BRAIN_URL = "http://localhost:7777/"                        # Zeile 23
BRAIN_TOKEN = "5bc3675e…"                                   # Zeile 25
```

**Folge:** Wenn Clara Jarvis nach Kontakten, Terminen, Mails, Wissen oder
Dokumenten fragt, durchsucht Jarvis den **WHITESTAG-Vault** — also fremde
Daten. Das ist nicht nur eine fehlende Funktion, sondern ein
**Cross-Tenant-Datenleck**.

## Ausgangslage (verifiziert 2026-07-22)

| | WHITESTAG | Clara |
|---|---|---|
| Vault-Pfad | `~/Obsidian/WHITESTAG-Vault` | `/Volumes/homes/cw/Obsidian/Clara-Vault` (SMB, gemountet) |
| Unterordner Kontakte/Termine/E-Mails | vorhanden | identisch vorhanden |
| Brain (semantisch, Modus `wissen`) | `:7777` | `:7778` (läuft) |
| Brain-Scope-Token (`BRAIN_CLAUDE_CODE_TOKEN`) | `5bc3675e…` | `ad3cae15e8264696f5943ded6cf9edba2ff9de14a12a9b49a1f3ea5a0019d03e` |

- Der Clara-SMB-Share ist über `//ws-cloud@WHITESTAG-NAS…/homes` auf
  `/Volumes/homes` gemountet; `/Volumes/homes/cw/Obsidian/Clara-Vault` ist
  lesbar.
- Der `:7788`-Dienst läuft als **User-LaunchAgent** `de.whitestag.vault-lookup`
  (PID zur Analysezeit 3965). Als User-Agent in der GUI-Session sieht er den
  SMB-Mount — im Gegensatz zu einem LaunchDaemon.
- Deployte Kopien (das tatsächlich Laufende, weil launchd SynologyDrive nicht
  lesen kann):
  - `~/.paperclip/scripts/vault-lookup/{server.py,vault_lookup.py}`
  - `~/.paperclip/scripts/voice-echo-bot/…`
  - Tenants: `~/.paperclip/voice-echo-tenants.json`

## Design

**Kernidee:** Eine `VAULTS`-Registry ersetzt die hartkodierten Konstanten. Ein
`vault`-Selektor (`"whitestag"` | `"clara"`) reist durch die gesamte Kette
Bot → HTTP-Client → Server → Lookup-Logik. Fehlt er, gilt der Default
`"whitestag"` — dadurch bleibt Luna/n8n (die den `:7788`-Dienst ebenfalls
nutzt und ausschließlich WHITESTAG bedient) **unverändert lauffähig**.

### 1. `vault_lookup.py` — Registry + Durchreichen

Die Modul-Konstanten `VAULT`/`KONTAKTE`/`TERMINE`/`EMAILS`/`BRAIN_URL`/
`BRAIN_TOKEN` werden durch eine Registry ersetzt:

```python
def _tok(env, default):
    return os.environ.get(env, default)

VAULTS = {
    "whitestag": {
        "path": os.path.expanduser("~/Obsidian/WHITESTAG-Vault"),
        "brain_url": "http://localhost:7777/",
        "brain_token": _tok("BRAIN_TOKEN", "5bc3675e…"),
    },
    "clara": {
        "path": "/Volumes/homes/cw/Obsidian/Clara-Vault",
        "brain_url": "http://localhost:7778/",
        "brain_token": _tok("BRAIN_TOKEN_CLARA",
                            "ad3cae15e8264696f5943ded6cf9edba2ff9de14a12a9b49a1f3ea5a0019d03e"),
    },
}
DEFAULT_VAULT = "whitestag"

def resolve_vault(vault):
    return VAULTS.get(vault or DEFAULT_VAULT, VAULTS[DEFAULT_VAULT])
```

Jede `lookup_*`-Funktion bekommt die aufgelöste Vault-Config `cfg` als Argument
und leitet daraus ab:
- `kontakt`/`termin`/`mail`/`dokument`: Basispfad `cfg["path"]`, davon
  `Kontakte`/`Termine`/`E-Mails` bzw. rg-Volltext über `cfg["path"]`.
- `wissen`: `cfg["brain_url"]` + `cfg["brain_token"]`.

Relative Quellenangaben (`os.path.relpath(path, VAULT)`) nutzen künftig
`cfg["path"]` als Basis.

Der Dispatcher wird `lookup(mode, query, vault=DEFAULT_VAULT)`: löst `cfg` per
`resolve_vault(vault)` auf und reicht `cfg` in die Funktion.

Die Token-Defaults bleiben **inline, per Environment überschreibbar** — konsistent
mit dem heutigen `BRAIN_TOKEN`-Muster (bewusste Entscheidung, keine Auslagerung
in diesem Umbau).

### 2. `server.py` (:7788)

Liest zusätzlich `body.get("vault")` und reicht es durch:

```python
out = vault_lookup.lookup(body.get("mode", "kontakt"),
                          body.get("query", ""),
                          body.get("vault"))
```

Fehlt `vault` → `None` → Default. Rückwärtskompatibel für n8n/Luna.

### 3. `vault_client.py`

```python
def lookup(mode, query, vault=None, url=VAULT_LOOKUP_URL, timeout=30):
    payload = {"mode": mode, "query": query}
    if vault:
        payload["vault"] = vault
    ...
```

`vault` wandert nur in den Body, wenn gesetzt. Nebenbei: `"dokument"` wird zu
`VALID_MODES` ergänzt (fehlt derzeit, obwohl `vault_lookup` den Modus kann).

### 4. `bot.py`

`_do_lookup` übergibt den Tenant-Vault:

```python
result = vault_client.lookup(mode, query, vault=tenant.get("vault"))
```

### 5. `voice-echo-tenants.json`

Pro Tenant ein `"vault"`-Feld:
- `8311805232` (Walter/WHITESTAG) → `"vault": "whitestag"`
- `1220010628` (Clara/Clara Sound) → `"vault": "clara"`

## Verhalten & Fehlerfälle

- **SMB-Mount weg:** Bestehendes `os.path.isdir`-Muster greift → leere Treffer
  statt Absturz; der Bot lässt das LLM ehrlich „keine Daten" sagen. Der
  `dokument`-rg findet dann nichts (fail-safe).
- **Unbekannter/fehlender `vault`:** Default `whitestag` (kein Fehler).
- **Clara-Brain (`wissen`) nicht erreichbar:** Bestehende Fehlerbehandlung in
  `search_wissen` gibt `{"fehler": "Brain nicht erreichbar…"}` zurück.

## Sicherheit

Der Umbau schließt das oben beschriebene Cross-Tenant-Datenleck. Der Default
bleibt bewusst `whitestag`, sodass ausschließlich Jarvis (mit gesetztem
Tenant-Vault) mandantenfähig wird und n8n/Luna unberührt bleibt.

## Tests (TDD)

Vor der Implementierung, gegen `vault_lookup.py`:

1. `resolve_vault("clara")` liefert die Clara-Config; `resolve_vault(None)` und
   `resolve_vault("unbekannt")` liefern die WHITESTAG-(Default-)Config.
2. `lookup("kontakt", …, vault="clara")` liest aus dem Clara-Pfad, nicht aus
   dem WHITESTAG-Pfad (Temp-Vaults + Registry-Injektion/Monkeypatch;
   Isolationsnachweis, dass die Pfade nicht vermischt werden).
3. Rückwärtskompatibilität: `lookup("kontakt", …)` ohne `vault`-Argument geht
   gegen den WHITESTAG-Default.

## Deployment

1. Quelle → deployte Kopien spiegeln:
   `tools/vault-lookup/{server.py,vault_lookup.py}` →
   `~/.paperclip/scripts/vault-lookup/`; `tools/voice-echo-bot/*` →
   `~/.paperclip/scripts/voice-echo-bot/`.
2. `~/.paperclip/voice-echo-tenants.json` um die `vault`-Felder ergänzen.
3. LaunchAgents neu starten: `de.whitestag.vault-lookup` und
   `de.whitestag.voice-echo-bot` (via `launchctl kickstart -k`).
4. **Verifikation:** Live-Lookup gegen `:7788` — je ein `POST /lookup` mit
   `vault:"clara"` (muss Clara-Quellen liefern) vs. ohne `vault` (muss
   WHITESTAG-Quellen liefern). Optional ein echter Clara-Telegram-Chat gegen
   Jarvis.

## Nicht im Scope

- Auslagerung der Brain-Tokens in eine separate Config-Datei (bleibt inline,
  env-überschreibbar).
- Mandantenfähigkeit für Luna/n8n (bewusst Default `whitestag`).
- Anpassungen am Clara-Brain-Index selbst.
