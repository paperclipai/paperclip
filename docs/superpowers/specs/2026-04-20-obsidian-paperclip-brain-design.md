# Obsidian-Paperclip-Brain — Design Spec

**Status:** Draft
**Datum:** 2026-04-20
**Autor:** Walter Schönenbröcher + Claude Code
**Bezug:** `Obsidian-Paperclip-Integration.md` (Ursprungskonzept, Teil B)

## 1. Zielsetzung

Walters Obsidian-Vault (`WHITESTAG-Vault` auf NAS, 8,1 GB, 22.939 Markdown-Dateien) soll als abrufbare Wissensbasis für Paperclip-Agenten und andere KI-Clients (Claude Code, n8n, Claude Desktop) dienen. Agenten sollen bei Bedarf thematisch relevante Notizen finden und lesen können — mit striktem, pro-Agent konfigurierbarem Zugriffsschutz.

Das Ursprungs-Konzept beschreibt zusätzlich eine bidirektionale Task-Synchronisation (Teil A). Dieses Dokument behandelt **ausschließlich Teil B (Retrieval/Brain)**. Teil A ist Folge-Spec.

## 2. Rahmenbedingungen

- **Vault-Lage:** SMB-Mount (`/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault`)
- **Vault-Inhalt:** Hoch heterogen — strukturierte Arbeitsnotizen (`AI/`, `Dokumente/`), DSGVO-relevante Personendaten (`Kontakte/`), Steuer-/Buchhaltungsdaten, private Biographie, 17k E-Mails mit eingestreuten Klartext-Passwörtern. Vollzugriff für Agenten ist ausgeschlossen.
- **Infrastruktur:** Alle Komponenten laufen lokal auf Walters Mac. Lokale LM Studio mit 96–128 GB VRAM, Postgres via Paperclip (`@paperclipai/db`).
- **Datenschutz-Anspruch:** Walter ist selbst DSB. DSGVO-Konformität ist nicht-verhandelbar.
- **Bestehende Paperclip-Hooks:** `packages/mcp-server`, `packages/plugins` sind vorhanden und nutzbar.

## 3. Architektur

### 3.1 Komponenten-Übersicht

```
NAS-Vault ──► Indexer ──► Postgres/pgvector ──► Brain-MCP-Server
(SMB ro)   (file-watch)    (chunks+embeddings)   │
                                                 ├─► Paperclip-Plugin ──► Paperclip-Agenten
                                                 ├─► Claude Code (MCP-Client)
                                                 └─► n8n / Cursor / …
```

**Fünf Komponenten:**

1. **Indexer** — Node/TS-Worker, läuft als launchd-Service. Watched den Vault per `chokidar`, parst Markdown, chunked, ruft LM Studio für Embeddings, schreibt nach Postgres.
2. **Postgres-Schema `brain`** — in Paperclips bestehender DB, eigenes Schema für saubere Trennung.
3. **Brain-MCP-Server** — Node/TS-Prozess, stateless. Exponiert Retrieval-Tools via MCP. Erzwingt ACL per DB-Query. Loggt jeden Zugriff.
4. **Paperclip-Plugin** `@whitestag/paperclip-plugin-brain` — dünner Wrapper, registriert MCP-Tools in Paperclips Tool-Registry, übersetzt Paperclip-Agent-UUIDs in ACL-Keys.
5. **ACL-Konfiguration** — Postgres-Tabelle `brain.agent_acl`. Default-Deny.

### 3.2 Begründung der Komponentengrenzen

- **Indexer und MCP-Server getrennt:** Indexer ist I/O-lastig, kann crashen/neu starten, ohne Retrieval zu beeinträchtigen. MCP-Server ist stateless und nebenläufig skalierbar.
- **Paperclip-Plugin als dünne Hülle:** Brain-Kern bleibt paperclip-agnostisch und damit wiederverwendbar (Claude Code, n8n, Cursor). Plugin-Code bleibt < 500 LOC.
- **Postgres-Schema `brain` statt separater DB:** Eine DB, ein Backup, ein Connection-Pool. Schemata trennen ausreichend.

## 4. Indexing-Pipeline

```
Vault-Datei ──► Watcher ──► Parser ──► Chunker ──► Embedder ──► DB-Writer
```

