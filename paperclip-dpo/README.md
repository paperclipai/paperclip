# paperclip-dpo

Datenschutzbeauftragten-Agent für Paperclip — anonymisiert PII und Geschäftsgeheimnisse, bevor Anfragen an Public-LLMs (Claude, OpenAI) gehen.

Siehe Spec: `docs/superpowers/specs/2026-04-20-dpo-agent-design.md`

## MVP-Nutzung

Im MVP rufen WHITESTAG-Agenten den DPO direkt aus ihrem Code via `safeExternalLlm()` auf. Eine Tool-basierte Integration in den LM-Studio-Adapter (`paperclip-tools.ts`) ist Phase 2.

```ts
import { createDpo, safeExternalLlm } from "paperclip-dpo";
import { getOrCreateMappingKey } from "paperclip-dpo/keychain";

const dpo = createDpo({
  mappingDbPath: "/var/paperclip/dpo/mappings.db",
  mappingKey: await getOrCreateMappingKey(),
  auditDir: "/var/paperclip/dpo/audit",
  classifier: {
    url: "http://localhost:1234",
    model: "gemma-4-26b",
    timeoutMs: 30000,
  },
});

const result = await safeExternalLlm({
  dpo,
  prompt: "Max Mustermann von WHITESTAG schreibt …",
  targetLlm: "claude-opus-4-7",
  agent: "ceo",
  externalCall: async (anonPrompt) => callClaude(anonPrompt),
});

if (result.blocked) {
  // umformulieren oder abbrechen
} else {
  console.log(result.text);
}
```

## Architektur

Zweistufige Pipeline:
1. **Regex-Detektoren** (deterministisch): E-Mail, Telefon-DE, IBAN, BIC, USt-IdNr., Steuernummer, PLZ, URL
2. **Gemma-Klassifikator** (LLM via LM Studio): Personen, Firmen, Orte, Geschäftsgeheimnisse (Umsätze, Margen, Preise, Gehälter, Kundenbeziehungen), Art-9-Daten

Bei Art-9-Daten (Gesundheit, Religion, Biometrie, …) wird die Anfrage **blockiert** — kein Durchreichen an das Public-LLM.

Fail-Closed: Wenn LM Studio nicht erreichbar ist, wird die Anfrage ebenfalls blockiert (`reason: "dpo_unavailable"`) — keine Durchreiche ungesicherter Prompts.

## Build & Test

```bash
cd paperclip-dpo
pnpm install
pnpm build
pnpm test
```

Opt-in Integration-Test mit echtem Gemma:
```bash
DPO_INTEGRATION=1 LM_STUDIO_MODEL="gemma-4-26b" pnpm test tests/integration.test.ts
```

## DSGVO-Bezug

- Art. 25 (Privacy by Design) — DPO ist die technische Umsetzung für externe LLM-Nutzung
- Art. 32 (Pseudonymisierung) — Kerntechnik
- Art. 28 (Auftragsverarbeitung) — Audit-Log dokumentiert Übermittlungen
- Art. 30 (Verarbeitungsverzeichnis) — Audit-Log als Datenbasis (Phase 2: automatischer Generator)
- Art. 9 (Besondere Kategorien) — Veto-Modus blockt vollständig
