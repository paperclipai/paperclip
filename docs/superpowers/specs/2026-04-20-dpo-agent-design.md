# Design: Datenschutzbeauftragter-Agent (DPO-Agent)

**Datum:** 2026-04-20
**Autor:** Walter Schönenbröcher (DSB) mit Claude
**Status:** Spec — bereit für Implementierungsplan

## Zusammenfassung

Ein lokaler Paperclip-Agent, der als Datenschutz-Proxy zwischen WHITESTAG-Agenten und öffentlichen LLMs (Claude, OpenAI) arbeitet. Er erkennt und anonymisiert personenbezogene Daten **und** unternehmensspezifische Geschäftsgeheimnisse, bevor Anfragen an externe APIs gesendet werden, und de-anonymisiert die Antworten wieder. Lokales Modell: Gemma 4 26b via LM Studio.

## Strategischer Kontext

- Direkter Beitrag zum WHITESTAG.AI-Ziel: lokale, datensouveräne KI-Lösungen
- DSGVO-Konformität als USP gegenüber Wettbewerbern, die nur Cloud-LLMs einsetzen
- Erlaubt WHITESTAG den eigenen Einsatz öffentlicher LLMs ohne Datenschutzrisiko
- Architektur ist multi-tenancy-vorbereitet, damit spätere Produktisierung als Kundenangebot ohne Rebuild möglich ist

## Board-Entscheidungen

| Frage | Entscheidung |
|---|---|
| **Scope** | Intern zuerst, Architektur Multi-Tenancy-fähig (Variante C) |
| **Granularität** | Strukturierte PII **und** Geschäftsgeheimnisse, zweistufige Pipeline (Variante B) |
| **Modellwahl** | MVP: regex (deterministisch) + Gemma 4 26b (LLM-Klassifikator). Dediziertes NER-Modell erst, wenn Performance-Daten es nahelegen (Variante C-pragmatisch) |
| **Performance-Budget** | < 3 s typisch, < 10 s für lange Prompts akzeptabel (Variante B) |

## Architektur

### Platzierung in Paperclip

Der DPO-Agent ist ein regulärer Paperclip-Agent mit `local_llm`-Adapter (LM Studio → Gemma 4 26b). Andere WHITESTAG-Agenten rufen ihn explizit als Subtask auf, bevor sie eine Anfrage an Claude/OpenAI senden.

**Warum nicht Adapter-Layer-Proxy (Option B aus dem Konzept)?** Greift tief in den Paperclip-Core ein, kurzfristig nicht umsetzbar. Bleibt explizites Phase-3-Ziel — der DPO-Agent kann später vom Adapter intern aufgerufen werden, statt explizit von Agenten. Keine architektonische Sackgasse.

### Multi-Tenancy-Vorbereitung

Mapping-Tabelle und Regelwerk werden bereits jetzt mit einer `tenant_id` indiziert — Default `whitestag-internal`. Keine Mandanten-Logik im MVP, nur das Datenmodell ist offen.

### Datenfluss

```
prompt → [1 PII-Detektor]       → maskierter Text + Treffer
       → [2 LLM-Klassifikator]  → zusätzliche Treffer
       → [3 Anonymisierung]     → Pseudonym-Text + mapping_id → Public-LLM
                                                              ↓ Antwort
                                  [5 De-Anonymisierung] ←─────┘
                                           ↓
                                  Klartext-Antwort an Agent
       → [6 Audit-Log]           (parallel)
```

## Komponenten

### 1. PII-Detektor (deterministisch)

Regex/Pattern-Matching-Schicht. Erkennt: E-Mail, Telefon (DE-Formate), IBAN, BIC, USt-IdNr. (DE/EU), Steuernummer, deutsche Postleitzahlen, URLs. Liefert eine Liste `{type, span, value}`. Keine LLM-Beteiligung. Latenz: Millisekunden.

### 2. Entitäts-Klassifikator (LLM)

Gemma 4 26b via LM Studio. Bekommt den um deterministische Treffer **maskierten** Text und ein striktes JSON-Schema. Aufgabe: Personen, Firmen, Orte, sowie Geschäftsgeheimnis-Aussagen (Umsätze, Margen, Preise, Gehälter, vertrauliche Kundenbeziehungen) erkennen. Confidence-Score pro Treffer (`low` | `medium` | `high`).

### 3. Anonymisierungs-Engine

Vereint Treffer aus 1+2, vergibt konsistente Pseudonyme (`[PERSON_A]`, `[FIRMA_1]`, `[BETRAG_X]`), schreibt in den Mapping-Store, ersetzt im Text. Konsistenz: gleicher Klartext → gleiches Pseudonym innerhalb einer `mapping_id`.

### 4. Mapping-Store

SQLite-Tabelle, AES-verschlüsselt (Key aus macOS Keychain).

