# Design: Zentraler OpenAI-Bilddienst für Paperclip

**Datum:** 2026-06-15
**Status:** Entwurf (vom Nutzer freigegeben, vor Implementierungsplan)
**Architektur-Ansatz:** C — Zentraler n8n-Bilddienst (Label-getriggert, pollend)

## Ziel

Jeder Paperclip-Agent in **allen drei Companies** (WHITESTAG, Clara, Health) soll
per **einfacher Prompt-Übergabe** eine Grafik bestellen können und das fertige
PNG als Issue-Attachment zurückbekommen — automatisiert, ohne Mensch im Loop.

Die Bildqualität liefert **OpenAI `gpt-image-1`** über die Images-API. Begründung:
Der Bedarf liegt bei **Grafik mit lesbarem Text, Diagrammen/Schaubildern und
Markenkonsistenz** — genau die Felder, in denen `gpt-image-1` dem lokalen Flux
klar überlegen ist. Der lokale ComfyUI/Flux-Pfad scheidet aus, weil der
Mac-Speicher durch die LLMs (Qwen @262k + Gemma + Embeddings) gesättigt ist; der
API-Weg hat **null lokalen Ressourcen-Fußabdruck**.

## Nicht-Ziele (YAGNI)

- Kein neuer Paperclip-Adapter, kein neuer „Bild-Bot"-Agent pro Company.
- Keine Nutzung des OpenAI-**Abos** — programmatische Bildgenerierung erfordert
  zwingend einen separaten **API-Key** (Abo bietet keine API-Schnittstelle).
- ComfyUI/Flux wird **nicht gelöscht**, nur stillgelegt (dokumentierter Notnagel;
  spätere Option: ComfyUI auf der RTX-Pro-6000-Box im LM-Link-Mesh).
- Kein Bild-Editing/Variationen in V1 — nur Text-zu-Bild-Generierung.

## Warum dieser Ansatz

Untersuchung des Ist-Zustands ergab:

- **Delegation läuft pro Company** (Issues gehören einer Company); ein Agent kann
  keine Company-Grenze überschreiten. Ein zentraler *Agent* für alle drei
  Companies ist damit unmöglich — ein zentraler *Dienst* (n8n) hingegen nicht.
- **Die meisten Agenten sind `lmstudio_local`** und können keine Skripte/Skills
  selbst ausführen — sie können nur delegieren (Text schreiben). Damit scheidet
  „jeder Agent ruft das Bild-Tool selbst" aus.
- **Paperclip hat keine ausgehenden Webhooks/Events** (nur inbound). Ein externer
  Dienst **muss pollen**.
- **Labels, `blockParentUntilDone` und der Wake-Mechanismus existieren** und
  funktionieren actor-unabhängig (siehe Referenzen unten).

n8n-Wächter sind das etablierte Muster im Setup (Issue-getrieben, idempotent),
zentralisieren Key + Kosten an einer Stelle und decken alle Companies + alle
Adapter-Typen ab.

## Komponenten & Datenfluss

### 1. Anfrage-Schnittstelle (Agent → Subtask)

Ein anfragender Agent legt unter seinem aktuellen Issue einen **Subtask** an
(`POST /api/companies/{companyId}/issues`, `createChildIssueSchema`):

- `parentId` = aktuelles Issue, `goalId` = goalId des Parents
- `labelIds: [<bild:openai-UUID dieser Company>]`
- `blockParentUntilDone: true`
- **Brief in der Description** (einfaches `key: value`-Format):

```
prompt: <Bildbeschreibung — Pflichtfeld>
size: 1024x1536        # optional; erlaubt: 1024x1024 | 1024x1536 | 1536x1024; default 1024x1024
quality: high          # optional; erlaubt: low | medium | high; default medium
transparent: false     # optional; default false
```

Die Label-UUID je Company wird in die **generierten AGENTS.md** eingespeist
(Generator unter `~/.paperclip/scripts/agents-instructions/`), inkl. einer
kurzen Anleitung mit dem Brief-Format. Der Agent muss die UUID nicht kennen,
nur einsetzen.

### 2. n8n-Workflow „OpenAI-Bilddienst V1"

