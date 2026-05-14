# C-Suite Deliverable-Mail an Walter — Design

**Datum:** 2026-05-14
**Kontext:** Walter bekommt aktuell keine Mail, wenn ein C-Suite-Agent ein Walter-Issue mit Dokument abschließt (z.B. WHI-417, Konkurrenz-Analyse Lausitz, vom CRO). Die "Inline-Mail bei Abschluss"-Regel existiert nur für die Sekretärin (`send-walter-report.sh`) und wurde nie auf die übrigen Agenten ausgerollt.

## Ziel

Jeder der 7 mail-berechtigten WHITESTAG.AI-C-Suite-Agenten schickt Walter eine standardisierte Abschluss-Mail, sobald er ein Issue auf `done` setzt, das (a) während der Bearbeitung mindestens ein Markdown-Dokument im Vault erzeugt/geändert hat und (b) im Root-Parent von Walter erstellt wurde.

## Scope

**In-Scope:**
- WHITESTAG.AI Company (`9cebf3cf-efe8-4597-a400-f06488900a87`)
- 7 mail-berechtigte C-Suite-Agenten:
  - CEO (`506c873e-3a40-4483-9a45-0eb0fa1554bb`) — `ceo@whitestag.ai`
  - CMO (`bbf38291-1129-43db-97de-c03c998b691e`) — `cmo@whitestag.ai`
  - CTO (`5b7cb8a7-945f-4861-b3a7-4ae84d242d1e`) — `cto@whitestag.ai`
  - CPO (`d4bdef1a-84fb-4393-8491-0eeaebcb3270`) — `cpo@whitestag.ai`
  - CRO (`aa036cf5-0af7-4ed1-b04e-c7a54f71e553`) — `cro@whitestag.ai`
  - Creative Director (`4920b0be-b197-45ae-a169-54b99082c4ea`) — `creative@whitestag.ai`
  - DPO (`790bcaf2-83d8-4e04-8c43-914a96db7bd8`) — `dpo@whitestag.ai`

**Out-of-Scope:**
- Sekretärin (`e24b8d9d-…`) — behält ihr eigenes `send-walter-report.sh` (Phase-1-Approval-Gate, kein Anhang)
- WHITESTAG.FILM Company (`0e426844-…`) — späterer Roll-out, nicht Teil dieser Spec
- Server-seitige Hooks oder DB-Trigger — Implementierung erfolgt rein agent-seitig via AGENTS.md-Anweisung
- Mail bei Issues ohne Dokument (z.B. reine Status-Issues) — bewusst keine Notification
- Mail bei Subtasks, deren Parent-Baum-Root nicht von Walter ist (z.B. CEO → CRO interne Delegation ohne Walter-Bezug)

## Architektur

```
┌─────────────────────┐
│  C-Suite-Agent      │
│  (Heartbeat)        │
└──────────┬──────────┘
           │ Issue done? + Vault-Doc? + Walter-Root?
           ▼
┌─────────────────────────────────────────────┐
│  send-walter-deliverable.sh                 │
│  companies/9cebf3cf-.../bin/                │
│                                             │
│  - Validiert --from gegen Whitelist         │
│  - Baut Subject + Inline-Body               │
│  - Hängt .md als Attachment an              │
└──────────┬──────────────────────────────────┘
           │ POST + X-Mailhub-Secret
           ▼
┌─────────────────────────────────────────────┐
│  Mailhub V1.4 (n8n localhost:5678)          │
│  /webhook/mailhub/send                      │
└──────────┬──────────────────────────────────┘
           │ SMTP V7 (Hetzner)
           ▼
┌─────────────────────┐
│  ws@whitestag.ai    │
└─────────────────────┘
```

## Komponenten

### 1. Zentrales Helper-Skript

**Pfad:** `~/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/bin/send-walter-deliverable.sh`

**Rechte:** `chmod 750`

**Schnittstelle:**