Schema:
```sql
CREATE TABLE mappings (
  mapping_id TEXT NOT NULL,
  tenant_id  TEXT NOT NULL DEFAULT 'whitestag-internal',
  pseudonym  TEXT NOT NULL,
  plaintext  TEXT NOT NULL,
  type       TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 86400,
  PRIMARY KEY (mapping_id, pseudonym)
);
CREATE INDEX idx_mappings_tenant ON mappings(tenant_id);
CREATE INDEX idx_mappings_cleanup ON mappings(created_at, ttl_seconds);
```

TTL-Default: 24h. Cleanup-Job löscht abgelaufene Einträge stündlich.

### 5. De-Anonymisierungs-Engine

Bekommt LLM-Antwort + `mapping_id`, ersetzt alle bekannten Pseudonyme zurück durch Klartext. Strikt deterministisch, kein LLM nötig.

### 6. Audit-Log

Append-only JSONL pro Tag (`audit/dpo-YYYY-MM-DD.jsonl`). Pro Anfrage:

```json
{
  "ts": "2026-04-20T10:23:11Z",
  "agent": "ceo",
  "target_llm": "claude-opus-4-7",
  "tenant_id": "whitestag-internal",
  "prompt_hash": "sha256:...",
  "findings": {"PERSON": 2, "FIRMA": 1, "GESCHÄFTSGEHEIMNIS": 1},
  "blocked": false
}
```

Hash statt Inhalt — direkt nutzbar als Beleg für das Verarbeitungsverzeichnis nach Art. 30 DSGVO.

## Schnittstelle

Kommunikation läuft über die normalen Paperclip-Subtask-Mechanismen mit zwei klar definierten Operationen.

### Operation 1: `anonymize`

Request (Document `key: dpo-request`):
```json
{
  "op": "anonymize",
  "text": "<Original-Prompt>",
  "target_llm": "claude-opus-4-7",
  "tenant_id": "whitestag-internal"
}
```

Response (Document `key: dpo-response`):
```json
{
  "mapping_id": "uuid-...",
  "anonymized_text": "<Pseudonym-Prompt>",
  "findings": [
    {"type": "PERSON", "count": 2, "confidence": "high"},
    {"type": "GESCHÄFTSGEHEIMNIS", "count": 1, "confidence": "medium"}
  ],
  "warnings": []
}
```

### Operation 2: `deanonymize`

Request:
```json
{
  "op": "deanonymize",
  "mapping_id": "uuid-...",
  "text": "<LLM-Antwort mit Pseudonymen>"
}
```

Response:
```json
{ "text": "<Klartext-Antwort>" }
```

### Veto-Modus

Liefert die LLM-Stufe Findings mit Confidence `high` für Kategorien, die nach Regelwerk **nicht** ersetzt werden dürfen (z.B. besondere Kategorien nach Art. 9 DSGVO), antwortet der DPO statt mit `mapping_id`:

```json
{ "blocked": true, "reason": "art_9_data_detected" }
```

Der aufrufende Agent muss die Anfrage abbrechen oder umformulieren.

### Helper für Agenten

Da der Subtask-Roundtrip im Code repetitiv ist, bekommt das Paperclip-Agentenframework eine Hilfsfunktion `safe_external_llm(prompt, target)`, die intern den DPO-Subtask, den eigentlichen LLM-Call und die De-Anonymisierung kapselt. Agenten rufen also in der Regel **nicht** `anonymize`/`deanonymize` direkt auf, sondern `safe_external_llm(...)`. Direkter Zugriff bleibt für Sonderfälle erhalten.

### Fail-Closed-Verhalten

Ist Gemma 4 26b zeitweise nicht verfügbar (LM Studio aus, Modell nicht geladen), antwortet der DPO mit `{"blocked": true, "reason": "dpo_unavailable"}`. Kein „Durchwinken" ungesicherter Anfragen.

## Regelwerk

Default-Regelwerk hardcoded in `dpo-rules.default.yaml`:

```yaml
tenant: whitestag-internal
detect:
  pii:
    - email
    - phone_de
    - iban
    - bic
    - ust_id
    - steuernummer
    - plz_de
    - url
  llm:
    - person
    - firma
    - ort
    - geschaeftsgeheimnis
block:
  art_9_categories: true   # Gesundheit, Religion, Biometrie etc. → Veto
confidence_threshold:
  block: high
  anonymize: medium
mapping:
  ttl_seconds: 86400       # 24h
```

Phase 2 erweitert: pro `tenant_id` eigene YAML, Hot-Reload, kundenspezifische Profile.

## MVP-Scope (Phase 1)

### Drin

