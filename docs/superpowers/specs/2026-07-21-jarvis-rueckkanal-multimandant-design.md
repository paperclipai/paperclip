# Jarvis Rückkanal + Mehrmandanten — Design

**Datum:** 2026-07-21
**Status:** Design abgestimmt (Walter freigegeben), wartet auf Review vor Plan
**Baut auf:** [2026-07-21-voice-echo-ceo-design.md](2026-07-21-voice-echo-ceo-design.md) (Einbahn-Bot, live)
**Ziel:** Den bestehenden Jarvis-Bot zu einem bidirektionalen, mehrmandantenfähigen Kanal erweitern: Nachrichten werden je Absender-Telegram-ID an die richtige Company/CEO geroutet; der CEO meldet „Fertig" und „Entscheidung benötigt" in den Chat des jeweiligen Nutzers zurück; der Nutzer kann per Sprache/Text antworten, was als Kommentar ans Issue geht.

## Abgestimmte Entscheidungen

| Thema | Entscheidung |
|---|---|
| Mandanten | **Routing je Telegram-User-ID** — Tabelle ID → {Company, CEO} |
| Bot | **Ein** Bot (`@whitestag_jarvis_bot`) für alle Mandanten; `@ClaraAiBot` bleibt unangetastet (n8n) |
| Prozess | **Ein** erweiterter `bot.py` (Long-Poll + periodischer CEO-Poll + Reply-Handling) — kein zweiter Dienst |
| Rückmeldungen | Nur **Fertig/Deliverable** und **Entscheidung benötigt** (nicht jeder Kommentar/Status) |
| Umfang | **Alle** CEO-Issues des Mandanten (nicht nur per Jarvis erstellte) |
| Antwort | Nutzer antwortet per **Telegram-Reply** (Sprache/Text) → Bot postet Kommentar ans Issue |
| Reply-Zuordnung | **Zustandslos**: Issue-`identifier` (z. B. „WHI-2857") steht in der Push-Nachricht, Reply zitiert sie |
| Isolation | Absender-ID nicht in der Tabelle → ignoriert; jede Zeile bindet genau **eine** Company+CEO |

## Mandanten-Tabelle (aufgelöste IDs)

Geschützte JSON `~/.paperclip/voice-echo-tenants.json` (nicht im Git, Rechte 600), keyed by Telegram-User-ID (String):

```json
{
  "8311805232": {
    "name": "Walter / WHITESTAG",
    "company_id": "9cebf3cf-efe8-4597-a400-f06488900a87",
    "ceo_agent_id": "506c873e-3a40-4483-9a45-0eb0fa1554bb"
  },
  "<CLARA_TELEGRAM_ID>": {
    "name": "Clara / Clara Sound",
    "company_id": "0e426844-309c-4528-9aa5-90ff76790a51",
    "ceo_agent_id": "64ad7d03-ce64-46aa-ae79-d17ff26f5d4f"
  }
}
```

Das eine Board-Token aus `~/.paperclip/auth.json` erreicht beide Companies (verifiziert: HTTP 200 auf Claras Agenten) → alle Mandanten nutzen dasselbe Token.

## Architektur

```
bot.py — ein Prozess, Long-Poll (timeout ~25 s)
 │
 ├─ (A) Eingehende Nachricht
 │     ├─ Absender-ID → Mandanten-Tabelle (nicht gelistet → still ignorieren)
 │     ├─ ist es ein REPLY auf eine CEO-Meldung?  → (B)
 │     └─ sonst: Voice→Whisper / Text → Bestätigungs-Flow → Issue in tenant.company beim tenant.ceo
 │
 ├─ (B) Reply→Kommentar
 │     ├─ identifier („WHI-…") aus reply_to_message.text lesen
 │     ├─ Issue in tenant.company auflösen (identifier → issue-id)
 │     ├─ Voice→Whisper / Text  → POST /issues/<id>/comments {body, resume:true}
 │     └─ Bestätigung „✅ Antwort an CEO (WHI-…) gesendet"
 │
 └─ (C) CEO-Event-Poll (jede Schleife, wenn Intervall ≥ ~60 s vergangen)
       für jeden Mandanten:
       ├─ „Fertig/Deliverable": Top-Level-Issue der Company neu auf `done`
       ├─ „Entscheidung benötigt": Issue neu im wartenden Zustand (Signal s.u.)
       └─ je NEUES Event: 1 Telegram-Push in tenant.chat (= user-id), Dedup über State-Datei
```

## Erkennungssignale

### Fertig/Deliverable
- Top-Level-Issue (`parentId == null`) der Company, das **neu** auf `status == "done"` gewechselt ist (Muster wie `walter-deliverable-watcher.py`).
- Push-Text: `✅ Erledigt — <identifier>: <title>`.
- Dedup: `(issue_id, "done")` in State-Datei.

### Entscheidung benötigt
- **Kandidatensignal (im Plan final verifiziert):** Issue der Company, das **neu** in `status == "blocked"` mit einer Blocker-Attention/Approval geht, die auf eine menschliche Entscheidung wartet. Der Plan enthält eine Recherche-/Verifikations-Task, die das exakte Prädikat gegen Live-Daten festzurrt (Kandidaten: `heartbeat-context`/`blockerAttention`, `GET /issues/:id/approvals` mit pending-Status). Falls kein eindeutiges maschinelles Signal existiert, Fallback: Issues, deren neuester Kommentar vom CEO eine Entscheidungsanfrage an den Nutzer ist (Heuristik im Plan definiert).
- Push-Text: `🟠 Entscheidung benötigt — <identifier>: <title>\n<frage/summary>\n\n↩️ Antworte auf diese Nachricht (Sprache/Text).`
- Dedup: `(issue_id, "decision")`.

Der `identifier` (= „WHI-2857") steht im Issue-Payload und wird in JEDE Push-Nachricht geschrieben — er ist der Anker für den Reply-Rückweg.

## Reply → Kommentar (zustandslos)
1. Eingehende Nachricht hat `reply_to_message`.
2. Aus `reply_to_message.text` per Regex `([A-Z]{2,5}-\d+)` den `identifier` extrahieren.
3. In der Company des Absenders das Issue mit diesem `identifier` finden (Liste/Suche → issue-id).
4. Text ermitteln (Voice → Whisper, sonst Nachrichtentext).
5. `POST /api/issues/<id>/comments` mit `{"body": <text>, "resume": true}` (resume weckt den CEO, die Antwort zu verarbeiten).
6. Bestätigung an den Nutzer. Findet sich kein identifier/Issue → freundlicher Hinweis, nichts posten.

## Komponenten / Dateien (im Repo `tools/voice-echo-bot/`)
- **NEU `tenants.py`** — lädt/rät die Mandanten-Tabelle; `resolve_tenant(user_id) -> dict|None`. + Test.
- **`paperclip_client.py` (erweitern)** — `add_comment(token, issue_id, body, resume=True)`, `find_issue_by_identifier(token, company_id, identifier) -> dict|None`, `list_done_toplevel(token, company_id) -> list`, `list_decision_needed(token, company_id) -> list` (Prädikat aus Plan). + Tests.
- **NEU `notifier.py`** — `poll_company(token, tenant, state) -> list[push]`; reine Logik (Issues rein, Events raus), Dedup gegen `state`. + Test.
- **NEU `state.py`** — Laden/Speichern der Dedup-State-Datei `~/.paperclip/voice-echo-state.json` (Set aus `"<issue_id>:<event>"`). + Test.
- **`bot.py` (erweitern)** — Allowlist → `resolve_tenant`; Reply-Zweig; periodischer `notifier`-Poll in der Loop; Pushes senden; alle Aktionen mandanten-parametrisiert. + Tests.
- **`config.py` (erweitern)** — Pfade `TENANTS_PATH`, `STATE_PATH`; Poll-Intervall-Konstante.
- **`.env`** — `TELEGRAM_ALLOWED_USER_ID` entfällt (durch tenants.json ersetzt); Bot-Token + Whisper-Modell bleiben.

## State / Dedup
- Datei `~/.paperclip/voice-echo-state.json`: `{"seen": ["<issue_id>:done", "<issue_id>:decision", …]}`.
- **Erststart-Verhalten:** Beim allerersten Poll werden alle aktuell passenden Issues als „seen" markiert **ohne** Push (kein Nachholen von 206 Alt-`done`-Issues). Danach nur echte Neuzugänge.
- In-Memory-Cache + Schreiben nach jedem Poll-Zyklus.

## Isolation & Sicherheit
- Nur Telegram-IDs in `tenants.json` werden bedient; alles andere still verworfen (Log).
- Reply/Issue-Auflösung ist **auf die Company des Absenders beschränkt** — ein Nutzer kann nie ein Issue einer fremden Company kommentieren, selbst wenn er einen fremden identifier zitiert (Suche läuft nur in tenant.company; kein Treffer → Hinweis).
- Rückkanal-Pushes gehen ausschließlich an `chat_id == user_id` des jeweiligen Mandanten.

## Fehlerbehandlung
- Poll-/Netzfehler je Mandant isoliert (ein Mandant down ≠ Loop-Abbruch); Backoff, Loop lebt weiter.
- Kommentar-POST 4xx/5xx → Nutzer-Hinweis, Reply-Text im Fehlerfall nicht verloren.
- Fremder/unbekannter identifier im Reply → „Konnte kein passendes Issue finden."
- State-Datei korrupt → wie Erststart neu initialisieren (kein Alt-Spam, da als seen markiert).

## Testing
- Unit (stdlib `unittest`, Telegram/Paperclip gemockt): tenant-resolve inkl. Isolation; notifier-Dedup + Erststart-Suppression; done- und decision-Erkennung; reply→identifier→comment inkl. „fremde Company"-Fall; bestehende Einbahn-Tests bleiben grün.
- Live-Verifikation im Plan: exaktes „Entscheidung benötigt"-Prädikat gegen echte blocked-Issues; reale Reply→Kommentar-Runde an einem Test-Issue.
- E2E: (a) Sprachnachricht → Issue beim CEO (schließt auch den offenen Sende-E2E aus Feature 1); (b) CEO-Issue auf `done` → Push kommt an; (c) Reply → Kommentar erscheint am Issue.

## Setup-Voraussetzungen / offene Punkte für den Plan
- **Claras Telegram-User-ID** (via `@userinfobot`) + Clara drückt einmal `/start` bei `@whitestag_jarvis_bot` (sonst 403).
- Exaktes **„Entscheidung benötigt"-Prädikat** in der Plan-Recherche festzurren.
- `identifier`-Feldname am Issue-Payload verifizieren (Deliverable-Watcher nutzt `identifier`).

## Bewusst NICHT im Scope (YAGNI)
- Keine Approve/Reject-Inline-Buttons (Antwort läuft über Reply-Kommentar).
- Kein Push für jeden Kommentar/Statuswechsel (nur die zwei Ereignisse).
- Keine Weboberfläche/Cloudflare.
- Keine Auto-Anlage neuer Mandanten (Tabelle wird manuell gepflegt).
