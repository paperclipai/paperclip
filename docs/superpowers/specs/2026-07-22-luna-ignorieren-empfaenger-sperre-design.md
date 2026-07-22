# Design: „Ignorieren" → dauerhafte Empfänger-Sperre für Luna

**Datum:** 2026-07-22
**Kontext:** Erweiterung des Vier-Augen-Mail-Freigabesystems der Sekretärin (Luna).
Siehe `2026-07-22-vier-augen-mail-freigabe*.md` und Memory `project_sekretaerin_vier_augen`.

## Problem

Heute kennt Walters Antwort auf eine `[Freigabe #TOKEN]`-Mail nur zwei Ausgänge:
`okay` → Versand, alles andere → Korrektur-Issue (Luna überarbeitet). Es fehlt ein
Weg, einen Vorgang **abzubrechen und den Empfänger dauerhaft stummzuschalten** —
etwa bei Spam-nahen Kontakten oder Absendern, mit denen keine Korrespondenz
gewünscht ist.

## Ziel

Antwortet Walter auf eine Freigabe-Mail mit exakt `Ignorieren`:

1. Der aktuelle Entwurf (Token) wird verworfen — **kein Versand, kein Korrektur-Issue**.
2. Die Empfänger-Adresse landet auf einer **Blockliste**.
3. Künftige Mails dieses Absenders werden **deterministisch aus der Triage
   gefiltert** — Luna erstellt gar keine Entwürfe mehr für diesen Kontakt.
4. Das Sperren geschieht **stillschweigend** (keine Bestätigungsmail).
5. Eine Sperre lässt sich **per Mail-Kommando** an office@ wieder aufheben.

## Architektur-Entscheidung

Die Sperre greift **deterministisch im Code (`scan()`), nicht über Lunas Prompt**.
Geblockte Absender werden wie heute die Agenten-Mails (`_is_agent_mail`) schon beim
Scannen herausgefiltert und tauchen nie in einem Triage-Issue auf. Das ist konsistent
mit der Kern-Philosophie des Vier-Augen-Systems: der Choke-Point ist Code, nicht das
Verhalten des lokalen Modells. Eine Prompt-basierte Blockliste wäre schwächer (hängt
an LLM-Gehorsam) und wird verworfen.

## Komponenten

### 1. Blocklist-Store — neues Modul `blocklist.py`

Persistenz: `~/.paperclip/state/luna-blocklist.json`
Format: `{"blocked": ["kunde@example.com", ...], "updated": "<iso>"}`

API:
- `load() -> set[str]` — normalisierte Adressen; **fail-open**: unlesbare/fehlende
  Datei → leere Menge (im Zweifel triagieren, Walter gibt ohnehin frei).
- `is_blocked(addr: str) -> bool` — Prüfung gegen normalisierte Menge.
- `add(addr: str) -> None` — idempotent, atomarer `tmp`→`replace`-Write (wie `save_state`).
- `remove(addr: str) -> None` — idempotent (Adresse nicht vorhanden = No-op).
- `_normalize(addr) -> str` — `strip().lower()`.

Match-Granularität: **exakte E-Mail-Adresse** (keine Domain-Wildcards).

### 2. Klassifikation — `approval_parse.classify()`

Rückgabe erweitert auf `send | ignore | correction`. Reihenfolge:
1. oberster isolierter Block `== "okay"` → `send`
2. oberster isolierter Block `== "ignorieren"` → `ignore`
3. sonst → `correction`

Gleiche Strenge wie bei `okay`: nur der **gesamte** oberste Antwortblock (Zeilen ohne
Leerzeilen zusammengezogen), durch `normalize` (lowercase, `.`/`!` getrimmt). Gemischtes
wie „okay ignorieren" oder „ignorieren bitte" → `correction` (nie eine der Sonderaktionen).

### 3. Neuer Zweig in `watcher._apply_reply()`

Bei `classify == "ignore"`:
- `dry_run` → action `would-ignore`.
- sonst: `blocklist.add(entry["to"])` + `approval_queue.mark(token, "ignored")`.
- **Kein** `send`, **kein** `make_issue`, **keine** Bestätigungsmail.
- Rückgabe-action `ignored` — **terminal** (wird von office@- und Vault-Pfad als
  erledigt/gesehen markiert; die terminal-Menge in `main()` um `ignored` erweitern).

