# DPO-Gate Wiring — Design

**Status:** Accepted
**Datum:** 2026-04-21
**Vorgänger-Spec:** [`2026-04-20-dpo-agent-design.md`](2026-04-20-dpo-agent-design.md)

## Ziel

Die `paperclip-dpo`-Library produktiv einhängen, sodass alle **direkten** Aufrufe gegen öffentliche LLMs (aktuell: n8n → OpenAI, perspektivisch: TS-Code → Anthropic/OpenAI) durch das DPO-Gate laufen. CLI-basierte Adapter (`claude-local`, `codex-local`, …) sind ausdrücklich nicht abgedeckt und werden per Policy-Dokument geregelt.

## Nicht-Ziele

- CLI-Agenten-Traffic gaten (technisch nicht sauber machbar ohne HTTPS-Proxy — eigene Policy deckt das).
- DSB-Rolle organisatorisch füllen (separater Spec; `paperclip-dpo` ist die Technik, nicht die Rolle).
- Verarbeitungsverzeichnis automatisch generieren (Follow-up).
- Multi-Tenant-Support (Single-Tenant WHITESTAG reicht).

## Architektur

```
┌─────────────┐   ┌─────────────┐   ┌──────────────┐
│n8n Luna V11 │   │n8n CEO V4   │   │TS Direct-API │
│(Telegram)   │   │(Voice)      │   │(future)      │
└──────┬──────┘   └──────┬──────┘   └──────┬───────┘
       │ HTTP            │ HTTP            │ HTTP
       └─────────┬───────┴─────────────────┘
                 ▼
     ┌────────────────────────────────┐
     │DPO-Proxy (n8n Sub-Workflow)    │
     │anonymize → OpenAI → deanon     │
     └───────────────┬────────────────┘
                     │ HTTP (X-DPO-Key)
                     ▼
     ┌──────────────────────────────────────┐
     │paperclip-dpo-service (Fastify)       │
     │0.0.0.0:4711                          │
     │POST /anonymize, /deanonymize, /safe  │
     │Classifier: Gemma via LM Studio local │
     │SQLite-AES Mapping, JSONL Audit       │
     │launchd-Service auf Mac Studio        │
     └──────────────────┬───────────────────┘
                        │
           JSONL-Audit → Monitoring-Loop
                        │
                        ▼
           Stumm · außer: Art-9-Block,
           Classifier-Down, >10 Fehler/h
           → Telegram-Alert direkt (kein n8n)
```

## Netzwerk & Deployment

- **Host:** Mac Studio (gleiche Maschine wie LM Studio; der Gemma-Classifier läuft als `localhost:1234`-Aufruf intern).
- **Bind:** `0.0.0.0:4711` — erreichbar aus `192.168.2.0/24` für n8n-Host, Windows-CFO-Host und weitere LAN-Maschinen.
- **Auth:** Shared Secret im `X-DPO-Key`-Header (konstanter Vergleich). Secret wird generiert beim ersten Start und in macOS-Keychain hinterlegt. Andere Hosts erhalten das Secret via sicherem Kanal (1Password / n8n-Credential / Windows-Credential-Store).
- **Lifecycle:** launchd (`~/Library/LaunchAgents/ai.whitestag.paperclip-dpo.plist`) mit `KeepAlive`, `ThrottleInterval=30`, stdout/stderr nach `/var/log/paperclip-dpo/`.
- **Firewall-Hinweis:** macOS-Firewall muss Port 4711 für LAN erlauben (wird in Install-Anleitung dokumentiert, keine automatische Änderung der Firewall-Policy).

## Komponente 1 — `paperclip-dpo-service` (neues Package)

**Pfad:** `paperclip-dpo-service/` (Sibling zu `paperclip-dpo/`)

**Framework:** Fastify 4 (leichtgewichtig, gute TS-Typen, schnell).

**Entry point:** `paperclip-dpo-service/src/index.ts` — spinnt Server, lädt `paperclip-dpo`-Library via lokalem Workspace-Import.

**Config (env vars):**

| Var | Default | Beschreibung |
|---|---|---|
| `DPO_PORT` | `4711` | HTTP-Listen-Port |
| `DPO_BIND` | `0.0.0.0` | Listen-Interface |
| `DPO_SHARED_KEY` | *required* | Shared Secret für `X-DPO-Key` |
| `DPO_MAPPING_DB` | `/var/paperclip/dpo/mappings.db` | SQLite-Pfad |
| `DPO_MAPPING_KEY_REF` | `keychain:ai.whitestag.paperclip-dpo.mapping` | Keychain-Ref für AES-Key |
| `DPO_AUDIT_DIR` | `/var/paperclip/dpo/audit` | JSONL-Log-Dir |
| `DPO_CLASSIFIER_URL` | `http://localhost:1234` | LM Studio |
| `DPO_CLASSIFIER_MODEL` | `gemma-4-26b` | Classifier-Modell |
| `DPO_CLASSIFIER_TIMEOUT_MS` | `30000` | Timeout für Gemma-Call |
| `DPO_TELEGRAM_BOT_TOKEN` | *optional* | Alert-Bot-Token |
| `DPO_TELEGRAM_CHAT_ID` | *optional* | Alert-Chat-ID |