**Watcher:** `chokidar` auf SMB-Mount. Events: `add`, `change`, `unlink`. Beim Start: Full-Scan mit mtime/checksum-Diff gegen DB. Zusätzlich **stündlicher Safety-Rescan** wegen SMB-Event-Unzuverlässigkeit.

**Parser:** `gray-matter` extrahiert Frontmatter + Body. Pro Datei: `path` (relativ zur Vault-Wurzel), `folder` (Top-Level, ACL-Schlüssel), `title`, `frontmatter` (JSONB), `body_md`.

**Chunker:** 800–1200 Tokens pro Chunk, 100 Token Overlap. Respektiert Markdown-Grenzen (keine Chunks mitten in Code-Blöcken oder Listen). Jeder Chunk bekommt: `note_id`, `chunk_index`, `heading_path` (Breadcrumb der umgebenden Headings), `content`, `token_count`.

**Embedder:** HTTP-Call an LM Studio (`http://localhost:1234/v1/embeddings`), Modell **`bge-m3`** (1024 Dim, multilingual, gut für Deutsch). Batch-Size 32. Fehler → Chunk bleibt `embedded_at = NULL`, nächster Safety-Rescan holt ihn nach.

**DB-Writer:** Upsert in `brain.chunks`, transaktional pro Datei. Datei gelöscht → `DELETE FROM brain.notes WHERE path = :path` (cascaded auf Chunks).

**Harte Ausschlüsse im Indexer (vor ACL):**
- Attachments (Binärdateien)
- Dateien > 2 MB
- `.obsidian/`, `.trash/`, Dotfiles
- Kein harter Ausschluss für `E-Mails/` — aber initial per Default-ACL für keinen Agenten freigegeben

**Betrieb:** launchd-Service (wie Walters n8n). Logs nach `~/.whitestag-logs/brain-indexer.log`, PID in `~/.whitestag-pids/`. Indexer hat **ausschließlich Lese-Zugriff** auf den Vault (per Design, ggf. zusätzlich per Mount-Option `ro`).

**Erstindex-Aufwand:** ~22k Dateien × ~3 Chunks × ~50 ms Embedding ≈ **1 h** einmalig, danach nur Deltas.

## 5. Retrieval und ACL

### 5.1 MCP-Tool-Surface

```
search_vault(query: string, agent_id: string, limit?: int = 8, folder_filter?: string[])
  → [{ path, title, heading_path, content, score, folder, frontmatter }]

get_note(path: string, agent_id: string)
  → { path, title, frontmatter, body_md }

list_scope(agent_id: string)
  → { allowed_folders: [...], note_count: int }
```

### 5.2 Retrieval-Flow

1. **ACL-Lookup** — `SELECT allowed_folders FROM brain.agent_acl WHERE agent_id = :agent_id`. Kein Eintrag → leeres Array → Default-Deny.
2. **Query-Embedding** — LM Studio `bge-m3` auf den Query-String.
3. **Vector-Search mit ACL-Filter in einer Query:**
   ```sql
   SELECT c.*, 1 - (c.embedding <=> :qvec) AS score
   FROM brain.chunks c
   JOIN brain.notes n ON n.id = c.note_id
   WHERE n.folder = ANY(:allowed_folders)
     AND (n.frontmatter->>'agent_exclude' IS NULL
          OR NOT (n.frontmatter->'agent_exclude' ? :agent_id))
   ORDER BY c.embedding <=> :qvec
   LIMIT :limit * 3;
   ```
4. **Rerank & Dedupe** — mehrere Chunks derselben Notiz: beste behalten, Notizen mit mehreren Treffern leicht boosten, auf `limit` kürzen.
5. **Response-Trimming** — max. 800 Tokens Content pro Chunk. Für vollständige Notiz: `get_note` nachrufen.

### 5.3 ACL-Ebenen

Drei Ebenen, alle default-deny, alle im MCP-Server erzwungen:

**Ordner-Level (primär):** `agent_acl.allowed_folders` pro Agent.
```yaml
CEO:      [AI, Dokumente, Marketing, Pressemitteilungen, Analysen]
CTO:      [AI, Dokumente]
DSB:      [Kontakte, Buchhaltung, Dokumente]   # Compliance-Agent
Default:  []                                    # neuer Agent bis zur Freigabe nichts
```

