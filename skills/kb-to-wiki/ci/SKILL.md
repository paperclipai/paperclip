---
name: kb-to-wiki/ci
description: CI/CD integration patterns for kb-to-wiki — auto-generating wikis in pipelines, committing HTML output, and scheduling regeneration. Load this when automating wiki generation.
roles: [developer]
---

# KB-to-Wiki: CI/CD Integration

Automate wiki generation in pipelines.

## Basic Pipeline Pattern

```bash
# Install dependencies
pip install pyyaml

# Generate wiki (no server — just output file)
python .claude/skills/kb-to-wiki/scripts/kb-to-wiki.py \
  --source docs/ \
  --output public/index.html \
  --title "Project Docs" \
  --no-server

# Commit and push
git add public/index.html
git commit -m "docs: regenerate wiki"
git push
```

## GitHub Actions

```yaml
name: Regenerate Wiki

on:
  push:
    paths:
      - 'docs/**/*.md'
      - 'knowledge-base/**/*.md'

jobs:
  wiki:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: pip install pyyaml

      - name: Generate wiki
        run: |
          python .claude/skills/kb-to-wiki/scripts/kb-to-wiki.py \
            --source docs/ \
            --output public/index.html \
            --title "Project Wiki" \
            --no-server

      - name: Commit wiki
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add public/index.html
          git diff --staged --quiet || git commit -m "docs: auto-regenerate wiki [skip ci]"
          git push
```

## Azure DevOps Pipeline

```yaml
trigger:
  paths:
    include:
      - docs/**

steps:
  - task: UsePythonVersion@0
    inputs:
      versionSpec: '3.11'

  - script: pip install pyyaml
    displayName: 'Install dependencies'

  - script: |
      python scripts/kb-to-wiki.py \
        --source docs/ \
        --output $(Build.ArtifactStagingDirectory)/wiki.html \
        --title "Team Wiki" \
        --no-server
    displayName: 'Generate wiki'

  - task: PublishBuildArtifacts@1
    inputs:
      pathToPublish: '$(Build.ArtifactStagingDirectory)'
      artifactName: 'wiki'
```

## Static Hosting

The generated `wiki.html` is a single file — host anywhere:

```bash
# GitHub Pages
cp wiki.html docs/index.html

# Netlify / Vercel drop
# Just upload wiki.html — no build config needed

# S3
aws s3 cp wiki.html s3://my-bucket/wiki.html --content-type text/html
```

## Watching for Changes (Local Dev)

The `--watch` flag is not implemented in the current version. For local dev, use `entr`:

```bash
find ~/knowledge-base -name "*.md" | entr python scripts/kb-to-wiki.py \
  --source ~/knowledge-base \
  --output wiki.html \
  --no-server
```

Or use `nodemon`:

```bash
npx nodemon --watch ~/knowledge-base --ext md \
  --exec "python scripts/kb-to-wiki.py --source ~/knowledge-base --output wiki.html --no-server"
```

## Excluding Drafts in CI

```bash
python scripts/kb-to-wiki.py \
  --source docs/ \
  --exclude "Drafts,WIP,Templates,Archive,_private" \
  --no-server
```