```bash
send-walter-deliverable.sh \
  --from cro@whitestag.ai \
  --agent "CRO" \
  --issue WHI-417 \
  --issue-title "Konkurrenz-Analyse: KI-Unternehmen in der Lausitz" \
  --doc /Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault/Paperclip/Projekte/WHITESTAG.AI/.../konkurrenz-analyse.md \
  --summary "Drei Wettbewerber in der Lausitz identifiziert (Cottbus, Bautzen, Hoyerswerda). Empfehlung: keine direkte Konkurrenz zu WHITESTAG.AI — Differenzierung über Branchenfokus." \
  [--doc <weiteres-dokument.md> ...]
```

**Argument-Validierung:**
- `--from` MUSS aus Whitelist sein (die 7 Adressen oben). Sonst exit 1.
- `--issue` MUSS Form `WHI-\d+` haben. Sonst exit 1.
- `--doc` MUSS existieren und unter `/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault/` liegen. Sonst exit 1.
- `--summary` MUSS gesetzt sein, max. 500 Zeichen. Sonst exit 1.
- Mehrfaches `--doc` ist erlaubt; das erste gilt als Haupt-Deliverable für Subject.

**Hartkodiert (in der Skript-Datei, nicht via Args konfigurierbar):**
- `TO="ws@whitestag.ai"`
- `WEBHOOK_URL="http://127.0.0.1:5678/webhook/mailhub/send"`
- `MAILHUB_SECRET` (eingebettet, analog Sekretärin-Skript)

**Subject-Format:**
`[<ISSUE-ID>] <Issue-Titel> — Deliverable von <Agent-Name>`

Beispiel: `[WHI-417] Konkurrenz-Analyse: KI-Unternehmen in der Lausitz — Deliverable von CRO`

**Body-Format (Markdown, inline im `text`-Feld):**

```markdown
# <Issue-Titel>

**Issue:** [<ISSUE-ID>](https://company.whitestag.ai/WHI/issues/<ISSUE-ID>)
**Agent:** <Agent-Name>
**Dokument(e):**
- <vault-pfad-1>
- <vault-pfad-2>

## Zusammenfassung

<summary-text>

---

<!-- Inhalt des ersten --doc inline ab hier -->
<komplettes Markdown des Hauptdokuments>

<!-- Falls weitere --doc übergeben: -->
---

# Zweites Dokument: <dateiname>

<komplettes Markdown des zweiten Dokuments>
```

**Anhänge:** Jedes `--doc` wird zusätzlich als `.md`-Anhang ins Mailhub-`attachments`-Array gepackt. Mailhub-Limit: 25 MB pro Datei, 25 MB total — Skript prüft das vorab, sonst exit 2.

**Exit-Codes:**
- `0` Erfolg, HTTP 200/201 vom Mailhub
- `1` Argument-Fehler oder Validierung fehlgeschlagen
- `2` Webhook-Fehler (HTTP ≠ 2xx), Body in `/tmp/walter-deliverable-error.out`

**Logging:** Jeder Aufruf wird in `~/.paperclip/instances/default/logs/walter-deliverable.log` mit Timestamp, Issue-ID, Agent, Exit-Code geloggt (eine Zeile pro Aufruf).

### 2. AGENTS.md-Block

Folgender Abschnitt wird in jede der 7 AGENTS.md eingefügt, **direkt nach dem bestehenden Mailhub-Block** und **vor "Dokument-Ablage"**:

````markdown
## Abschluss-Mail an Walter (Pflicht)

Wenn du ein Issue auf `done` setzt UND während der Bearbeitung mindestens eine `.md`-Datei im Vault erzeugt oder geändert hast UND das Root-Issue deines Parent-Baums von Walter erstellt wurde — schickst du Walter eine Abschluss-Mail.

### Trigger-Prüfung (vor PATCH status=done)

