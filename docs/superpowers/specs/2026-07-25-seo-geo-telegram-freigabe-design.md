# Design: SEO/GEO-Freigaben per Telegram (Jarvis-Bot)

*Stand 2026-07-25. Spec für die Umsetzung.*

## Problem

Validierte SEO/GEO-Changesets landen heute still in `~/.paperclip/seo-geo/<site>/pending/`.
Niemand benachrichtigt Walter, dass eine Freigabe ansteht — die Pakete für
whitestag.film, virtuelle-lausitz.de und whitestag.de liegen deshalb seit Tagen
unbearbeitet. Walter bekommt schlicht nicht mit, dass er etwas freigeben soll.

**Ziel:** Wenn ein Changeset freigabereif ist, bekommt Walter zeitnah einen
Telegram-Push, kann es mit einem Tipp freigeben oder ablehnen, und der Live-Write
passiert deterministisch dahinter. Nichts darf mehr still liegenbleiben.

## Entscheidungen (mit Walter abgestimmt)

- **Kanal:** Telegram über den bestehenden **Jarvis-Bot** (`@whitestag_jarvis_bot`,
  `tools/voice-echo-bot/`), Walters Chat `8311805232`.
- **Rückkanal:** Inline-Buttons `[✅ Freigeben]` / `[❌ Ablehnen]` für den Standardfall,
  freie Textantwort für Sonderfälle.
- **Granularität:** ein Freigabe-Vorgang pro **Site-Paket**; die vollständige
  Änderungsliste (alt→neu) hängt als Dokument an der Push-Nachricht.
- **Auslöser:** Claude legt bewusst vor (`seo-geo notify --site <site>`), kein
  Auto-Trigger beim Eintreffen in `pending/`.
- **Kein CEO-Issue:** Statt den CEO-Issue-Poll zu missbrauchen, spiegeln wir das
  erprobte Luna-Vier-Augen-Muster mit einer **Token-Freigabedatei**.
- **Sicherheits-Fallback:** Re-Ping nach **24 h** offener Freigabe, über einen
  **eigenen täglichen launchd-Check** (nicht den Wochen-Audit, der 24 h nicht
  zuverlässig treffen würde).

## Architektur

Zwei bestehende Systeme, klar getrennt, dünn gekoppelt:

1. **seo-geo-Dienst** (`tools/seo-geo/`, Python 3.11-venv) — erzeugt die Freigabe,
   führt approve/apply deterministisch aus.
2. **Jarvis-Bot** (`tools/voice-echo-bot/`, stdlib) — Transport: Push mit Buttons,
   Callback-Empfang, Textantwort-Empfang.

Bindeglied ist die **Token-Queue** unter `~/.paperclip/state/seo-approvals/` und
der Bot-Aufruf des seo-geo-CLI.

### Datenfluss

```
Claude: resolve + validate + Lektorat sauber
  └─ seo-geo notify --site whitestag.film
       ├─ rendert Änderungsliste → <TOKEN>.txt
       ├─ schreibt Token: ~/.paperclip/state/seo-approvals/<TOKEN>.json
       │     { token, site, changeset_path, list_path, count, alt_count,
       │       status:"pending", created, chat_id }
       └─ Jarvis-Push an Chat 8311805232:
            „🟢 SEO-Freigabe film — 79 Änderungen (8 Alt-Texte)"
            + <TOKEN>.txt als Dokument-Anhang
            + Inline-Buttons  [✅ Freigeben]=seo:ok:<TOKEN>  [❌ Ablehnen]=seo:no:<TOKEN>

Walter tippt [✅ Freigeben]
  └─ Bot callback_query → seo_approvals.load(TOKEN) → deterministisch:
       venv/bin/python seo-geo approve <site> --root ~/.paperclip/seo-geo
       venv/bin/python seo-geo apply --site <site> --root ~/.paperclip/seo-geo
     → Token status:"applied" → Rückmeldung:
       „✅ film live — 79 angewendet, 0 Fehler"  (oder Fehlerdetail)
```

## Komponenten

### Neu: `seo_approvals.py` (im seo-geo-Dienst)

Token-Queue, spiegelt Lunas `approval_queue`:
- `create(site, changeset_path, list_path, count, alt_count, chat_id) -> token`
  — atomarer Write, Token = URL-sicherer Zufalls-String.
- `load(token)`, `set_status(token, status, note=None)`.
- `list_pending(older_than_hours=None)` — für den Re-Ping-Check.
- Zustände: `pending → applied | rejected` (+ `failed` bei apply-Fehler).
- TTL 7 Tage (abgelaufene pending gelten als erledigt, kein Re-Ping mehr).
- Token aus `os.urandom` (Prod), im Test injizierbar (deterministische Tests).

### Neu: `seo-geo notify` (CLI-Subcommand)

- Liest das jüngste resolved+validierte Changeset der Site aus `pending/`.
- Rendert die Änderungsliste (pro Seite: Feld, alt→neu) als `<TOKEN>.txt`.
- Ruft `seo_approvals.create(...)`.
- Ruft den Bot-Push (siehe unten). Kein LLM beteiligt.
- **Vor-Check:** verweigert, wenn das Changeset nicht durch `validate` ging
  (Live-Check-Marker fehlt) — verhindert Vorlegen halbfertiger Pakete.

