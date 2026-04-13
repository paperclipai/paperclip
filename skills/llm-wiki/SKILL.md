---
name: llm-wiki
description: Persistent markdown wiki maintenance — INGEST sources, QUERY with citations, LINT for drift, LEARNINGS capture. Vault at ~/knowledge-base/.
version: 1
created: 2026-04-07
uses: 21
roles: [all]
---

# LLM Wiki

Persistent markdown wiki maintenance for the Obsidian vault at `~/knowledge-base/`. The LLM handles bookkeeping (routing, cross-linking, contradiction detection, index maintenance) so the human only needs to provide source material and ask questions.

## What I do

Maintain a living wiki by absorbing source documents, answering questions with citations, auditing the KB for drift, and continuously capturing session insights and surfacing relevant KB context during work sessions.

## When to use me

- User says "ingest this", "add to wiki", "log this to KB"
- User pastes a document, article, transcript, or links to one
- User asks a question that should be answerable from the knowledge base
- User says "lint the wiki", "check the KB", or "find stale pages"
- End of any significant working session — capture what was discovered
- Start of any session touching a known project/topic — surface what the KB already knows
- Any moment a non-obvious pattern, preference, or discovery becomes apparent during work

---

## Vault Layout

```
~/knowledge-base/
  projects/          # Project-specific wiki pages
  topics/            # Domain knowledge
  tools/             # Tool and technique pages
  raw/               # Immutable source documents (never edit)
  index.md           # Content-oriented navigation (updated on every ingest)
  log.md             # Append-only ingest/operation log
```

**Invariants:**
- `raw/` sources are never edited after placement
- `log.md` entries are never deleted or modified
- `index.md` is updated after every INGEST

---

## Operation: INGEST

**Triggered by:** "ingest this", "add to wiki", "log this to KB", or when the user provides a source document (paste, file path, or URL).

### Steps

**1. Place the source in `raw/`**

Save the source as an immutable file with a timestamped name:

```
raw/YYYY-MM-DD-<slug>.md
```

Where `<slug>` is a short kebab-case description of the content. If the source is a URL or external doc, save the full text content.

**2. Read the source thoroughly**

Read the entire source before touching any wiki pages. Note:
- Core claims and arguments
- Named techniques, patterns, tools, or systems
- Dates, version numbers, and other precision-sensitive facts
- Relationships between concepts

**3. Identify affected wiki pages**

Identify 10–15 wiki pages the source touches. For each, classify as:
- `UPDATE` — page exists and needs new content, corrections, or cross-references
- `CREATE` — topic doesn't exist yet; needs a new page

Prefer updating existing pages over creating new ones unless the topic is genuinely absent.

**4. Update each page**

For each `UPDATE` page:
- Add or revise the `## Summary` section if the source changes the understanding
- Add new facts, examples, or nuance under the relevant heading
- Add a cross-reference under `## See Also` using Obsidian wikilinks: `[[topics/ai-tools/tool-roles]]`
- If the source contradicts something already in the page, add a `## Contradictions` subsection

For each `CREATE` page:
- Follow the page creation convention (see below)
- Write a `## Summary` section
- Add `## See Also` with wikilinks to related pages
- Add the new page to `index.md`

**5. Append to `log.md`**

```markdown
## YYYY-MM-DD — <source slug>

- **Source:** `raw/YYYY-MM-DD-<slug>.md`
- **Pages updated:** [[path/to/page1]], [[path/to/page2]], ...
- **Pages created:** [[path/to/new-page]] (if any)
- **Key changes:** Brief bullet list of what changed and why it mattered
```

**6. Update `index.md`**

If any pages were created, add them to `index.md` under the correct section.

---

## Operation: QUERY

**Triggered by:** User asks a question that should be answerable from the knowledge base.

### Steps

**1. Identify relevant wiki pages**

Search `projects/`, `topics/`, and `tools/` using grep and glob. Search on key nouns, synonyms, project/tool names. Read `## Summary` sections first; only read full pages when the summary is insufficient.

**2. Synthesize the answer**

