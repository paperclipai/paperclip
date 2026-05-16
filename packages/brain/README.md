# Obsidian Brain (`@paperclipai/brain`)

Das **Obsidian Brain** macht Walters lokales Obsidian-Vault (`WHITESTAG-Vault`, ~7.000 Markdown-Dateien) als semantisch durchsuchbare Wissensbasis für Paperclip-Agenten, Claude Code, n8n und andere MCP-Clients verfügbar — mit pro-Agent konfigurierbaren Zugriffsrechten, vollständigem Audit-Log und ausschließlich lokal gerechneten Embeddings.

> **Bedienungsanleitung**: siehe [docs/ANLEITUNG.md](./docs/ANLEITUNG.md)
> **Design-Spec**: `docs/superpowers/specs/2026-04-20-obsidian-paperclip-brain-design.md`

## 1. Funktionsumfang

### Was das Brain kann
- **Semantische Suche** über alle Vault-Notizen anhand natürlich-sprachlicher Anfragen (z.B. „Was weiß ich über LM Studio?").
- **Direkter Notiz-Abruf** über den Vault-Pfad — der Agent bekommt den vollen Markdown-Body inkl. Frontmatter.
- **Scope-Auflistung** — ein Agent kann fragen, welche Ordner er einsehen darf und wie viele Notizen das umfasst.
- **Pro-Agent-ACL** mit Default-Deny — neuer Agent sieht nichts, bis er explizit Ordner-Zugriff bekommt.
- **Frontmatter-Override** — einzelne Notizen können per Frontmatter `agent_exclude:` von bestimmten Agenten gesperrt werden, auch innerhalb eines erlaubten Ordners.
- **Vollständiges Audit-Log** — jeder Tool-Call landet in `brain.access_log` (Zeitstempel, Agent, Tool, Query, gelieferte Pfade, Latenz). Verwertbar für DSGVO-Auskunftsersuchen.
- **Inkrementelles Indexieren** — Datei-Änderungen werden via Filesystem-Watcher in Sekunden in der DB aktualisiert; SHA-256-Checksum verhindert unnötiges Neu-Embedden.
- **Stündlicher Safety-Rescan** — falls SMB-Mount-Events verloren gehen, holt ein zyklischer Full-Scan jede Änderung nach.

### Was das Brain (bewusst) **nicht** kann
- Keine Cloud-Embeddings — alles läuft lokal über LM Studio, weil der Vault DSGVO-relevante Personendaten enthält.
- Kein Schreibzugriff in den Vault — der Indexer öffnet Dateien ausschließlich lesend.
- Keine Hybrid-Search (BM25+Embeddings), kein Reranker, keine Streaming-Responses → das ist Phase 3.
- Keine eingebaute ACL-Editor-UI — Berechtigungen werden derzeit per SQL oder Seed-Script gesetzt → Phase 2.

## 2. Architektur in einem Bild

```
NAS-Vault ──► Indexer ──► Postgres(brain) ──► MCP-Server ──► Paperclip-Plugin ──► CEO-Agent
(SMB ro)  (file-watch)   (chunks+vectors)    (HTTP+Bearer)   (Tool-Registry)
                              ▲                    │
                              └─ pgvector (1024d) ─┘
                              ▲
            LM Studio (bge-m3) ─ Embeddings
```

**Fünf Bausteine, alle lokal, alle als macOS-Background-Service:**

| # | Komponente | Rolle | Prozess |
|---|---|---|---|
| 1 | **Indexer** (`src/indexer/`) | Datei-Watch, Markdown parsen, chunken, embedden, in DB schreiben | `launchctl com.whitestag.brain-indexer` |
| 2 | **Postgres-Schema `brain`** | 4 Tabellen: `notes`, `chunks` (mit vector(1024)), `agent_acl`, `access_log` | Homebrew Postgres 18, DB `paperclip_brain` |
| 3 | **MCP-Server** (`src/mcp-server/`) | HTTP-Endpunkt mit Bearer-Auth, ACL-Filter, Audit-Log | `launchctl com.whitestag.brain-mcp`, Port 7777 |
| 4 | **Paperclip-Plugin** `@whitestag/paperclip-plugin-brain` | Registriert 3 Tools in Paperclips Tool-Registry, mappt Agent-UUIDs auf ACL-Keys | Plugin-Worker im Paperclip-Server |
| 5 | **LM Studio** | Embedding-Modell `text-embedding-bge-m3` (1024 Dimensionen) | LM Studio Desktop, Port 1234 |

## 3. Datenmodell (vereinfacht)

```sql
brain.notes        -- eine Zeile pro Vault-Datei
   id, path, folder, title, frontmatter (jsonb), mtime, sha256, ...

brain.chunks       -- 4-5 Zeilen pro Notiz
   note_id, chunk_index, heading_path, content, embedding vector(1024)
   INDEX hnsw (embedding vector_cosine_ops)

brain.agent_acl    -- Whitelist pro Agent
   agent_id PK, allowed_folders text[], description

brain.access_log   -- vollständiges Zugriffs-Audit
   ts, agent_id, tool, query, returned_paths, latency_ms, ok
```

## 4. Die drei Agent-Tools

Alle drei Tools sind über das Paperclip-Plugin als `whitestag.brain:vault.*` erreichbar und werden vom MCP-Server gegen `brain.agent_acl` und `frontmatter.agent_exclude` gefiltert.

| Tool | Eingabe | Ausgabe | Wann nutzen? |
|---|---|---|---|
| `vault.search` | `query`, optional `limit`, `folderFilter` | Top-N Treffer mit Score, Heading-Pfad, Excerpt | Wissens-Recherche, Kontext zu einem Thema einsammeln |
| `vault.get_note` | `path` | Vollständiger Notiz-Body inkl. Frontmatter | Nach Treffer aus `vault.search` die ganze Notiz lesen |
| `vault.list_scope` | — | `{ allowedFolders, noteCount }` | Diagnose: was darf der Agent gerade einsehen? |

## 5. Sicherheit & DSGVO

- **Default-Deny** — neuer Agent ohne ACL-Zeile sieht nichts.
- **Lokale Embeddings** — der Vault verlässt nie den Mac.
- **Bearer-Token-Auth** zwischen Plugin und MCP-Server, ein Token pro Client (Paperclip / Claude Code / n8n). Jeder Token ist an eine **agentId-Allowlist** gebunden: `BRAIN_CLAUDE_CODE_TOKEN` darf nur als `walter` auftreten, `BRAIN_N8N_TOKEN` nur als `n8n`. Nur der Paperclip-Token darf mehrere agentIds claimen (per `BRAIN_PAPERCLIP_ALLOWED_AGENTS=CEO,CFO,CMO,CTO,CPO,walter`) — kontrolliert das Multi-Agent-Routing innerhalb von Paperclip, verhindert aber Cross-Token-Impersonation.
- **Audit-Log** für alle Tool-Calls, abrufbar für Auskunftsersuchen.
- **Frontmatter-Override** für hochsensible Einzelnotizen.
- **Indexer ist read-only** — keine Schreib-Operation kann den Vault korrumpieren.

Phase 2 ergänzt: `cloud_allowed`-Flag pro Agent (verhindert, dass Cloud-LLMs jemals Personendaten als Kontext bekommen), Secret-Scanner im Indexer, Monatsreports.

## 6. Verzeichnis-Struktur

```
packages/brain/
├── src/
│   ├── shared/         # Typen + Config-Loader (zod)
│   ├── db/             # drizzle-Schema, Client, Migrate-Skript, Query-Helper
│   ├── indexer/        # Parser, Chunker, Embedder, DB-Writer, Watcher, Main
│   └── mcp-server/     # ACL, Audit, Tools, Auth, HTTP-Main
├── test/               # 44 vitest cases inkl. Live-E2E gegen LM Studio
├── launchd/            # 2 plists + Setup-README
├── scripts/            # ACL-Seed-Script
├── docs/
│   └── ANLEITUNG.md    # Bedienungsanleitung
└── README.md           # dieses Dokument

packages/plugins/brain/
├── src/                # Paperclip-Plugin (manifest, worker, agent-mapping, mcp-client, ui)
└── test/               # 7 vitest cases auf agent-mapping
```

## 7. Status & Verifikation

- ✅ Produktiv im Einsatz seit 2026-04-26 (8 Commits auf `master`, beide launchd-Services aktiv).
- ✅ Erstindex über den echten Vault: ~7.000 Notizen, ~31.000 Chunks, in der `paperclip_brain`-DB persistiert.
- ✅ End-to-End-Suchlatenz ~275 ms (Embedding + ACL + Vector-Search + Dedup).
- ✅ Zwei CEO-Agenten in Paperclip via `agentMap` ans Brain angebunden, Tool-Registry zeigt 3 Tools.
- ✅ 51 Vitest-Cases grün (44 Brain + 7 Plugin).
