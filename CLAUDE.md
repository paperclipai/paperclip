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

## Gelistirme Notlari
- Database: Embedded PostgreSQL, port 54329
- Server: localhost:3100
- UI: localhost:3102
- Monorepo: pnpm workspace (packages/db, packages/shared, server, ui)

## Google Workspace
gws CLI: `gws <servis> <resource> <method> [flags]`
Servisler: drive, gmail, calendar, sheets, docs, slides
Hesap: nailyakupoglu@gmail.com