**Frontmatter-Override (Einzelnotiz):**
- `agent_exclude: [CEO, CTO]` blockt Notiz auch innerhalb eines erlaubten Ordners.
- `agent_include: [CEO]` gibt Notiz eines nicht-whitelisteten Ordners gezielt frei (Phase 2).

**`get_note`-Pfad-Check:** Vor jedem direkten Notiz-Zugriff gleicher ACL-Check.

### 5.4 Authentifizierung

Bearer-Token im MCP-Header. Ein Token pro Client mit zugeordnetem Default-`agent_id`:
- `BRAIN_PAPERCLIP_TOKEN` — Paperclip-Plugin, überschreibt `agent_id` per Call
- `BRAIN_CLAUDE_CODE_TOKEN` — Claude Code, fester `agent_id = "walter"` (Eigentümer)
- `BRAIN_N8N_TOKEN` — n8n-Workflows, `agent_id` je nach Workflow-Kontext

Tokens in Paperclips bestehendem Secret-Mechanismus (SecretStorage).

### 5.5 Audit-Log

Jeder `search_vault`/`get_note`/`list_scope`-Call landet in `brain.access_log` mit: `ts`, `agent_id`, `tool`, `query`, `path`, `returned_paths`, `latency_ms`, `ok`. Relevant für DSGVO-Auskunftsersuchen und Compliance-Reports.

## 6. Datenmodell

Eigenes Schema `brain` in Paperclips Postgres. Vier Tabellen.

```sql
-- 6.1 Eine Zeile pro Vault-Datei
CREATE TABLE brain.notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path          TEXT UNIQUE NOT NULL,
  folder        TEXT NOT NULL,
  title         TEXT,
  frontmatter   JSONB NOT NULL DEFAULT '{}',
  mtime         TIMESTAMPTZ NOT NULL,
  size_bytes    INT NOT NULL,
  indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum      TEXT NOT NULL
);
CREATE INDEX ON brain.notes (folder);
CREATE INDEX ON brain.notes USING GIN (frontmatter);

-- 6.2 Eine Zeile pro Chunk
CREATE TABLE brain.chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id       UUID NOT NULL REFERENCES brain.notes(id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,
  heading_path  TEXT[],
  content       TEXT NOT NULL,
  token_count   INT NOT NULL,
  embedding     vector(1024),
  embedded_at   TIMESTAMPTZ,
  UNIQUE (note_id, chunk_index)
);
CREATE INDEX ON brain.chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON brain.chunks (note_id);

-- 6.3 ACL pro Agent
CREATE TABLE brain.agent_acl (
  agent_id           TEXT PRIMARY KEY,
  allowed_folders    TEXT[] NOT NULL DEFAULT '{}',
  description        TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.4 Audit-Log
CREATE TABLE brain.access_log (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_id       TEXT NOT NULL,
  tool           TEXT NOT NULL,
  query          TEXT,
  path           TEXT,
  returned_paths TEXT[],
  latency_ms     INT,
  ok             BOOLEAN NOT NULL
);
CREATE INDEX ON brain.access_log (ts);
CREATE INDEX ON brain.access_log (agent_id, ts);
```

**Design-Entscheidungen:**

- `notes.checksum` (SHA-256 über Body) verhindert unnötiges Re-Embedding bei bloßen `mtime`-Änderungen.
- `chunks.embedded_at NULL` = Retry-Queue ohne Zusatz-Tabelle.
- HNSW-Index auf `embedding` für O(log n) Similarity-Search — bei ~70k Chunks Pflicht.
- `access_log` mit BIGSERIAL (natürliche Ordnung, linear wachsend).
- `ON DELETE CASCADE` Chunks → Notes.
- `frontmatter` als JSONB mit GIN-Index für spätere Tag-Filter ohne Schema-Änderung.

**Bewusst weggelassen:**
- Keine separate `embeddings`-Tabelle (1:1 mit Chunks).
- Keine Chunk-Versionierung (Modell-Wechsel = Full-Re-Embed).

## 7. Paperclip-Plugin-Wrapper

**Paket:** `@whitestag/paperclip-plugin-brain` im `packages/plugins/`-Workspace. Scaffolding gemäß `paperclip-create-plugin`-Skill.

