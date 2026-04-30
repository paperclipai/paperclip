---
name: "Claude Skills"
kind: skill
one_liner: "Claude Skills are reusable, file-system-discoverable instruction packages that Claude Code and Claude.ai load on demand to add specialized capabilities to a session — defined as a folder containing a SKILL.md file with frontmatter and a body of instructions, plus optional resources, references, and scripts."
shipped: "2026-02-15"
status: ga
description: "Claude Skills are reusable instruction packages discovered from the local filesystem that extend a Claude session with specialized capabilities."
primary_url: "https://docs.anthropic.com/en/docs/claude-code/skills"
related_terms: [agent-harness, tool-use, mcp]
related_courses: [production-agents-claude-agent-sdk-mcp-connector]
related_blogs: []
sameAs: []
---

## What Skills are

A Claude Skill is a directory under `~/.claude/skills/` (or per-project under `.claude/skills/`) containing a `SKILL.md` file with YAML frontmatter (`name`, `description`, optional `slug`) and a markdown body of instructions. Claude discovers and lazy-loads skills on demand when a user query matches the description.

Skills are functionally similar to system prompts that get auto-attached, but with three improvements: they're versioned in git, they're shareable across teams via repo clones or curl-installers, and they're hierarchical (project skills override user skills).

## How Skills differ from MCP servers

A skill is instruction text — a recipe for how Claude should think about a task. An MCP server is a runtime that exposes tools, resources, and prompts. Skills can reference MCP servers (by including instructions like "use the github MCP server's create_pr tool"), but skills don't add new capabilities; they shape how Claude uses existing capabilities.

Practical use cases: codebase-specific style guides ("write commit messages with conventional-commits format"), domain glossaries ("when the user says X, they mean Y"), workflow scripts ("for any new feature, run lint + test + push to a feature branch").

## Major Skill repositories as of April 2026

The most-installed open-source skill ecosystems are AgriciDaniel's claude-seo (24 SEO sub-skills), claude-blog (22 blog content sub-skills), claude-obsidian (11 vault management sub-skills), and Anthropic's official skill examples in claude-code-templates.
