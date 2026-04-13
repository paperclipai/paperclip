---
name: kb-to-wiki
description: Convert a markdown knowledge base into a browsable, searchable HTML wiki. Scans a folder tree of .md files, extracts metadata from YAML frontmatter, and renders a single-page wiki with sidebar navigation, search, dark mode, and Obsidian wiki link support. Load the sub-skill that matches your context.
compatibility: Python 3.8+, PyYAML (optional)
roles: [developer]
---

# KB-to-Wiki

Convert a markdown KB directory into a browsable, searchable HTML wiki.

## Sub-Skills

Load the sub-skill that matches your context instead of this umbrella file:

| Sub-Skill | Load When |
|---|---|
| `kb-to-wiki/generate` | Converting a KB directory to HTML wiki output |
| `kb-to-wiki/server` | Running a live dynamic server to browse the wiki |
| `kb-to-wiki/wiki-links` | Working with Obsidian `[[link]]` syntax or debugging broken links |
| `kb-to-wiki/customize` | Changing themes, dark mode, CSS, or template layout |
| `kb-to-wiki/ci` | Automating wiki generation in CI/CD pipelines |

## Files

| File | Purpose |
|---|---|
| `scripts/kb-to-wiki.py` | Main Python implementation — server + generation |
| `template.html` | Jinja2 HTML template — UI, CSS, JS, dark mode |
| `evals/evals.json` | Skill evaluation test cases |

## Quick Start

```bash
python /Users/angelhermon/.claude/skills/kb-to-wiki/scripts/kb-to-wiki.py \
  --source ~/knowledge-base \
  --output wiki.html \
  --title "My Knowledge Base" \
  --port 8000
```

Then open `http://localhost:8000`.

## CLI Options

| Option | Default | Purpose |
|---|---|---|
| `--source` | required | Path to markdown directory |
| `--output` | `wiki.html` | Output HTML filename |
| `--title` | source folder name | Wiki title |
| `--theme` | `light` | Initial theme (`light` or `dark`) |
| `--exclude` | `.git,__pycache__,.DS_Store` | Comma-separated patterns to skip |
| `--port` | `8000` | Server port |
| `--no-server` | false | Generate HTML only, skip server |