**Registrierte Tools (in Paperclips Tool-Registry):**
- `vault.search` → intern `search_vault(query, agent_id=currentAgent, …)`
- `vault.get_note` → intern `get_note(path, agent_id=currentAgent)`
- `vault.list_scope` → intern `list_scope(agent_id=currentAgent)`

**Agent-ID-Brücke (Kern-Aufgabe des Plugins):** Paperclip identifiziert Agenten per UUID, der MCP-Server erwartet ACL-Keys (`CEO`, `CTO`, `DSB`). Mapping per Plugin-Config:

```yaml
agent_id_map:
  "82729ae0-...": CEO
  "<cto-uuid>":    CTO
  "<dsb-uuid>":    DSB
mcp_endpoint: "http://localhost:7777"
bearer_token_env: BRAIN_PAPERCLIP_TOKEN
```

Fehlendes Mapping → `agent_id = "unknown"` → ACL-Lookup leer → Default-Deny.

**UI-Oberfläche (Plugin-Settings-Tab in Paperclip):**
- Status-Anzeige: MCP-Server erreichbar, letzter Index-Zeitpunkt
- ACL-Editor (Phase 2): welcher Agent darf welche Ordner lesen
- Audit-Log-Viewer: letzte N Einträge, filterbar nach Agent
- Re-Index-Button: triggert Full-Scan

**Bewusst nicht im Plugin:**
- Kein eigenes Retrieval, kein Embedding, keine DB-Verbindung.
- Keine ACL-Entscheidungen — ausschließlich im MCP-Server.

## 8. Security, Privacy, DSGVO

### Risiko 1: Unautorisierter Daten-Zugriff
- Default-Deny-ACL: neuer Agent = leeres `allowed_folders`.
- ACL-Filter in der DB-Query, nicht im App-Code (belt & braces).
- Frontmatter-Overrides als zweite Linie für hochsensible Einzelnotizen.
- `get_note` nutzt denselben ACL-Check wie `search_vault`.

### Risiko 2: Passwort-Leak aus E-Mail-Notizen
- `E-Mails/` initial für keinen Agenten freigegeben.
- Freigabe künftig nur für DSB/Eigentümer, nie für kundenorientierte Agenten.
- Phase 2: Secret-Scanner im Indexer markiert Chunks mit `contains_secret = true`; ACL kann zusätzlich "no secrets" filtern.

### Risiko 3: DSGVO-Personendaten in Cloud-LLMs
- Embeddings ausschließlich lokal (LM Studio, `bge-m3`) — keine Cloud-Embedding-API.
- **Retrieval-Ergebnisse fließen in den Agenten-Prompt.** Cloud-Agenten (Anthropic-API) senden diese Chunks zu Anthropic. Das ist der kritische Punkt.
- **Konsequenz:** ACL muss zusätzlich zur Rolle auch die LLM-Landeszone widerspiegeln. Phase 2 ergänzt `agent_acl.cloud_allowed BOOLEAN DEFAULT false` und eine konfigurierbare `sensitive_folders`-Liste. MCP-Server verweigert bei `cloud_allowed=false` + `folder in sensitive_folders`. Doppelte Sicherheit zusätzlich zur Whitelist.

### Risiko 4: Bearer-Token-Leak
- Tokens in Environment-Variablen über Paperclips Secret-Mechanismus (SecretStorage), nie im Git.
- Ein Token pro Client für Rotation und Audit-Zuordnung.

### Risiko 5: Audit-Lücken bei DSGVO-Auskunft
- `brain.access_log` speichert jeden Call. Retention: unbegrenzt im MVP, Phase 2 rotiert nach 1 Jahr.
- Query für Auskunftsersuchen: `query ILIKE '%name%'` + `returned_paths` liefern Nachweis, was gesucht und geliefert wurde.
- Phase 2: Monatlicher Compliance-Report-Job (cron oder n8n) → Markdown nach `Buchhaltung/DSGVO-Reports/`.

### Risiko 6: Vault-Korruption durch Indexer-Bug
- Indexer hat ausschließlich Lese-Zugriff. Keine Schreib-Operation in den Vault. Wird per Design erzwungen (read-only open), optional zusätzlich per Mount-Option.

### DSGVO-Verarbeitungsverzeichnis
Das System ist eine Verarbeitungstätigkeit nach Art. 30 DSGVO (personenbezogene Daten in `Kontakte/`, mittelbar in `E-Mails/`). VVZ-Eintrag ab MVP-Tag 1 erforderlich; Draft via `whitestag-dsgvo`-Skill im Implementations-Plan.