1. **Dokument-Check (du):** Hast du in diesem Heartbeat-Run mindestens eine `.md` im Vault (`/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault/`) erzeugt oder geändert? Wenn nein → keine Mail, normal `done` setzen.
2. **Walter-Root-Check (Skript):** Den Parent-Walk machst du nicht selbst — du rufst das Skript bedingungslos auf. Das Skript walkt die Kette, prüft das Root-Issue gegen Walters User-ID und entscheidet:
   - Match → Mail wird gesendet, exit 0.
   - Kein Match → silent skip, exit 0.
3. **Sequenz:** Skript erst, **dann** `done` setzen. Bei Skript-Fehler (exit ≥ 1) `done` trotzdem setzen — Mail ist Nice-to-have, kein Blocker.

### Aufruf

```bash
~/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/bin/send-walter-deliverable.sh \
  --from <DEINE-ROLLE>@whitestag.ai \
  --agent "<DEIN-NAME>" \
  --issue <ISSUE-ID> \
  --issue-title "<ISSUE-TITEL>" \
  --doc "<absoluter-vault-pfad-zur-md>" \
  --summary "<2-3 Sätze Zusammenfassung, max 500 Zeichen>"
```

Mehrere Dokumente? `--doc` mehrfach angeben.

### Fehlerbehandlung

- Exit 0: Skript hat Skip selbst entschieden (z.B. Root-Issue ist nicht von Walter). Kein Issue-Kommentar nötig.
- Exit ≥ 1: Mail fehlgeschlagen. Schreibe Issue-Kommentar mit dem Fehler aus `/tmp/walter-deliverable-error.out`. Setze Issue auf `done` **trotzdem** (Mail ist Nice-to-have, kein Blocker).

### Genau eine Mail pro Issue

Bei Subtask-Ketten: nur das Issue, das die `.md` produziert hat und auf `done` geht, sendet. Wenn das Eltern-Issue später ebenfalls auf `done` geht, ohne selbst eine neue `.md` zu erzeugen, sendet es nicht erneut.
````

### 3. Walter-Root-Check im Skript

Das Skript walkt die Parent-Kette selbst, damit Agenten keine Walter-User-ID hartkodieren müssen:

1. `GET /api/issues/<issue-id>` — hole `parentId`
2. Wiederhole bis `parentId=null` → Root gefunden
3. `GET /api/issues/<root-id>` — lies `createdByUserId`
4. Vergleiche mit `WALTER_USER_ID` (im Skript hartkodiert: `18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9`)
5. Bei Treffer: Mail senden. Sonst: exit 0 ohne Mail (silent skip — der Agent ruft das Skript bedingungslos auf, das Skript filtert).

**Auth:** Skript benötigt einen Paperclip-API-Key. Da es im Heartbeat-Kontext läuft, ist `PAPERCLIP_API_KEY` als ENV vorhanden — das Skript nutzt die.

### 4. Walter-User-ID-Ermittlung

Skript-Time-Konstante. Wert aus DB bestätigt: `18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9` (Walter ist der einzige User mit aktiver Login auf der Instance). Wenn sich das je ändert, muss das Skript angepasst werden — kein Auto-Detect, weil zu fehleranfällig.

## Datenfluss-Beispiel (WHI-417 Replay)

1. CRO checkt `WHI-417` aus, erzeugt `konkurrenz-analyse.md` im Vault, hat alles fertig.
2. CRO prüft: `.md` erzeugt? Ja.
3. CRO ruft Skript mit `--from cro@…`, `--issue WHI-417`, `--doc …konkurrenz-analyse.md`, `--summary …`.
4. Skript walkt: `WHI-417` → parent `WHI-415` (root, `parentId=null`).
5. Skript holt `WHI-415`, prüft `createdByUserId == 18r34Ghx5N…` → Match.
6. Skript baut Subject `[WHI-417] Konkurrenz-Analyse: KI-Unternehmen in der Lausitz — Deliverable von CRO`, Body mit Header + Inline-Markdown, Attachment `konkurrenz-analyse.md`.
7. POST an Mailhub, HTTP 200.
8. Skript exit 0. CRO setzt `WHI-417` auf `done`.