### 4. Scan-Filter — `watcher.scan()`

Neuer Helper `_is_blocked_sender(path: Path) -> bool`: liest die `von:`/`from:`-Zeile
aus dem Frontmatter (analog `_is_agent_mail`), extrahiert die Adresse und prüft
`blocklist.is_blocked(...)`. In `scan()` werden solche Dateien wie Agenten-Mails
übersprungen. Die Blocklist wird einmal pro `scan()`-Aufruf geladen (nicht pro Datei).

### 5. Entsperren per Mail-Kommando

Walter schickt eine Mail an office@ mit Betreff **oder** erster Body-Zeile
`Entsperren <adresse>`.

- `office_inbox.fetch_unblock_commands(processed) -> list[{uid, addr}]`:
  Filter = Walter-Absender + Präfix `Entsperren ` (case-insensitiv), extrahiert die
  Adresse per Regex. Eigener UID-State `~/.paperclip/state/office-unblock-uids.json`
  (getrennt von den Freigabe-UIDs, damit sich beide Schienen nicht stören).
- `watcher.process_unblock_commands(*, dry_run)`: ruft `blocklist.remove(addr)`, merkt
  die UID (außer dry_run), gibt `[{uid, addr, action}]` zurück. Aufruf in `main()`
  direkt nach `process_office_approvals`. Auch **stillschweigend**.

## Datenfluss

**Sperren:** Walter antwortet „Ignorieren" auf `[Freigabe #TOKEN]` → office@-INBOX →
`office_inbox.fetch_approval_replies` liefert Body → `_apply_reply` → `classify=ignore`
→ `blocklist.add(entry["to"])` + Queue `ignored`. Ab dem nächsten Tick filtert `scan()`
diesen Absender raus → keine weiteren Entwürfe.

**Entsperren:** Walter mailt office@ Betreff „Entsperren kunde@example.com" →
`fetch_unblock_commands` → `process_unblock_commands` → `blocklist.remove` → ab nächstem
Tick wird der Absender wieder normal triagiert.

## Fehlerbehandlung

- Blocklist unlesbar → `load()` liefert leere Menge (fail-open): der Triage-Filter
  lässt im Zweifel durch, statt Kundenpost zu verschlucken.
- `add`/`remove` schreiben atomar (`tmp`→`replace`); Verzeichnis wird bei Bedarf angelegt.
- Ein kaputter Entsperr-Eintrag darf den Tick nicht killen (try/except pro Eintrag,
  Muster wie `process_office_approvals`).

## Testplan (TDD)

- **`test_blocklist.py`** (neu): add/remove/is_blocked round-trip, Normalisierung
  (Groß/Klein, Whitespace), Idempotenz, fail-open bei fehlender/kaputter Datei.
- **`test_approval_parse.py`** (erweitern): `ignorieren` → `ignore`; `Ignorieren.` →
  `ignore`; `okay ignorieren` → `correction`; `ignorieren bitte` → `correction`;
  bestehende `okay`/correction-Fälle bleiben grün.
- **`test_watcher_approvals.py`** (erweitern): `_apply_reply` ignore-Zweig setzt
  Blocklist + Queue `ignored`, ruft **weder** `send` **noch** `make_issue`;
  `would-ignore` bei dry_run; `scan()` überspringt eine Mail von geblocktem Absender.
- **`test_office_inbox.py`** (erweitern): `fetch_unblock_commands` parst Adresse aus
  Betreff und aus erster Body-Zeile, ignoriert Nicht-Walter-Absender, extrahiert
  saubere Adresse.

## Deployment

Wie bestehend: Entwicklung in `tools/sekretaerin-mail-watcher/` (Repo), Deploy nach
`~/.paperclip/scripts/sekretaerin-mail-watcher/`. `blocklist.py` gehört in beide.
Keine n8n-/Relay-Änderung nötig (die Sperre wirkt vollständig im Python-Watcher).

## Bewusst nicht im Scope (YAGNI)

- Domain-Wildcards / Muster-Sperren — exakte Adresse reicht.
- Bestätigungsmail beim Sperren (Walter: stillschweigend).
- Auflisten der Blockliste per Mail — bei Bedarf JSON direkt lesen.
