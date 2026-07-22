# Vier-Augen-System für Lunas E-Mail-Antworten — Design

- **Datum:** 2026-07-22
- **Status:** Design freigegeben (Walter), Umsetzung folgt
- **Company:** WHITESTAG (`9cebf3cf-efe8-4597-a400-f06488900a87`)
- **Agent:** Sekretärin „Luna" (`e24b8d9d-143e-4141-b413-4361aa618771`)

## Ausgangslage

Luna ist heute in **Phase 2 (halb-autonom)**. Sie klassifiziert eingehende ws@-Mails,
delegiert an die C-Suite und formuliert Antwort-Entwürfe — aber **jeder Versand an
Externe ist hart gesperrt**. Der Riegel sitzt im n8n-Workflow `SMTP Relay V15`, Node
`Validate Request` (die „Luna-Guard"):

```js
if (from === 'office@whitestag.ai') {
    const ok = addrs.length > 0 && addrs.every(a => a === 'ws@whitestag.ai');
    if (!ok) return reject('Phase-2-Sperre: office@ (Luna) darf ausschliesslich an ws@whitestag.ai senden…');
}
```

Zusätzlich schickt der Mail-Watcher (`~/.paperclip/scripts/sekretaerin-mail-watcher/`)
bei jeder neuen Mail-Charge ein „Mail-Triage"-Issue an Luna, und Luna sendet Walter
Triage-Übersichts- und Entwurfs-Mails.

**Schmerzpunkte:** (1) Walter ertrinkt in Triage-Übersichtsmails. (2) Jede Kundenantwort
muss Walter manuell selbst tippen/versenden — Luna darf nur vorschlagen.

## Ziel

Ein **Vier-Augen-System**: Luna formuliert Antworten und legt sie Walter zur Freigabe
vor. Bestätigt Walter mit **exakt „Okay"**, versendet ein deterministischer Watcher
**genau diesen Entwurf** an den externen Empfänger. Kein LLM im Sende-Pfad.

### Konkrete Anforderungen (aus dem Brainstorming)

1. **Triage-Übersichtsmails an Walter entfallen.** Luna bleibt **read-only** auf dem
   Postfach — verschiebt/löscht nie etwas.
2. **Antwort-Entwürfe statt Triage:** Für jede antwortwürdige Mail formuliert Luna den
   Entwurf und schickt ihn **Walter zur Freigabe** (nicht an den Empfänger).
3. **„Okay"-Riegel:** Antwortet Walter mit **exakt „Okay"** (Groß/Klein egal), versendet
   Luna genau diesen Entwurf selbständig an den Original-Empfänger.
4. **Korrekturen** (alles außer „Okay") → Luna überarbeitet den Entwurf und legt mit
   **neuem Token** erneut zur Freigabe vor. Nichts geht ungeprüft raus.
5. **Absender** der externen Antwort: `office@whitestag.ai` mit **`Reply-To: ws@whitestag.ai`**,
   damit Kundenantworten bei Walter (nicht bei Luna) landen.

## Grundprinzip: Der Relay ist der Riegel

Die Freigabe wird **am SMTP-Relay erzwungen**, nicht durch Lunas Prompt-Wohlverhalten.
`office@→extern` wird nur durchgelassen, wenn die Anfrage einen **Freigabe-Nachweis**
(`X-Mailhub-Approval`) trägt, den **allein der deterministische Approval-Watcher besitzt**.
Luna kennt diesen Nachweis nie. Selbst bei fehlerhaftem Luna-Verhalten kann keine externe
Mail entstehen.

**Sicherheitseigenschaft „approved bytes == sent bytes":** Der freigegebene Entwurf wird
verbatim in der Queue gespeichert; der Watcher sendet exakt diese Bytes. Luna re-generiert
nach der Freigabe nichts mehr — was Walter gesehen hat, geht raus.

## Architektur / Komponenten

### 1. Mail-Watcher (Umbau des bestehenden launchd-Jobs)

`~/.paperclip/scripts/sekretaerin-mail-watcher/watcher.py`, alle 10 Min, Aktivfenster 6–20h.
Zwei Aufgaben:

- **(a) Neue-Mail-Erkennung (bestehend, angepasst):** neue ws@-Mail-Dateien → Issue an Luna.
  Der Issue-Auftrag wird umformuliert: **kein Triage-Übersichts-Output an Walter mehr**,
  stattdessen pro antwortwürdiger Mail ein Freigabe-Entwurf (siehe Luna-Rolle).
- **(b) Approval-Erkennung (NEU):** scannt neue Vault-Mails von Walter (Absender
  `w.schonenbrocher…`) auf Freigabe-Antworten und löst Sendungen aus (siehe Algorithmus).

### 2. Luna (Rolle → „Phase 3, Okay-gated")

Rollen-Datei: `~/.paperclip/scripts/agents-instructions/roles/sekret-rin.role.md`
(Änderungen NUR hier + Generator; AGENTS.md wird nächtlich überschrieben — nach Edit
Generator laufen lassen).

Pro antwortwürdiger Mail (`actionable` / `unklar`):

1. Antworttext formulieren.
2. Freigabe-Eintrag anlegen + Freigabe-Mail an Walter senden — über **ein neues Helper-Skript
   `luna-queue-approval.py`** (ersetzt den bisherigen `luna-draft-mail.py --mode draft`-Fluss
   für den Freigabe-Weg).
3. **Nie** selbst extern senden. Kein direkter Relay-Aufruf mit `--mode direct`.
4. Bei Korrektur-Weckung: Entwurf anhand Walters Anmerkung überarbeiten, alten Queue-Eintrag
   als `superseded` markieren, neuen mit neuem Token vorlegen.

**Spam/FYI:** keine Meldung an Walter (Originale liegen ohnehin in seinem ws@-Postfach →
keine Blindheit für Fehlklassifikation). Spam-Cancel / FYI-Archiv wie in Phase 2.

### 3. Freigabe-Queue

Verzeichnis: `~/.paperclip/state/luna-approvals/<token>.json`

```json
{
  "token": "A7X3",
  "status": "pending | sent | superseded | expired",
  "to": "kunde@example.de",
  "area": "AI | FILM | SORBART",
  "subject": "AW: <Original-Betreff>",
  "body_md": "<Antworttext, Markdown>",
  "rendered_html": "<finales HTML inkl. Signatur>",
  "in_reply_to": "<Message-ID der Originalmail, falls bekannt>",
  "original_mail_file": "2026-07-22-...-kontakt.md",
  "approval_subject": "[Freigabe #A7X3] AW: <Betreff> → an kunde@example.de",
  "created": "2026-07-22T14:03:00",
  "sent": null
}
```

- **Token:** kurzer, kollisionsarmer Code (z.B. 4 Zeichen Base32, Großbuchstaben+Ziffern).
  Erzeugung deterministisch aus Zeit+Zähler (Skript darf `Date`/`random` nutzen — nur
  Workflow-Skripte dürfen das nicht; dies ist ein normales Python-Skript).
- **Verbatim-Prinzip:** `rendered_html` + `to` + `subject` sind die einzige Sende-Quelle.

### 4. Approval-Watcher-Algorithmus (deterministisch, in watcher.py)

Für jede neue Vault-Mail von Walter (`w.schonenbrocher`), deren Betreff `[Freigabe #<token>]`
enthält:

1. Queue-Eintrag zu `<token>` laden. Fehlt er / `status != pending` → ignorieren
   (schon verbraucht/verfallen).
2. **Antworttext isolieren:** obersten Absatz aus dem Mail-Body extrahieren; alles ab
   Zitat-Marker (`>`, „Am … schrieb …", „Von: …", `-----`) und ab Signaturtrenner (`-- `)
   abschneiden. Whitespace trimmen.
3. **Exakt-„Okay"-Prüfung:** isolierter Text, normalisiert (trim, lowercase, End-Satzzeichen
   `.!` entfernt), **== `okay`**? 
   - **Ja** → `send_approved(token)`:
     - POST an Relay-Webhook mit Payload aus Queue-Eintrag **plus `X-Mailhub-Approval`-Header**.
     - Bei HTTP 200 → `status=sent`, `sent=<jetzt>`. Bei Fehler → Eintrag bleibt `pending`,
       Fehler ins Log, Subtask an CTO (Störung).
   - **Nein** → **Korrektur:** Issue/Subtask an Luna mit (a) Walters Anmerkungstext,
     (b) Verweis auf Queue-Eintrag/Originalmail. Luna überarbeitet (neuer Token).
4. **Fail-safe:** Lässt sich kein sauberes, alleinstehendes „okay" isolieren (Mehrdeutigkeit,
   Parsing unsicher) → als **Korrektur** behandeln. Nie senden im Zweifel.