### Geändert: Jarvis-Bot

- **`telegram_api.py`:** `send_document` (Anhang) + `reply_markup` mit Inline-Buttons
  ergänzen, falls nicht vorhanden (Button-Transport ist teils schon da).
- **`bot.py` `handle_update`:** den entfernten `callback_query`-Zweig **gezielt**
  wieder aufnehmen — nur für `callback_data` mit Präfix `seo:`. Andere Callbacks
  werden ignoriert (kein Rückfall auf das alte Bestätigungs-Button-Verhalten).
- **Callback-Handler:**
  - `seo:ok:<TOKEN>` → `seo_approvals.load`; wenn `pending`:
    approve+apply über das **seo-geo-venv** (Subprozess, nicht der Bot-Interpreter,
    der stdlib-only läuft). Ergebnis parsen → Token-Status setzen → Rückmeldung.
    Doppel-Tipp/abgelaufen → freundlicher Hinweis, kein zweiter Apply (Idempotenz
    über Token-Status).
  - `seo:no:<TOKEN>` → Status `rejected`, Changeset nach `rejected/`, Rückfrage
    „Grund? (Antwort optional)".
- **Textantwort-Sonderfall:** Reply auf eine SEO-Push-Nachricht (Token via Ident-
  Match in der zitierten Nachricht) → Wortlaut als `note` am Token ablegen,
  **kein** automatischer Apply. Claude zieht Teil-/Sonderfreigaben manuell nach.
- **Bot-Push-Funktion:** Der `seo-geo notify`-Aufruf erreicht den Bot nicht über den
  laufenden Long-Poll-Prozess. Stattdessen sendet `notify` direkt über die
  Bot-Token-API (dasselbe `TELEGRAM_BOT_TOKEN`) — der Push ist ein simpler
  `sendDocument` + `sendMessage`-mit-`reply_markup`. Der laufende Bot muss nur die
  **eingehenden** Callbacks/Replies bedienen. Damit kein Prozess-Coupling.

### Neu: täglicher Re-Ping-Check

- Kleiner launchd `ing.whitestag.seo-geo-reping`, täglich (z.B. 08:00).
- `seo_approvals.list_pending(older_than_hours=24)` → je offenem Token **ein**
  Re-Ping („⏳ film-Freigabe wartet seit N Tagen") + Marker `last_reping`, damit
  nicht täglich erneut gepingt wird (ein Re-Ping pro Token, dann Ruhe).

## Sicherheit / Determinismus

- Der **Live-Write hängt nie an einem LLM** — der Button-Callback ruft direkt das
  seo-geo-CLI. Wie bei Luna ist der Choke-Point Code, nicht ein Prompt.
- Nur Walters Chat (`8311805232`) darf Callbacks auslösen — Tenant-Check wie im
  bestehenden Bot (`resolve_tenant`). Fremde Callbacks werden verworfen.
- Idempotenz über Token-Status: ein Token wird höchstens einmal appliziert.
- Feld-Whitelist + validate bleiben die Sicherheitsgrenze des Apply (unverändert).

## Deploy-Gotchas (kritisch)

- **Zwei-Kopien-Falle:** Beide Dienste laufen aus `~/.paperclip/scripts/…`, nicht
  aus dem CloudStorage-Repo. Nach Codeänderung:
  - seo-geo: `rsync -a --exclude venv --exclude __pycache__ tools/seo-geo/ ~/.paperclip/scripts/seo-geo/`
  - bot: `cp tools/voice-echo-bot/*.py ~/.paperclip/scripts/voice-echo-bot/` +
    `launchctl kickstart -k gui/501/de.whitestag.voice-echo-bot`
- Immer `./venv/bin/python` für seo-geo (System-python3 = 3.9, bricht `str|None`).
- launchd/Hintergrund kann CloudStorage nicht lesen → Laufzeitcode in `~/.paperclip/`.
- **NICHT** manuell `getUpdates` gegen den Jarvis-Bot curlen (stiehlt Updates).

## Tests (TDD, kein Live-Telegram)

- `seo_approvals`: create/load/set_status/list_pending, TTL, atomarer Write,
  injizierter Token.
- `notify`: rendert Liste korrekt, verweigert unvalidierte Changesets.
- Bot-Callback: `callback_data`-Parsing (`seo:ok:` / `seo:no:` / fremd),
  approve+apply als gemockter Subprozess, Idempotenz bei Doppel-Tipp/abgelaufen,
  fremder Chat abgewiesen.
- Re-Ping: `list_pending(24h)`-Auswahl, ein Re-Ping pro Token.

## Bewusst weggelassen (YAGNI)

- Maschinelle Teil-/Sonderfreigaben aus Freitext — bleibt manuell.
- Auto-Trigger beim Eintreffen in `pending/` — Walter will kuratiertes Vorlegen.
- Freigabe-Historie/Dashboard-UI — Token-Dateien reichen als Audit-Trail.

## Offene Punkte für die Umsetzung

- Genaue Uhrzeit des Re-Ping-launchd (Vorschlag 08:00) beim Bau bestätigen.
- Prüfen, ob `telegram_api.py` `send_document` bereits kann oder ergänzt werden muss.