- DPO-Agent als Paperclip-Agent mit `local_llm`-Adapter (LM Studio → Gemma 4 26b)
- Modul 1: Regex-Detektor (E-Mail, Telefon DE, IBAN, BIC, USt-IdNr., Steuernummer, PLZ, URL)
- Modul 2: Gemma-Klassifikator mit JSON-Schema (Personen, Firmen, Orte, Geschäftsgeheimnisse)
- Modul 3: Anonymisierung mit konsistenten Pseudonymen pro `mapping_id`
- Modul 4: SQLite Mapping-Store, AES-verschlüsselt, Key in macOS Keychain, TTL 24h, Cleanup-Job
- Modul 5: De-Anonymisierungs-Engine
- Modul 6: Audit-Log als JSONL (Hash statt Inhalt)
- Schnittstelle: `anonymize` / `deanonymize` als Paperclip-Subtask-Operationen
- Helper `safe_external_llm()` für Agentenframework
- Veto-Modus für Art.-9-Daten
- Datenmodell mit `tenant_id` (Default `whitestag-internal`)
- Default-Regelwerk hardcoded (`dpo-rules.default.yaml`)
- Ein End-to-End-Test mit echtem WHITESTAG-Workflow (CEO ruft Claude über DPO)

### Bewusst nicht im MVP

- Kein dediziertes NER-Modell (Stufe 1 bleibt regex; Umstellung wenn Performance-Daten es nahelegen)
- Keine kundenspezifischen Regelwerke (nur Default)
- Kein Dashboard, keine UI — Audit-Log über Datei
- Kein automatischer Adapter-Layer-Proxy (Phase 3)
- Kein Webhook/Streaming, nur synchroner Subtask
- Keine semantische Heuristik darüber hinaus (kein „Stufe C" der Granularität)
- Keine Performance-Optimierung jenseits einfacher Caches
- Keine generierte DSFA / Verarbeitungsverzeichnis (Phase 2 mit `whitestag-dsgvo`-Skill)

### Definition of Done

1. Agent ist in Paperclip registriert und über CEO als Subtask aufrufbar
2. Beispiel-Prompt mit allen Detektor-Kategorien wird korrekt anonymisiert (manueller Vergleich)
3. Round-Trip mit Claude funktioniert: Prompt → DPO → Claude → DPO → Klartext
4. Audit-Log-Eintrag entsteht und ist lesbar
5. Mapping-Store-Eintrag wird nach TTL automatisch gelöscht

## Spätere Phasen

### Phase 2 — Produktionsreife

- Performance-Messung im Live-Betrieb. Falls Gemma-26b-Latenz Stufe 1 verlangsamt: dediziertes NER-Modell (`flair/ner-german-large` oder `xlm-roberta`) als optionaler Adapter
- Generator für DSFA und Verarbeitungsverzeichnis-Eintrag aus Audit-Log (mit `whitestag-dsgvo`-Skill)
- Erweitertes Regelwerk pro `tenant_id` (echte Multi-Tenancy-Logik)
- Strukturiertes Logging + Metriken (Latenz, Trefferquote, Veto-Rate)

### Phase 3 — Produktisierung & Tiefe Integration

- Adapter-Layer-Proxy (Option B aus Konzept): DPO automatisch im Outbound-Path, kein expliziter Aufruf nötig
- Mandantenfähigkeit für Kunden-Deployments
- Dashboard für Datenschutz-Übersicht
- Lizenz-/Wartungsmodell als WHITESTAG.AI-Produkt

## Risiken

| Risiko | Mitigation im MVP |
|---|---|
| LLM-Klassifikator übersieht Geschäftsgeheimnis (False Negative) | Audit-Log mit Hash erlaubt nachträgliches Review; konservativer System-Prompt mit Beispielen |
| LLM-Klassifikator overblockt (False Positive) | Confidence-Schwelle in Regelwerk konfigurierbar; Veto nur ab `high` |
| Mapping-Store-Leak | AES-Verschlüsselung, Key im OS-Keychain, kurzer TTL |
| De-Anonymisierung fehlerhaft (Pseudonym in Antwort verändert) | Pseudonym-Format eindeutig (`[TYPE_X]`), Regex-basierte Rückersetzung |
| Agent vergisst DPO aufzurufen | Helper `safe_external_llm()` als Standardweg; in Agenten-Templates verankert; Phase 3 macht es zwingend (Adapter-Proxy) |
| Gemma 4 26b zeitweise nicht verfügbar | Fail-Closed: DPO antwortet mit `blocked: dpo_unavailable` |

## DSGVO-Bezug

| Artikel | Bezug |
|---|---|
| Art. 25 — Privacy by Design | DPO ist die technische Umsetzung des Prinzips für externe LLM-Nutzung |
| Art. 32 — Pseudonymisierung als Sicherheitsmaßnahme | Kerntechnik des DPO |
| Art. 28 — Auftragsverarbeitung | Audit-Log dokumentiert Übermittlungen an Claude/OpenAI |
| Art. 30 — Verarbeitungsverzeichnis | Audit-Log liefert Datenbasis (Phase 2 generiert daraus den Eintrag) |
| Art. 9 — Besondere Kategorien | Veto-Modus blockiert solche Daten vollständig |
