# LLM-Empfehlungen pro Paperclip-Agent

**Stand:** 2026-04-20
**Company:** WHITESTAG (ID `9cebf3cf-efe8-4597-a400-f06488900a87`, Prefix `WHI`)

## Verfügbare Modelle

### Public Claude (via `claude_local`-Adapter)
- **Claude Opus 4.7** — Top-Tier-Reasoning, Board-Texte, kreativ-narrativ
- **Claude Sonnet 4.6** — Default-Arbeitspferd, ausgewogen
- **Claude Haiku 4.5** — schnell, günstig, kurze Aufgaben

### Lokal Mac M4 Max (LM Studio `http://localhost:1234`)
- **qwen2.5-32b-instruct-mlx** — Code, Tool-Use, MLX-optimiert
- **google/gemma-4-26b-a4b** — Deutsch-stark, Brand-Tonalität
- **mistral-small-3.2-24b-instruct-2506** — Tool-Calling, strukturierte Outputs
- **qwen/qwen3.6-35b-a3b** — MoE-Reasoning, ebenfalls auf Mac geladen

### Lokal Windows (LM Studio `http://192.168.2.181:1234`)
- **qwen/qwen3.6-35b-a3b** — Primär-Lauf auf Windows-Kiste, entlastet den Mac

## Zuordnung pro Agent

### C-Level

| Agent | Primär-LLM | Host | Rationale |
|---|---|---|---|
| CEO | qwen/qwen3.6-35b-a3b | Mac (localhost) | Im Test-Betrieb auf lokal; Empfehlung wäre Opus 4.7 für maximale Strategie-Qualität, aber lokale Variante wird evaluiert |
| CTO | qwen/qwen3.6-35b-a3b | Mac (localhost) | Architektur-Reviews — MoE-Reasoning reicht, lokal gewünscht |
| CFO | qwen/qwen3.6-35b-a3b | Win (192.168.2.181) | Finanzen DSGVO-kritisch → lokal. MoE-Reasoning für Zahlen |
| CPO | qwen/qwen3.6-35b-a3b | Mac (localhost) | Produktvision + strukturierte Specs |
| CRO | qwen/qwen3.6-35b-a3b | Mac (localhost) | Synthese über viele Quellen, Hybrid-Thinking |
| CMO | qwen/qwen3.6-35b-a3b | Mac (localhost) | Kampagnen, Strategie; deutsche Tonalität ausreichend |
| Creative Director | qwen/qwen3.6-35b-a3b | Mac (localhost) | VR-Konzepte, kreatives Leadership |

### Engineering / Product

| Agent | Primär-LLM | Host | Rationale |
|---|---|---|---|
| VP Engineering | qwen2.5-32b-instruct-mlx | Mac (localhost) | Code + Tool-Use, lokal reicht |
| Produktentwicklung | mistral-small-3.2-24b-instruct-2506 | Mac (localhost) | Spec-Writing, strukturierte JSON/YAML |

### Marketing / Design

| Agent | Primär-LLM | Host | Rationale |
|---|---|---|---|
| Marken-Spezialist | google/gemma-4-26b-a4b | Mac (localhost) | Deutsche Brand-Sprache, WHITESTAG-CI |
| Social Media Specialist | google/gemma-4-26b-a4b | Mac (localhost) | Kurze DE-Posts, hohe Iterationsrate |
| Web-Design Specialist | qwen2.5-32b-instruct-mlx | Mac (localhost) | Frontend-Code + Design-Tokens |

### Recherche / Finanzen (DSGVO-relevant → lokal)

| Agent | Primär-LLM | Host | Rationale |
|---|---|---|---|
| Online-Recherche | qwen/qwen3.6-35b-a3b | Win (192.168.2.181) | Hybrid-Reasoning für Synthese |
| Buchhaltung | google/gemma-4-26b-a4b | Mac (localhost) | EÜR, deutsches Steuerrecht, DE-stark |
| Vermögensverwaltung | qwen/qwen3.6-35b-a3b | Win (192.168.2.181) | Portfolio-Reasoning, Finanzdaten lokal |

### Creative Production

| Agent | Primär-LLM | Host | Rationale |
|---|---|---|---|
| Drehbuch | Claude Opus 4.7 | Cloud | VR-Narrativ, Dialog-Nuancen — Opus hebt sich ab |
| Blender | qwen2.5-32b-instruct-mlx | Mac (localhost) | Python-Scripting, Add-on-Code |
| Mistika VR | qwen2.5-32b-instruct-mlx | Mac (localhost) | Technisch-präzise Stitching-Rezepte |
| Adobe | qwen2.5-32b-instruct-mlx | Mac (localhost) | ExtendScript/CEP, Code-Terrain |

## Adapter-Mapping (technisch)

| Agent | adapterType | Kernfelder |
|---|---|---|
| Drehbuch | `claude_local` | `model: "claude-opus-4-7"` |
| CEO, CTO, CPO, CRO, CMO, Creative Director | `lmstudio_local` | `url: http://localhost:1234`, `defaultModel: qwen/qwen3.6-35b-a3b` |
| VP Engineering, Web-Design, Blender, Mistika VR, Adobe | `lmstudio_local` | `url: http://localhost:1234`, `defaultModel: qwen2.5-32b-instruct-mlx` |
| Produktentwicklung | `lmstudio_local` | `url: http://localhost:1234`, `defaultModel: mistral-small-3.2-24b-instruct-2506` |
| Marken-Spezialist, Social Media, Buchhaltung | `lmstudio_local` | `url: http://localhost:1234`, `defaultModel: google/gemma-4-26b-a4b` |
| CFO, Online-Recherche, Vermögensverwaltung | `lmstudio_local` | `url: http://192.168.2.181:1234`, `defaultModel: qwen/qwen3.6-35b-a3b` |

## Test-Vorschlag

Pro Agent einen Referenz-Task als Paperclip-Issue anlegen und dreifach laufen lassen:

1. Primär-Empfehlung (oben)
2. Lokaler Fallback (bei Cloud-Primär) bzw. Sonnet 4.6 (bei lokal-Primär)
3. Haiku 4.5 als Günstig-Baseline

Ergebnisse per Issue-Kommentar vergleichen (Qualität, Latenz, Kosten).

## Bekannte Risiken

- **AGENTS.md-Instructions:** Der `lmstudio_local`-Adapter kennt das `instructionsFilePath`-Feld nicht. Agenten verlieren beim Wechsel möglicherweise ihre Persona-Instruktionen. Vor dem Flip testen.
- **Windows-Instanz muss laufen:** `192.168.2.181:1234` war zum Erstell-Zeitpunkt nicht erreichbar. CFO, Online-Recherche und Vermögensverwaltung hängen, wenn der Windows-Rechner aus ist.
- **Claude-Modell-IDs:** Der Adapter-Code listet bis 4.6. `claude-opus-4-7` wird ans CLI durchgereicht — sollte funktionieren, aber vor Produktiv-Einsatz einmal testen.