## Fehler-Szenarien

| Szenario | Verhalten |
|---|---|
| Skript nicht aufgerufen (Agent vergisst) | Kein Mail-Versand. Lässt sich nur durch Log-Audit oder Spec-Review nachweisen. |
| `--from` nicht in Whitelist | Skript exit 1, Agent dokumentiert im Issue-Kommentar. |
| Vault-Pfad existiert nicht | Skript exit 1. |
| Mailhub nicht erreichbar | Skript exit 2. Agent dokumentiert, setzt trotzdem `done`. |
| Anhang > 25 MB | Skript exit 1. Agent kürzt Doku oder schickt nur Link. |
| Root-Issue nicht von Walter | Skript exit 0 ohne Mail. Agent merkt das nicht (silent skip by design). |
| Issue selbst hat keinen Parent | Skript prüft `createdByUserId` direkt am Issue. |
| Multi-Document-Aufruf | Erstes `--doc` ist Haupt-Deliverable, restliche werden inline + als Attachment angehängt. |

## Testing

**Manueller Smoke-Test nach Roll-out:**

1. Walter erstellt Test-Issue WHI-TEST mit Body "Bitte erstelle eine kurze Test-Doku zu X.", assigned an CRO.
2. CRO bearbeitet, erzeugt `.md` im Vault, läuft durch den neuen Flow.
3. Walter prüft Inbox `ws@whitestag.ai`: Mail mit `[WHI-TEST] …` angekommen? Subject, Body, Inline-Markdown, Attachment OK?
4. Log-Eintrag in `walter-deliverable.log` korrekt?

**Negativ-Test:**

5. CEO erstellt Subtask von einem Nicht-Walter-Issue (z.B. CEO interne Routine), assigned an einen C-Suite-Agenten, `.md` wird erzeugt, Issue auf `done`.
6. Erwartet: Skript exit 0, keine Mail an Walter. Log zeigt Skip-Reason.

## Migration

**Keine Migration für bestehende Daten nötig.** Die Regel gilt ab Roll-out für neu abgeschlossene Issues.

## Risiken & Trade-offs

- **Agent vergisst, das Skript aufzurufen:** Kein Enforcement außer AGENTS.md-Pflicht. Mitigation: Block prominent platziert, Walter macht Spot-Checks per Log.
- **Walter-User-ID hartkodiert:** Wenn Walter den User wechselt, Skript brechen. Vertretbares Risiko bei Single-User-Instance.
- **Mailhub-Limit 25 MB:** Sehr lange Dokumente (50+ Seiten Markdown mit eingebetteten Bildern als Base64) könnten anschlagen. Bei dem Issue-Typ unwahrscheinlich; Fehlerbehandlung greift.
- **Inline + Anhang = Duplikat im Mail-Body:** Bewusst akzeptiert — Inline ist suchbar, Anhang ist als Datei archivierbar.
- **Sekretärin bleibt parallel:** Zwei Code-Pfade für Walter-Mail. Konsolidierung nach Phase-2-Freigabe der Sekretärin nachholbar.

## Erfolgskriterien

- Walter bekommt für jedes abgeschlossene Walter-Issue mit Vault-Doc von einem der 7 C-Suite-Agenten eine Mail in `ws@whitestag.ai`.
- Mail enthält: Subject mit `[WHI-…]`-Prefix, Header-Block mit Issue-Link/Agent/Pfad/Summary, komplettes Markdown inline, Original-.md als Anhang.
- Subtask-Mails feuern korrekt (Parent-Walk findet Walter-Root).
- Nicht-Walter-Issues triggern keine Mail.

## Offene Fragen

Keine — alle Design-Punkte sind im Brainstorming geklärt.
