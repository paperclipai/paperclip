# Chatverlauf 2026-04-20 — Obsidian-Vault als Paperclip-Agent-Brain

## Ausgangslage

Walter wollte sein Obsidian als "Gehirn" an Paperclip anbinden, damit die Agenten bei Bedarf darauf zugreifen können. Das bereits vorliegende Konzept-Dokument `Obsidian-Paperclip-Integration.md` beschrieb jedoch nur Task-Sync (Issues ↔ Vault) — nicht Retrieval/Brain. Die eigentliche Intention war also eine andere Architektur.

## Vorgehen

Die Session lief als strukturiertes Brainstorming (Skill `superpowers:brainstorming`), dann Plan-Erstellung (Skill `superpowers:writing-plans`):

1. **Scope-Klärung** — zwei Intentionen identifiziert: (A) Task-Sync [laut Konzept], (B) Agent-Brain [Walters Aussage]. Entscheidung: beides, aber B zuerst.

2. **Vault-Analyse** — Walter gab den SMB-Pfad (`/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault`). Befund:
   - 8,1 GB, **22.939 Markdown-Dateien**
   - Größte Ordner: `E-Mails/` (17.630 Dateien), `Kontakte/` (1.397), `Buchhaltung/` (811)
   - Sensibles durchmischt mit Geschäft (E-Mails mit Klartext-Passwörtern, DSGVO-Personendaten, private Biographie)
   - Folgerung: Vollzugriff ausgeschlossen, strikte Per-Agent-ACL nötig

3. **Architektur-Entscheidungen** (per Walter):
   - **Zugriffs-Policy:** Per-Agent-Whitelist (jeder Agent bekommt spezifische Ordner freigegeben)
   - **Suchtyp:** Semantische Suche mit Embeddings
   - **Integration:** Hybrid — MCP-Server als Kern + Paperclip-Plugin als dünne Hülle
   - **Embedding-Modell:** `bge-m3` (multilingual, 1024 Dim)

4. **Design in 7 Sektionen** präsentiert und einzeln abgenommen:
   - High-Level-Architektur (5 Komponenten)
   - Indexing-Pipeline (Watcher → Parser → Chunker → Embedder → Writer)
   - Retrieval & ACL (Tool-Surface, 3 ACL-Ebenen, Audit-Log)
   - Datenmodell (4 Tabellen in `brain`-Schema)
   - Paperclip-Plugin-Wrapper
   - Security/DSGVO (6 Risiken + VVZ)
   - MVP-Scope + Phasen 2/3

5. **Spec-Dokument geschrieben und committed:**
   `docs/superpowers/specs/2026-04-20-obsidian-paperclip-brain-design.md` (337 Zeilen)

6. **Implementations-Plan geschrieben und committed:**
   `docs/superpowers/plans/2026-04-20-obsidian-paperclip-brain.md` (~2700 Zeilen, 18 TDD-Tasks in 4 Phasen)

## Kernpunkte der geplanten Lösung

**Architektur:**
```
NAS-Vault ──► Indexer ──► Postgres/pgvector ──► Brain-MCP-Server
(SMB ro)   (file-watch)    (chunks+embeddings)   │
                                                 ├─► Paperclip-Plugin ──► Paperclip-Agenten
                                                 ├─► Claude Code (MCP-Client)
                                                 └─► n8n / Cursor / …
```

**Drei MCP-Tools** für Agenten: `search_vault`, `get_note`, `list_scope`

**Default-Deny-ACL** pro Agent. MVP-Seeds:
- `CEO`: `[AI, Dokumente]`
- `walter`: weiter Zugriff (Eigentümer)
- alle anderen: leer = kein Zugriff

**DSGVO-Maßnahmen** ab MVP: Embedding lokal via LM Studio, Audit-Log jeder Zugriff, Bearer-Token-Auth, `Kontakte/` und `E-Mails/` für niemand freigegeben. In Phase 2 kommt `cloud_allowed`-Flag dazu, damit Cloud-Agenten (Anthropic-API) garantiert keine Personendaten sehen.

## Geänderte/neue Dateien in diesem Projekt

- `docs/superpowers/specs/2026-04-20-obsidian-paperclip-brain-design.md` (NEU, Commit `8ee13170`)
- `docs/superpowers/plans/2026-04-20-obsidian-paperclip-brain.md` (NEU, Commit `7914bad7`)

## Offene Punkte / Nächste Session

Morgen geht's an die Umsetzung des MVP-Plans. Vor dem ersten Task zu klären:

1. **Datenbank-Verbindung:** `DATABASE_URL` der laufenden Paperclip-Postgres ermitteln (für Migration und launchd-Plists)
2. **pgvector-Extension** installieren (falls nicht bereits aktiv): `CREATE EXTENSION vector;`
3. **Plugin-SDK-Signatur prüfen:** Task 14 hat einen Hinweis, dass `defineWorker`/`ctx` an das aktuelle SDK angepasst werden muss — kurze Referenz auf `packages/plugins/examples/plugin-hello-world-example/src/worker.ts` nehmen
4. **Entscheidung:** Execution-Modus — Subagent-Driven (fresh Subagent pro Task mit Review-Checkpoints) oder Inline-Execution mit Batch-Checkpoints

**Noch nicht angefasst (Teil A des Konzept-Dokuments):** Die bidirektionale Task-Sync zwischen Obsidian-Vault und Paperclip-Issues wird erst in Phase 3 aufgegriffen, dann auf dem Brain-Index aufsetzend.

## Skills, die zum Einsatz kamen

- `superpowers:using-superpowers` — Session-Start
- `superpowers:brainstorming` — strukturierte Design-Dialoge
- `superpowers:writing-plans` — TDD-Implementations-Plan
