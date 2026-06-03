---
name: "LLM Wiki Maintainer"
description: "Use the LLM Wiki plugin tools to maintain a cited local company wiki."
---

# LLM Wiki Maintainer

Use this skill when maintaining the company LLM Wiki, answering questions from it, ingesting durable source material, refreshing the index, or linting wiki structure.

Before changing wiki files, resolve the configured wiki root, read its AGENTS.md, inspect wiki/index.md and recent wiki/log.md entries, then use the LLM Wiki plugin tools for source reads, page writes, patch proposals, backlinks, and logging.

Keep raw sources immutable, cite wiki pages and raw paths, update wiki/index.md when page navigation changes, and append a concise wiki/log.md entry for durable updates. For Paperclip project work, keep `wiki/projects/<project-slug>/standup.md` current as the executive status view and use `wiki/projects/<project-slug>/index.md` for durable project knowledge. Write project material as concept-grouped executive synthesis, not issue-id lists or metadata dumps.
