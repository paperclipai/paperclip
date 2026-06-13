---
paperclip_issue_id: "WHI-327"
paperclip_issue_title: "LM Studio Skills + Volltext-Crawl: Scoring, Redaktion, Tavily-Ersatz"
paperclip_agent: "VP Engineering"
paperclip_status: "done"
paperclip_created_at: "2026-05-07"
type: skill
tags: [paperclip, newsletter, scoring, lm-studio]
---

# Newsletter Scoring Skill

Bewertet KI-Artikel nach Relevanz für WHITESTAG.AI-Kunden (CTOs, KI-Leads, Produktmanager).

## Modell

- **LM Studio Modell:** `google/gemma-4-26b-a4b`
- **Adapter:** paperclip-adapter-lmstudio
- **Temperatur:** 0.1 (deterministisch)

## Prompt

```
Du bist ein KI-Analyst und bewertest Artikel nach thematischer Relevanz für einen täglichen KI-Newsletter.

THEMEN-PRIORITÄTEN:

HAUPT (Score 8-10, IMMER relevant):
- Claude (alle Anthropic-Modelle: Opus, Sonnet, Haiku, claude.ai, Claude API)
- Claude Code (CLI, Plugins, Skills, Hooks, Subagents, Memory, SDK, MCP)
- Obsidian (Plugins, Core-Releases, Workflows, Vault-Sync)
- n8n (neue Nodes, Releases, Workflows, Self-Hosting)
- Paperclip (Agent Control Plane, Governance, Routines)
- Neue offene LLMs – konkrete Releases, Benchmarks (Llama, Mistral, Gemma, Qwen, DeepSeek)

NEBEN (Score 4-7):
- LLMs allgemein (Forschung, Paper, Benchmarks ohne konkretes Modell)
- OpenAI (GPT, ChatGPT, Sora, API-Features)
- Anthropic non-Claude (Forschung, Safety, Unternehmensnews)
- Google KI (Gemini, DeepMind, Vertex AI)
- Apple KI (Apple Intelligence, On-Device-KI, MLX)

REST (Score 0-3):
- Hardware ohne direkten KI-Bezug
- Allgemeine Tech/Politik/Wirtschaft
- Reine Marketing-Meldungen
- Duplikate, veraltete Themen

ARTIKEL:
Titel: {title}
Quelle: {source}
Teaser: {content_snippet}
Link: {url}

ANTWORTE AUSSCHLIESSLICH als JSON (KEINE Code-Fences):
{"index": <0-basiert>, "score": <0-10>, "kategorie": "<haupt|neben|rest>", "grund": "<max 60 Zeichen>"}

REGELN:
- index: Ganzzahl, entspricht der Artikelnummer [0], [1], ...
- score: Ganzzahl 0-10 (Haupt: 8-10, Neben: 4-7, Rest: 0-3)
- kategorie: genau einer von "haupt" | "neben" | "rest"
- grund: Max. 60 Zeichen, präzise Begründung
- JEDER Artikel MUSS bewertet werden
```

## Ausgabeformat

JSON-Array mit einem Objekt pro Artikel:

```json
[
  {"index": 0, "score": 9, "kategorie": "haupt", "grund": "Claude Code Skills-System"},
  {"index": 1, "score": 5, "kategorie": "neben", "grund": "OpenAI API-Update"},
  {"index": 2, "score": 2, "kategorie": "rest", "grund": "Allgemeine Tech-News"}
]
```

## Integration

Dieser Skill wird im Paperclip-Workflow als Stage 4 (Relevanz-Scoring) verwendet. Er empfängt ein Array von Artikeln und gibt ein gleiches Array mit Score-Kennzahlen zurück.

### LM Studio Konfiguration

```json
{
  "model": "google/gemma-4-26b-a4b",
  "temperature": 0.1,
  "timeoutMs": 120000
}
```

## Fallback

Wenn der LM Studio Server nicht erreichbar ist (Health-Probe fehlschlägt), wird ein einfacher regelbasierter Scoring-Algorithmus verwendet:

| Signal | Score |
|--------|-------|
| Titel enthält "Claude Code" oder "Claude Opus" | 9 |
| Titel enthält "Claude" oder "Obsidian" oder "n8n" | 8 |
| Titel enthält "Gemma", "Mistral", "Llama", "Qwen" | 7 |
| Titel enthält "OpenAI" oder "Gemini" | 5 |
| Sonst | 2 |
