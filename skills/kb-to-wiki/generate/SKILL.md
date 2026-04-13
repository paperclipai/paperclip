---
name: kb-to-wiki/generate
description: Core wiki generation workflow — scan a markdown directory, extract YAML frontmatter metadata, and render a single-page HTML wiki. Use this when converting a KB directory to an HTML output file.
roles: [developer]
---

# KB-to-Wiki: Generate

Convert a markdown directory into a single-page HTML wiki.

## When to Use

- Convert a local KB (Obsidian vault, docs folder, knowledge-base/) to shareable HTML
- Re-generate a wiki after source files changed
- Generate HTML only (no live server) for deployment

## Run

```bash
python /Users/angelhermon/.claude/skills/kb-to-wiki/scripts/kb-to-wiki.py \
  --source ~/knowledge-base \
  --output wiki.html \
  --title "My Knowledge Base" \
  --no-server
```

## How It Works

1. **Scan** — Recursively walks `--source` dir for `.md` files; skips `--exclude` patterns
2. **Extract** — Parses YAML frontmatter (`title`, `description`, `tags`); falls back to first H1 then filename
3. **Build tree** — Constructs folder hierarchy for sidebar navigation
4. **Render** — Injects tree + content API into `template.html` → outputs single HTML file

## Metadata Extraction

Files can include YAML frontmatter (optional):

```yaml
---
title: Deployment Architecture
description: How services are deployed across regions
tags: [deployment, kubernetes]
---

# Deployment Architecture
```

Fallback order: `frontmatter.title` → first H1 heading → filename (title-cased, hyphens → spaces)

## Directory Structure → Sidebar

```
knowledge-base/
├── projects/
│   ├── overview.md          → sidebar item under "projects/"
│   └── deployment/
│       └── architecture.md  → sidebar item under "projects/deployment/"
├── topics/
│   └── agentic-workflow.md
```

Nested folders render as collapsible sidebar sections.

## Python API

```python
from kb_to_wiki import KBWiki

wiki = KBWiki(source_dir="/path/to/kb")
wiki.scan()
wiki.render(output_file="wiki.html", theme="dark")
```

## Examples

### Obsidian vault
```bash
python scripts/kb-to-wiki.py \
  --source ~/Obsidian/My\ Vault \
  --output ~/public/wiki.html \
  --title "My Knowledge" \
  --exclude "Templates,Archive" \
  --no-server
```

### Exclude hidden and build directories
```bash
python scripts/kb-to-wiki.py \
  --source docs/ \
  --exclude ".env,node_modules,__pycache__" \
  --no-server
```

## Limitations

- Single-page HTML — no separate URL routes
- Client-side search is O(n) — fine for ~500 files, sluggish at 10k+
- Images/links must use relative paths
- No full-text indexing backend