## 9. MVP-Scope und Phasen

### 9.1 MVP (Phase 1) — "Brain funktioniert end-to-end für einen Agenten"

**Erfolgsmaß:** Walter ruft in Paperclip den CEO-Agenten auf, fragt "Was weiß ich über LM Studio?" und bekommt eine Antwort, die aus den Notizen in `AI/` sinnvolle Zitate zieht. Audit-Log enthält den Call mit Timestamp, Query und gelieferten Pfaden.

**Umfang:**
- Indexer als launchd-Service (Full-Scan + Delta-Watcher + stündlicher Safety-Rescan)
- Postgres-Schema `brain` mit 4 Tabellen, pgvector-Extension aktiv
- MCP-Server mit `search_vault`, `get_note`, `list_scope`; Bearer-Token-Auth; Audit-Log
- Paperclip-Plugin `@whitestag/paperclip-plugin-brain` mit 3 Tools und Agent-ID-Mapping
- ACL konfiguriert für CEO: `[AI, Dokumente]`; alle anderen Default-Deny
- Minimal-UI im Plugin-Settings-Tab: Status, Re-Index-Button, letzte 20 Log-Einträge (read-only)

**Explizit nicht im MVP:**
- ACL-Editor-UI (direkter SQL-Insert im MVP)
- Secret-Scanner
- DSGVO-Compliance-Reports
- `cloud_allowed`-Feld
- Hybrid-Search (BM25)
- Cross-Encoder-Reranking
- Streaming-Responses

**Aufwand:** ca. 3–5 fokussierte Arbeitstage.

### 9.2 Phase 2 — "Produktionstauglich für mehrere Agenten"

- ACL-Editor-UI im Plugin-Settings-Tab
- `agent_acl.cloud_allowed` + `sensitive_folders`-Konfiguration → Cloud-Agenten sehen keine Personendaten
- DSB-Agent konfiguriert (darf `Kontakte/`, `Buchhaltung/` — cloud-gesperrt)
- Monatlicher DSGVO-Compliance-Report-Job
- Secret-Scanner im Indexer (Pattern-Matching für Passwörter/Tokens)
- VVZ-Eintrag (via `whitestag-dsgvo`-Skill)
- Log-Retention: 1-Jahres-Rotation

### 9.3 Phase 3 — "Brain-Power-Features"

- Hybrid-Search (BM25 via Postgres tsvector) + Rerank-Fusion mit Embeddings
- Cross-Encoder-Reranking für Top-k (z.B. `bge-reranker-v2-m3`)
- Strukturierte Frontmatter-Queries (Dataview-ähnlich)
- Schreibender Modus: `append_to_note(path, content)` für Recherche-Agenten, die das Brain füttern
- Brücke zur Task-Sync-Integration (Teil A des Ursprungskonzepts) — baut auf Brain-Index auf
- Streaming-Responses für lange `get_note`-Calls
- Multi-Embedding-Versionierung für A/B-Modell-Vergleiche

## 10. Offene Fragen für Implementations-Plan

Diese Punkte bleiben dem Implementations-Plan überlassen (keine Blocker fürs Design):

- Konkreter MCP-Server-Port und Service-Name
- Genaues launchd-Plist-Layout (orientiert an Walters n8n-Setup)
- Pgvector-Extension-Installation in der bestehenden Paperclip-Postgres
- Paperclip-Plugin-SDK-Version und genauer Registrierungs-Mechanismus (Skill-Ref)
- Konkrete UUID-zu-Name-Mappings für Walters aktuelle Agenten
- Test-Strategie (Integration-Tests mit kleinem Test-Vault, ACL-Negative-Tests)

## 11. Referenzen

- Ursprungskonzept: `Obsidian-Paperclip-Integration.md` (Projekt-Root)
- Paperclip-Plugin-SDK: Skill `paperclip-create-plugin`
- Paperclip-MCP-Server: `packages/mcp-server/`
- DSGVO-Skill: `whitestag-dsgvo`
- Walters Tool-Startup: `~/Desktop/n8n.sh`, `~/.whitestag-pids/`, `~/.whitestag-logs/`