Write a direct answer. Inline every claim with a citation:

```
[→ topics/ai-tools/tool-roles]
```

**3. Offer to save new insight**

After answering, check: did the synthesis produce an insight not captured in any single wiki page? If yes, offer to save it — but do NOT save without explicit user confirmation.

---

## Operation: LINT

**Triggered by:** "lint the wiki", "check the KB", or "find stale pages".

### Steps

**1. Load the page index**

Read `index.md` or glob `**/*.md` across `projects/`, `topics/`, `tools/`.

**2. Scan for four issue types**

- **Contradictions:** Two pages making incompatible factual claims
- **Stale claims:** Time-bound facts more than 6 months old
- **Orphaned pages:** Pages not linked from any other page
- **Missing cross-references:** Pages discussing the same entity without linking to each other

**3. Produce the lint report**

```
## Contradictions
- [[page-a]] vs [[page-b]]: "<claim in a>" contradicts "<claim in b>"

## Stale Claims
- [[page]]: "<dated claim>" — last updated YYYY-MM-DD

## Orphaned Pages
- [[page]]: not linked from any other page

## Missing Cross-References
- [[page-a]] mentions <X> but doesn't link to [[page-b]] which covers <X>
```

**4. Ask before fixing**

Only proceed with fixes the user explicitly approves.

---

## Page Creation Convention

**Placement:**
- `projects/<project-name>/<page>.md` — project-specific knowledge
- `topics/<domain>/<page>.md` — domain or conceptual knowledge
- `tools/<tool-name>.md` — tool or technique pages

**Filename:** lowercase-with-hyphens.md

**Required sections:**

```markdown
# <Title>

## Summary
One paragraph. What this is, what problem it solves, and why it matters.

## <Content sections as appropriate>

## See Also
- [[relative/path/to/related-page]]
```

**After creating:** add the page to `index.md`.

---

## Cross-Reference Format

Always use Obsidian wikilinks with vault-relative paths (no leading slash):

```
[[topics/ai-tools/tool-roles]]
[[projects/execution-ui/overview]]
[[tools/yt-dlp]]
```

In query answers, use the citation arrow format:

```
[→ topics/ai-tools/tool-roles]
```

---

## Operation: LEARNINGS

**Two modes:** proactive retrieval (at session start) and proactive capture (throughout and at session end).

### Mode A — Proactive Retrieval

When entering a domain that likely exists in the KB, surface what's already known before diving in. Read `## Summary` sections of relevant pages and report:

```
[KB context: <project/topic name>]
<2-4 bullet points of relevant facts with citations>
[→ projects/foo/overview for full context]
```

Do this once at session start, not repeatedly.

### Mode B — Proactive Capture

Capture insights, patterns, preferences, and discoveries as they emerge.

**What counts as a learning:**

| Category | Examples |
|---|---|
| Technical discovery | A workaround, a gotcha in a library, a pattern that solved a class of problem |
| Architectural decision | Why X was chosen over Y, tradeoffs accepted |
| User preference | Stated constraint, preferred approach, disliked pattern |
| Workflow insight | A step sequence that worked well, a tool combo that's effective |
| Failure | What was tried and didn't work, and why |
| Silent hazard | Places where things fail silently — manual sync requirements, fallback paths that activate without indication, invariants enforced only by convention |

**Steps:**

1. Identify 2–5 high-quality learnings from the session
2. Grep the KB to check if already covered
3. Write to the appropriate page following routing above
4. Append to `log.md`
5. Report briefly: one line per learning saved

---

## Invariants (never violate)

- **Raw sources are immutable.** Never edit files in `raw/`.
- **`log.md` is append-only.** Never delete, edit, or reorder existing entries.
- **Do not invent facts.** If the source doesn't say it, don't write it.
- **Cite sources in pages.** Note the raw file as a wikilink at the bottom of relevant sections.
- **Confirm before creating pages during QUERY.** Never silently write files when answering a question.
- **Prefer precision over coverage.** 5 well-written pages beat 20 thin ones.
- **Learnings are selective.** Only write things that would genuinely help future work.