**Endpoints:**

### `GET /health`
- Keine Auth.
- Antwort `200 { status: "ok", classifier: "reachable"|"unreachable" }`.
- Pingt den Classifier-URL mit kurzem Timeout (3s), cached Ergebnis 10s.

### `POST /anonymize`
- Auth via `X-DPO-Key`.
- Request: `{ text: string, targetLlm: string, agent: string, tenantId?: string }`
- Response Success: `{ blocked: false, anonymizedText: string, mappingId: string }`
- Response Block: `{ blocked: true, reason: string }` — `reason` ∈ `art9_detected`, `dpo_unavailable`.
- Status: `200` immer (auch bei Block — Block ist ein fachliches Ergebnis, kein HTTP-Fehler). `401` bei fehlendem/falschem Key, `400` bei ungültigem Body, `500` bei internen Fehlern.

### `POST /deanonymize`
- Auth via `X-DPO-Key`.
- Request: `{ mappingId: string, text: string }`
- Response: `{ text: string }`
- Status: `200` bei Erfolg, `404` wenn `mappingId` nicht bekannt (oder abgelaufen).

### `POST /safe-call`
- Auth via `X-DPO-Key`.
- Request:
  ```json
  {
    "prompt": "string",
    "targetLlm": "string",
    "agent": "string",
    "tenantId": "string?",
    "external": {
      "url": "string",
      "method": "POST",
      "headers": { "Authorization": "Bearer …" },
      "bodyTemplate": { "model": "gpt-4o-mini", "messages": [{"role":"user","content":"{{prompt}}"}] },
      "responsePath": "choices.0.message.content"
    }
  }
  ```
- Ablauf: `anonymize` → HTTP-Call gegen `external.url` mit gerendertem Body (Placeholder `{{prompt}}` wird durch `anonymizedText` ersetzt) → `responsePath` extrahieren → `deanonymize`.
- Response Success: `{ blocked: false, text: string }`
- Response Block: `{ blocked: true, reason: string }`

**Auth-Middleware:**
- Konstantzeit-Vergleich (`crypto.timingSafeEqual`) um Timing-Attacks zu verhindern.
- `/health` ausgenommen.

**Keine DB-Schema-Änderungen** — nutzt bestehende `paperclip-dpo`-Library 1:1.

## Komponente 2 — n8n Sub-Workflow `DPO-Proxy V1`

**Datei:** `projekte/n8n-workflows/DPO-Proxy V1.json`

**Struktur:**
1. **Webhook/Trigger-Input** (Execute-Workflow-Trigger): erwartet `{ prompt, targetLlm, model, systemPrompt?, agent }`.
2. **HTTP Request — Anonymize:** `POST http://192.168.2.X:4711/anonymize` mit Header `X-DPO-Key` (n8n-Credential `DPO Shared Key`). Body aus Input.
3. **If-Branch: `blocked`?** → returniert `{ blocked: true, reason }` ans Parent.
4. **HTTP Request — OpenAI:** `POST https://api.openai.com/v1/chat/completions` mit anonymisiertem Prompt. Credential aus bestehenden n8n-Credentials.
5. **HTTP Request — Deanonymize:** `POST http://192.168.2.X:4711/deanonymize` mit `mappingId` aus Schritt 2 und dem OpenAI-Response-Text.
6. **Respond:** `{ text }` ans Parent.

**Zu migrierende Parent-Workflows (neue Versionen nach Versionierungs-Regel):**
- `Luna Voice + Telegram V10.json` → `V11.json`: OpenAI-Chat-Node wird ersetzt durch „Execute Workflow — DPO-Proxy V1".
- `Paperclip CEO - Voice & Telegram V3.json` → `V4.json`: Gleiche Änderung.

**n8n-Credential:**
- Neuer Credential-Typ „HTTP Header Auth" mit Name `DPO Shared Key`, Header `X-DPO-Key`, Value = das aus dem Keychain kopierte Secret.

## Komponente 3 — TS-Helper `dpo-client`

**Pfad:** `paperclip-dpo/src/client.ts` (in bestehendes Package gefaltet — kein neues Package, um Abhängigkeits-Wildwuchs zu vermeiden).

**Export aus `paperclip-dpo/src/index.ts`:**
```ts
export { createDpoClient, type DpoClient } from "./client.js";
```

