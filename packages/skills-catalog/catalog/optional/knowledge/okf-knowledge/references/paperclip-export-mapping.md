# Paperclip → OKF export mapping

`okf-export.mjs` is deliberately offline: it turns a **dump JSON** into a
bundle and never calls the network. You assemble the dump from the Paperclip
API, then run the builder. This file defines the dump schema, the API calls
that populate it, and how each Paperclip source maps to an OKF concept.

All API requests use `Authorization: Bearer $PAPERCLIP_API_KEY` and the base
`$PAPERCLIP_API_URL`. Never hard-code the URL.

## Dump schema

```jsonc
{
  "company": {
    "name": "Acme Robotics",       // string
    "prefix": "ACME",              // company ticket prefix (optional)
    "description": "…",            // optional
    "exportedAt": "2026-06-14T10:00:00Z" // ISO-8601; used as the log/okf timestamp
  },
  "memories":  [ /* MemoryEntry  */ ],
  "skills":    [ /* SkillEntry   */ ],
  "decisions": [ /* DecisionEntry*/ ],
  "docs":      [ /* DocEntry     */ ],
  "sources":   [ /* SourceEntry  */ ]
}
```

Every entry array is optional — omit a section you are not exporting. Each
entry shares a common shape; only the fields that exist are emitted.

| Field | Used for |
|-------|----------|
| `title` / `name` / `identifier` / `id` | concept title + slug (first non-empty) |
| `description` / `summary` / `outcome` | concept `description` frontmatter |
| `body` / `content` | concept markdown body (verbatim) |
| `resource` / `url` | concept `resource` frontmatter (else a `paperclip:` URI is derived) |
| `tags` | concept `tags` frontmatter |
| `timestamp` / `updatedAt` / `createdAt` | concept `timestamp` frontmatter |
| `citations` | rendered as a `# Citations` section (array of strings or `{title,url}`) |

### Concept `type` by section

| Dump key | OKF dir | `type` | Derived `resource` URI |
|----------|---------|--------|------------------------|
| `memories` | `memory/` | `memory` | `paperclip:memory:<name>` |
| `skills` | `skills/` | `skill` | `paperclip:skill:<name>` |
| `decisions` | `decisions/` | `decision` | `paperclip:issue:<identifier>` |
| `docs` | `docs/` | `document` | `paperclip:document:<issue>:<key>` |
| `sources` | `sources/` | `source` | `paperclip:source:<id>` |

`DocEntry` additionally reads `issueIdentifier` and `key` (e.g. `plan`) to build
its slug `<issue>-<key>` and resource URI.

## Where each source comes from

### memories — agent memory files
Your memory lives on disk at the agent memory directory (`MEMORY.md` index plus
one file per fact, each with `name`/`description`/`metadata.type` frontmatter).
Read those files and map each to a `MemoryEntry`: `name` = slug, `title` from
the body's H1 or `description`, `type` from `metadata.type`, `body` = the fact
text. This is the most valuable knowledge to export; do it first.

### skills — company / agent skills
List skills with the company-skills API (`GET /api/companies/{companyId}/skills`
or the agent's assigned skills). For each, capture `name`, `description`, and —
if you have the SKILL.md body — the instructional `body`.

### decisions — resolved issues that recorded a decision
Search issues for resolved work that captured a decision:
`GET /api/companies/{companyId}/issues?status=done`. For each meaningful one,
pull the thread (`GET /api/issues/{id}` + `/comments`) and distil:
`identifier`, `title`, `summary` (what was decided), `outcome` (the resolution),
and `body` (the rationale). Skip routine/no-decision issues — quality over
volume.

### docs — issue documents
For issues that have documents, `GET /api/issues/{id}/documents` then
`GET /api/issues/{id}/documents/{key}`. Map `issueIdentifier`, `key`, `title`,
and the markdown `body`.

### sources — Content Machine sources
If the company uses Content Machine, list its sources and map `id`, `title`,
`url`, `description`, and any extracted `body`/notes.

## Build & verify

```bash
node scripts/okf-export.mjs dump.json ./out-bundle
node scripts/okf-validate.mjs ./out-bundle   # expect: OK … 0 error(s)
```

A worked `dump.json` lives conceptually in `sample-bundle/` — the shipped
sample bundle is the exact output of running the exporter on a representative
dump (the same one used by the unit tests).