```
[Schedule-Trigger ~60 s]
  └─> Config-Node: Tabelle [{companyId, labelId}] für die 3 Companies
       └─> pro Company: GET offene Issues mit ?labelId={labelId}
            └─> pro Subtask mit Status "todo"/offen (nicht in_progress/terminal):
                 1. Subtask → "in_progress"  (Idempotenz-Lock gegen Doppel-Poll)
                 2. Brief aus Description parsen + validieren (Defaults einsetzen)
                 3. Tageslimit prüfen  → bei Überschreitung: Kommentar + "cancelled", stop
                 4. POST api.openai.com/v1/images/generations
                    { model: "gpt-image-1", prompt, size, quality, background }
                 5. PNG (b64) dekodieren
                 6. POST /api/companies/{companyId}/issues/{subtaskId}/attachments (multipart)
                 7. Kommentar ans Subtask: Prompt + Settings + geschätzte Kosten
                 8. Kosten-Log-Zeile schreiben
                 9. Subtask → "done"  ⇒ Paperclip weckt den Parent (issue_children_completed)
```

Der Parent-Agent (Assignee seines eigenen Issues) wacht auf, sieht das PNG am
abgeschlossenen Subtask und arbeitet weiter.

### 3. Secrets & Auth

- **OpenAI-API-Key** und **Paperclip-API-Token** im verschlüsselten
  **n8n-Credentials-Store**, nicht im Workflow-JSON.
- **Token-TTL-Risiko**: Paperclip-Board-Token laufen ~30 Tage ab. Wenn ein
  langlebiger Service-Token verfügbar ist, diesen nutzen; andernfalls behandelt
  der Workflow ein `401` als **lauten Alarm** (Mail/Issue an Walter), statt
  still zu sterben.

### 4. Kosten-Leitplanken

- Defaults: **1024×1024**, Qualität **medium**. `high` nur bei explizitem Brief.
- **Tageslimit** (konfigurierbar, Start: 50 Bilder/Tag): bei Überschreitung kein
  OpenAI-Call, sondern Kommentar „Tageslimit erreicht" + Subtask `cancelled`.
- **Kosten-Log**: jede Generierung (Prompt, Size, Quality, geschätzte Kosten) in
  eine Log-Zeile bzw. ein dediziertes „Bildkosten"-Issue.

### 5. Fehlerbehandlung

- **Idempotenz**: `in_progress`-Lock vor dem OpenAI-Call; der nächste Poll fasst
  den Subtask nicht erneut an.
- **Harte Fehler** (Content-Policy-Ablehnung, Rate-Limit, Auth): Subtask →
  **`cancelled`** + erklärender Kommentar. Der Parent wacht trotzdem auf
  (`cancelled` ist terminal) und sieht den Grund — kein Hängenbleiben.
- **Erfolg**: PNG-Attachment + Settings-Kommentar → Subtask `done`.

### 6. Betrieb & Versionierung

- Workflow zentral als **„OpenAI-Bilddienst V1.json"** im n8n-Workflows-Ordner
  (`/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/n8n Workflows/`),
  Versionsregel V1/V2…
- Aktivierung über den etablierten n8n-Restart-Weg.
- Ein Workflow iteriert über alle drei Companies (Config-Tabelle im ersten Node).

## Referenzierte Code-Stellen (Ist-Zustand, verifiziert)

- Subtask-Erstellung: `server/src/routes/issues.ts` (`POST /issues/:id/children`),
  Schema `createChildIssueSchema` in `packages/shared/src/validators/issue.ts`
  (`labelIds`, `blockParentUntilDone`).
- Blocker-Sync: `server/src/services/issues.ts` (`blockParentUntilDone` →
  `syncBlockedByIssueIds`).
- Attachments: `POST /companies/:companyId/issues/:issueId/attachments`
  (`server/src/routes/issues.ts`), DB `assets` + `issue_attachments`.
- Labels: DB `labels` + `issue_labels`; Create via `labelIds:[uuid]`;
  List-Filter `?labelId={uuid}`.
- Wake: `server/src/services/issues.ts` — `becameTerminal` + `issue_children_completed`,
  **actor-unabhängig** (n8n-API-Token weckt den Parent).
- Kein Outbound-Webhook-System (nur inbound `plugin_webhooks`) → Polling Pflicht.

## Offene Implementierungs-Details (für den Plan)

- Genaue Paperclip-API-Auth für n8n (Service-Token vs. Board-Token) verifizieren.
- `gpt-image-1`-Parameter (`background: transparent`, `quality`, Response-Format
  b64) gegen die aktuelle OpenAI-Images-API gegenprüfen.
- Brief-Parser robust gegen unsaubere Agenten-Eingaben (fehlende Felder,
  Markdown-Müll) auslegen.
- Mechanik des `in_progress`-Locks (Statuswert vs. internes Verarbeitungs-Label).