5. **TTL:** Queue-Einträge mit `status=pending` und `created` älter als **7 Tage** →
   `status=expired`, kein Versand, keine Meldung.

**Idempotenz:** Der Watcher merkt sich verarbeitete Walter-Mail-Dateien (bestehender
`seen`-State) — dieselbe „Okay"-Mail löst nie zwei Sendungen aus. Zusätzlich schützt
`status != pending` gegen Doppelversand.

### 5. SMTP Relay V16 (aus V15, versioniert)

Änderungen im Node `Validate Request` und am Office-Sendeweg:

- **Luna-Guard öffnen (nur gated):** Wenn `from === 'office@whitestag.ai'` und Ziel extern:
  erlauben **nur**, wenn der Request einen gültigen `X-Mailhub-Approval`-Nachweis trägt
  (Header oder Body-Feld, gegen ein Secret geprüft, das nur der Watcher hat). Ohne Nachweis:
  weiterhin **nur ws@** (unverändert). Alle anderen Agenten-Sperren bleiben exakt wie in V15.
- **`Reply-To: ws@whitestag.ai`** auf ausgehenden office@→extern-Mails setzen
  (Node `SMTP Send Office`, `replyTo`-Option).
- **Threading:** `inReplyTo` (bereits im Payload unterstützt) an den Header durchreichen,
  damit die Antwort im Kunden-Thread landet.
