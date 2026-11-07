---
name: codebase-inspection
description: >
  Analyzes repositories for lines of code,
  language breakdown, and code-to-comment ratios.
---

# Codebase Inspection with pygount

Analyze repositories for lines of code, language breakdown, file counts, and code-vs-comment ratios using `pygount`.

## When to Use

- User asks for LOC (lines of code) count
- User wants a language breakdown of a repo
- User asks about codebase size or composition
- User wants code-vs-comment ratios
- General "how big is this repo" questions

## Prerequisites

```bash
pip install --break-system-packages pygount 2>/dev/null || pip install pygount
```

## 1. Basic Summary (Most Common)

Get a full language breakdown with file counts, code lines, and comment lines:

```bash
cd /path/to/repo
pygount --format=summary \
  --folders-to-skip=".git,node_modules,venv,.venv,__pycache__,.cache,dist,build,.next,.tox,.eggs,*.egg-info" \
  .
```

Always use `--folders-to-skip` to exclude dependency/build directories; otherwise pygount will crawl them and take a very long time or hang.

## 2. Common Folder Exclusions

Adjust based on the project type:

```bash
# Python projects
--folders-to-skip=".git,venv,.venv,__pycache__,.cache,dist,build,.tox,.eggs,.mypy_cache"

# JavaScript/TypeScript projects
--folders-to-skip=".git,node_modules,dist,build,.next,.cache,.turbo,coverage"

# General catch-all
--folders-to-skip=".git,node_modules,venv,.venv,__pycache__,.cache,dist,build,.next,.tox,vendor,third_party"
```

## 3. Detailed Output

Use `--format=detail` for per-file breakdown, or `--format=json` for machine-readable output suitable for scripting.

```bash
pygount --format=detail --folders-to-skip=".git,node_modules,venv,.venv,__pycache__,.cache,dist,build" .
pygount --format=json --folders-to-skip=".git,node_modules,venv,.venv,__pycache__,.cache,dist,build" . > codebase-metrics.json
```

## Procedure

1. Identify the repository path and project type
2. Choose appropriate `--folders-to-skip` exclusions based on project type
3. Run pygount with `--format=summary` for a quick overview
4. Use `--format=detail` or `--format=json` for deeper analysis
5. Present results: total LOC, language breakdown, file counts, code-vs-comment ratio

## Pitfalls

- Forgetting `--folders-to-skip`, causing pygount to crawl dependency directories
- Running on very large repositories without exclusions, causing hangs
- Misreading comment ratios — some languages have high comment density by convention
- Including build output or generated files in the analysis

## Verification

- [ ] pygount is installed and accessible
- [ ] `--folders-to-skip` excludes dependency/build directories
- [ ] Summary output includes language breakdown with file counts and LOC
- [ ] Code-to-comment ratio is calculated and presented
- [ ] Results match the user's specific question (LOC, language breakdown, etc.)