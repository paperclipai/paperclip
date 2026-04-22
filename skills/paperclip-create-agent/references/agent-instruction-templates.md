# Agent Instruction Templates

Use this reference when hiring or creating agents. Start from an existing pattern when the requested role is close, then adapt the text to the company, reporting line, adapter, workspace, permissions, and task type.

These templates are intentionally separate from the main Paperclip heartbeat skill so the core wake procedure stays short.

## Index

| Template | Use when hiring | Typical adapter |
|---|---|---|
| [`Coder`](agents/coder.md) | Software engineers who implement code, debug issues, write tests, and coordinate with QA/CTO | `codex_local`, `claude_local`, `cursor`, or another coding adapter |
| [`QA`](agents/qa.md) | QA engineers who reproduce bugs, validate fixes, capture screenshots, and report actionable findings | `claude_local` or another browser-capable adapter |
| [`UX Designer`](agents/uxdesigner.md) | Product designers who produce UX specs, review interface quality, and evolve the design system | `codex_local`, `claude_local`, or another adapter with repo/design context |

## How To Apply A Template

1. Open the matching reference in `references/agents/`.
2. Copy that template into the new agent's instruction bundle, usually `AGENTS.md`. For hire requests using local managed-bundle adapters, this usually means setting the adapted template as `adapterConfig.promptTemplate`; Paperclip materializes it into `AGENTS.md`.
3. Replace placeholders like `{{companyName}}`, `{{managerTitle}}`, `{{issuePrefix}}`, and URLs.
4. Remove tools or workflows the target adapter cannot use.
5. Keep the Paperclip heartbeat requirement and task-comment requirement.
6. Add role-specific skills or reference files only when they are actually installed or bundled.
