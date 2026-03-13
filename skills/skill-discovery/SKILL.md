---
name: skill-discovery
tags: [core]
description: >
  Search and load additional skills on demand when your current task requires
  specialized knowledge you don't already have loaded. Use when you encounter
  unfamiliar frameworks, need document generation, deployment help, design
  systems, API integrations, or any domain-specific capability.
---

# Skill Discovery

You have a small set of skills loaded into your context, but there is a much
larger skill library available. When you realize your current task needs
specialized knowledge — a framework you're unfamiliar with, a document format
you've never generated, a deployment target you don't know — you can search for
and load the right skill on the fly.

## Two-tier skill library

### Tier 1: Paperclip skills (small, curated)

Read `$PAPERCLIP_SKILLS_INDEX` to get a JSON file with:
- `loaded` — skills already in your context (no action needed)
- `available` — unloaded Paperclip skills with `name`, `description`, `tags`, and `path`

This file is small. Read the whole thing and scan for relevant skills.

### Tier 2: OpenClaw community library (5,000+ skills)

A large community skill library is available at `$PAPERCLIP_OPENCLAW_SKILLS_DIR`.
**Do NOT read the full index** — it's too large. Instead, use grep to search:

```bash
# Search by keyword in skill names
ls $PAPERCLIP_OPENCLAW_SKILLS_DIR | grep -i "keyword"

# Search descriptions inside SKILL.md frontmatter
grep -rl "keyword" $PAPERCLIP_OPENCLAW_SKILLS_DIR/*/SKILL.md | head -10
```

Then read the specific SKILL.md you found.

## How to use

1. **Check Tier 1 first.** Read `$PAPERCLIP_SKILLS_INDEX` and scan the
   `available` array for matching skills by name or description.

2. **Search Tier 2 if needed.** Use grep/ls on `$PAPERCLIP_OPENCLAW_SKILLS_DIR`
   to find community skills by keyword.

3. **Load the skill.** Read the full `SKILL.md` at the skill's path. The content
   contains detailed instructions, API references, and patterns.

4. **Follow the loaded skill's instructions** for the remainder of your task.

## When to use this

- You're asked to work with a technology/framework not covered by your loaded skills
- You need to generate a specific file format (docx, pdf, pptx, xlsx)
- You need deployment instructions for a platform you don't have loaded
- You encounter a domain-specific task (SEO, analytics, design systems, etc.)
- You want to check if there's a best-practice skill before starting complex work

## Tips

- Check the index early if the task seems specialized — don't wait until you're stuck
- You can load multiple skills in one session if needed
- OpenClaw community skills may reference external tools or APIs; verify their
  availability before following their instructions