- Versionierung gemäß Hausregel: V15 unangetastet lassen, V16 als Kopie, sauber publishen
  (deactivate→activate-Zyklus), `activeVersionId == versionId` verifizieren. Neueste Version
  zusätzlich nach zentralem `n8n Workflows/`-Ordner kopieren.

**Approval-Secret:** neues Secret, nur im Watcher hinterlegt (z.B. `~/.paperclip/state/`
oder Env). Luna-Skripte kennen es nicht.

### 6. Sicherheitsnetz: office@-Inbound

`Mailhub V7 — Inbound`, Node `IMAP Office` / `Allowlist + Auth Filter`: echte Kundenantworten,
die (trotz `Reply-To`) an `office@` landen, an Walter weiterleiten bzw. als Issue mit
Hinweis kennzeichnen. Kein neuer Workflow — Regel im bestehenden. (Ausbaustufe, niedrigere
Priorität als der Kernpfad.)

## Was Walter erlebt

- Keine Triage-Übersichtsmails mehr.
- Pro antwortwürdiger Mail **eine** Freigabe-Mail: `[Freigabe #A7X3] AW: <Betreff> → an <Kunde>`
  mit dem fertig gerenderten Entwurf (inkl. Signatur, so wie er rausginge).
- Antwort **„Okay"** → Mail geht raus (aus office@, `Reply-To: ws@`).
- Antwort mit Anmerkung → Luna überarbeitet, neue Freigabe-Mail.
- Ignorieren → nichts passiert; Eintrag verfällt nach 7 Tagen.

## Grenzen (unverändert)

- Luna read-only auf dem Postfach: kein Verschieben/Löschen.
- Kein Token, kein Byte nach außen — erzwungen vom Relay, nicht von Lunas Goodwill.
- Keine Zusagen zu Preisen/Verträgen ohne Walters Freigabe (die Freigabe IST das „Okay").

## Testing

- **Approval-Parsing (Unit):** Entscheidung ist **exakt „Okay"** — nur der isolierte,
  normalisierte Text `okay` löst den Versand aus, sonst alles = Korrektur. Testtabelle:
  „Okay" → send · „okay." → send (End-Satzzeichen entfernt) · „OK" → **correction**
  (nicht „okay") · „Senden" → **correction** · „Okay, aber Termin streichen" → correction ·
  „Bitte förmlicher" → correction · leer → correction · nur Zitat → correction.
- **Verbatim-Send:** Queue-Eintrag → Relay-Payload identisch zu `rendered_html`/`to`/`subject`.
- **Guard (Relay):** office@→extern ohne Approval-Header → 400; mit gültigem Header → 200;
  Luna-Skript-Pfad (ohne Header) → weiterhin nur ws@.
- **Idempotenz:** dieselbe „Okay"-Mail zweimal gescannt → genau ein Versand.
- **TTL:** 8 Tage alter pending-Eintrag → `expired`, kein Versand.
- **Fail-safe:** unparsbarer Body → correction, nie send.

## Rollout / Migration

1. Relay V16 bauen + testen (Guard-Öffnung, Reply-To, Threading) — noch ohne Luna-Umstellung.
2. Queue + `luna-queue-approval.py` + Approval-Watcher-Logik bauen + Unit-Tests grün.
3. Watcher (b) aktivieren; Luna-Rolle auf „Phase 3, Okay-gated" umstellen + AGENTS.md
   regenerieren.
4. Triage-Übersichts-Output abschalten (Watcher-Auftragstext + Rolle).
5. Schattenlauf mit einer echten, unkritischen Kundenmail; „Okay"-Pfad end-to-end verifizieren.

## Offene Detailpunkte (im Plan zu fixieren)

- Exaktes Token-Format + Kollisionsschutz.
- `X-Mailhub-Approval` als Header vs. Body-Feld (Header sauberer; prüfen, ob Webhook-Node ihn durchreicht).
- Genaue Quote-/Signatur-Abschneide-Heuristik für Walters Exchange-Client (Beispiel-Mails aus Vault als Fixtures).
- Ob `luna-draft-mail.py --mode direct` ganz entfernt oder als toter Pfad belassen wird.