**API:**
```ts
interface DpoClientOptions {
  baseUrl: string;        // z.B. "http://192.168.2.10:4711"
  sharedKey: string;
  timeoutMs?: number;     // default 60000
}

interface DpoClient {
  anonymize(input: { text: string; targetLlm: string; agent: string; tenantId?: string }):
    Promise<{ blocked: false; anonymizedText: string; mappingId: string } | { blocked: true; reason: string }>;
  deanonymize(input: { mappingId: string; text: string }): Promise<{ text: string }>;
  safeCall(input: { /* wie oben */ }): Promise<{ blocked: false; text: string } | { blocked: true; reason: string }>;
  health(): Promise<{ status: string; classifier: string }>;
}

function createDpoClient(opts: DpoClientOptions): DpoClient;
```

**Implementation:** Reiner `fetch`-Wrapper, keine weiteren Dependencies. AbortController für Timeouts.

**Zweck:** zukünftige TS-Code-Stellen (Server-Routes, Skripte) können den DPO nutzen, ohne die komplette Library inkl. SQLite-Bindings lokal instanziieren zu müssen.

## Komponente 4 — Policy-Dokument

**Pfad:** `projekte/dpo/DPO-Policy.md`

**Inhalt (Kern):**

### Abgedeckt durch DPO-Gate

| Adapter / Pfad | Deckung |
|---|---|
| n8n-Workflows → OpenAI/Anthropic direkt | ✅ Pflicht über `DPO-Proxy V1` |
| TS-Code → Direct-API-Calls | ✅ Pflicht über `dpo-client` |

### Nicht abgedeckt (bewusst)

| Adapter | Grund | Mitigation |
|---|---|---|
| `claude-local` | Agentisches CLI mit Filesystem-Zugriff; Tool-Use-Traffic ist nicht adapter-sichtbar | Keine Kundendaten in referenzierten Dateien; lokale LLMs (LM Studio) für PII-haltige Aufgaben |
| `codex-local`, `cursor-local`, `gemini-local`, `opencode-local` | Analog | Analog |
| `openclaw-gateway` | Routing zum Paperclip-Gateway; Gateway-Betreiber hat AV-Vertrag | AV-Vertrag als Kontroll-Pfad |

### Vertrauenswürdige lokale LLMs (kein DPO nötig)

- LM Studio Mac Studio: `http://localhost:1234` und `http://192.168.2.1:1234`
- LM Studio Windows CFO-Host: `http://192.168.2.181:1234`

### Review-Kadenz

- Vierteljährlich vom DSB (aktuell: Walter) reviewen; bei neuen Adaptern / neuen Integrationen ad-hoc.

## Komponente 5 — Monitoring

**Umsetzung:** Hintergrund-Task innerhalb des DPO-Service (kein separater Prozess — Monitoring teilt Lifecycle mit dem Service, was konsistent mit Audit-Log-Schreibung ist).

**Datei:** `paperclip-dpo-service/src/monitor.ts`

