# Paperclip — AI Company Control Plane

## 3-Katman Orkestrasyon
Paperclip, EvoHaus AI holding'inin GOVERNANCE katmani:
- 380 agent (claude_local:146, gemini_local:195, openclaw-gateway:29, codex_local:10)
- 14 proje, 19 workspace
- Issue/task atama, budget, heartbeat, onay sistemi

## Diger Platformlar
- **OpenClaw** (Runtime): 39 agent, ~/.openclaw/, API: localhost:18789
- **Gemini** (Web+Gorsel): 195 agent, ~/.gemini/, CLI: gemini
- **Codex** (Paralel Uretim): 10 agent, ~/.codex/, CLI: codex
- **Claude Code** (Gelistirme): ~/.claude/, skill'ler, superpowers

## Tri-Model Consensus
Stratejik gorevlerde 3 model paralel: Opus + Codex + Gemini.
Paperclip issue sistemi ile: parent issue → 3 sub-issue → degerlendirme → teslim.

## Adapter Tipleri
| Adapter | Kullanim | Agent Sayisi |
|---------|----------|-------------|
| claude_local | Proje ekip uyesi (event-driven) | 146 |
| gemini_local | Web/gorsel uzman (skill-bazli) | 195 |
| openclaw-gateway | OpenClaw runtime agent | 29 |
| codex_local | Paralel kod uretim | 10 |

## Skill-Zeka
Merkezi beyin: zeka_match.py → top 5 skill eslestirme
Vault: ~/Documents/EvoHaus-Vault/Hafiza/zeka/

## Unified Brain — Hafiza Sistemi

### 3 Katman
| Katman | Sistem | Port | Amac |
|--------|--------|------|------|
| HOT | claude-mem (SQLite+Chroma) | 37777 | Session-level, semantic search |
| WARM | knowledge_store (PostgreSQL) | 3100 | Holding-level, FTS, agent injection |
| COLD | Vault (Markdown, Syncthing) | - | Human-readable, cross-platform |

### Knowledge Store
- Tablo: `knowledge_store` (migration 0040)
- Service: `server/src/services/knowledge.ts`
- Routes: POST/GET `/api/knowledge`, `/api/knowledge/search`, `/api/knowledge/stats`, `/api/knowledge/weekly-digest`, `/api/knowledge/bulk-import`
- Heartbeat injection: agent run'da ilgili knowledge entry'ler context'e eklenir

### Holding Roster
- `getHoldingTree()`: recursive CTE ile holding agaci
- `getHoldingRoster()`: tum agent'lari capability/adapter/status ile filtrele
- Routes: GET `/api/companies/holding/roster`, `/api/companies/holding/tree/:companyId`
- Agent kolonlari: `capability_tags[]`, `specialty`, `current_task_summary`, `availability`

### Sync Akisi (30dk)
```
Vault → claude-mem → knowledge_store
         ↑                ↑
OpenClaw bridge ──────────┘
Session hooks ────────────┘
```

### Meeting & Delegation
- `createMeeting()`: paralel agent calisma + CEO synthesis
- `createConsensus()`: tri-model (claude+codex+gemini) → synthesis
- `/issues/:id/delegate`: cross-company issue delegation

## Gelistirme Notlari
- Database: Embedded PostgreSQL, port 54329
- Server: localhost:3100
- UI: localhost:3102
- Monorepo: pnpm workspace (packages/db, packages/shared, server, ui)

## Google Workspace
gws CLI: `gws <servis> <resource> <method> [flags]`
Servisler: drive, gmail, calendar, sheets, docs, slides
Hesap: nailyakupoglu@gmail.com