**Mechanismus:**
- Alle 5 min: liest Audit-JSONL vom aktuellen Tag, counted seit letztem Check.
- Hält State in-memory (letzte Offset-Position pro Datei) — überlebt Neustarts nicht, ist OK (Alerts sind eh für „live"-Ereignisse).

**Trigger:**

| Ereignis | Schwelle | Alert |
|---|---|---|
| Art-9-Block | jede Einzelmeldung | sofort |
| Classifier unreachable | 3 aufeinanderfolgende `/health`-Fehler | sofort |
| Gesamt-Fehlerrate | >10 Fehler/h | sofort |

**Telegram-Versand:**
- Direkter HTTPS-POST an `https://api.telegram.org/bot<TOKEN>/sendMessage`.
- **Bewusst nicht via n8n** — Alerts müssen auch funktionieren, wenn n8n down ist.
- Nachricht enthält: Ereignistyp, Zeitstempel, Audit-Log-Referenz (Dateiname + Zeile), ggf. Agent-Feld aus dem Log-Eintrag.
- **Alert-Deduplication:** pro Trigger-Typ max. 1 Alert alle 10 min, um Alert-Stürme zu vermeiden.

**Kein tägliches Summary** — stumm bleibt stumm.

## Data Flow Beispiel (Luna Telegram)

1. Telegram-Nachricht: *„Max Mustermann (max@whitestag.de) fragt nach Angebot."*
2. n8n `Luna V11` → ruft Sub-Workflow `DPO-Proxy V1` auf mit `{ prompt, targetLlm: "gpt-4o-mini", agent: "luna" }`.
3. Sub-Workflow → `POST /anonymize` → DPO erkennt E-Mail (Regex), Name+Firma (Gemma) → Pseudonyme `[EMAIL_1]`, `[PERSON_A]`, `[FIRMA_1]`. Mapping in SQLite persistiert. Audit-Eintrag geschrieben.
4. Sub-Workflow → OpenAI mit anonymisiertem Prompt.
5. OpenAI-Response: *„Gerne, [PERSON_A] — [FIRMA_1] bekommt das Angebot via [EMAIL_1]."*
6. Sub-Workflow → `POST /deanonymize` mit `mappingId` → Ersetzung zurück.
7. Rückgabe an Luna: *„Gerne, Max Mustermann — WHITESTAG bekommt das Angebot via max@whitestag.de."*

## Fehlerfälle

| Fall | Verhalten |
|---|---|
| Classifier (Gemma) down | Fail-closed: `{ blocked: true, reason: "dpo_unavailable" }`; Monitor alert nach 3 Fehlversuchen |
| Art-9-Daten erkannt | `{ blocked: true, reason: "art9_detected" }`; sofort Telegram-Alert |
| Falscher / fehlender `X-DPO-Key` | `401 Unauthorized` |
| Ungültiger Request-Body | `400 Bad Request` mit Zod-Fehler |
| Mapping-DB nicht schreibbar | Service terminiert beim Start; launchd restart; nach 3 Neustarts in 60s gibt launchd auf, Walter bemerkt via fehlende `/health` |
| n8n-HTTP-Node zu DPO timeout | n8n-Sub-Workflow returniert Fehler ans Parent; Parent entscheidet (z.B. Luna: „Bin gerade nicht erreichbar, probier's später nochmal" an User) |
| DPO-Service selbst down | Wie oben — n8n-Timeout; Monitor-Alert entfällt (Service ist ja down); **stattdessen:** launchd keepalive restart + separates Mac-level-Monitoring via LaunchAgent-Plist-Keepalive-Checks |

## Sicherheit

- Shared Secret: generiert mit `crypto.randomBytes(32).toString("base64url")`, mindestens 256 Bit.
- `X-DPO-Key`-Vergleich mit `crypto.timingSafeEqual`, nicht mit `===`.
- Mapping-DB AES-verschlüsselt (bestehende `paperclip-dpo`-Library-Funktionalität).
- Audit-Log enthält keine Klartext-PII — nur Kategorien und Pseudonyme.
- `0.0.0.0`-Binding ist akzeptiert, weil Secret schützt; keine Behörden-/Internet-Exposition (LAN-only, Router macht kein Port-Forwarding — wird in Install-Anleitung als Voraussetzung dokumentiert).

## Test-Strategie

- **Unit (Service-Routen):** Vitest, mockt `paperclip-dpo`-Library-Methoden, testet Auth, Body-Validation, Fehler-Handling, Response-Format.
- **Integration:** Opt-in `DPO_INTEGRATION=1` — spinnt Service lokal hoch, macht echten Roundtrip gegen Gemma via LM Studio.
- **Client-Lib Tests:** Vitest gegen einen Mock-Server.
- **n8n-Sub-Workflow:** manueller Smoke-Test mit einem Test-Parent-Workflow; Export wird im Repo abgelegt.
- **Monitoring:** Unit-Tests für die Trigger-Logik (synthetische Audit-Logs injizieren, prüfen ob Telegram-Call ausgelöst würde).

## DSGVO-Mapping

| Artikel | Abdeckung |
|---|---|
| Art. 25 (Privacy by Design) | ✅ DPO-Gate als technische Vorkehrung vor externen Calls |
| Art. 32 (Pseudonymisierung) | ✅ AES-Mapping-DB |
| Art. 28 (Auftragsverarbeitung) | ✅ Audit-Log dokumentiert Empfänger (`targetLlm`) |
| Art. 30 (Verarbeitungsverzeichnis) | ☑️ Datenbasis vorhanden, formaler Generator = Follow-up |
| Art. 9 (Besondere Kategorien) | ✅ Block + Alert |

**Bewusste Lücke:** CLI-Adapter-Traffic (`claude-local` etc.) ist per Policy geregelt, nicht per Technik.

## Offene Punkte / Follow-ups

- **Verarbeitungsverzeichnis-Generator** (Art. 30): aus Audit-JSONL ein formelles VV generieren — separater Spec.
- **DSB-Rolle im Organigramm:** aktuell unbesetzt (Walter ist de-facto DSB). Bei Skalierung >10 MA ggf. formaler benennen.
- **DPO-Agent (Paperclip-Agent):** eigener Spec, falls gewünscht — würde die Library als Tool nutzen.
- **Multi-Tenant-Secret-Rotation:** aktuell Single-Secret. Wenn später Mandanten-Trennung nötig, Rotation-Mechanismus nachrüsten.
