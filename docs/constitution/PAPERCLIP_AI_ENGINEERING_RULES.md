# Paperclip AI Engineering Rules

## Mandatory Reading

Before architectural changes, AI agents must read:

- PAPERCLIP_CLEAN_INSTANCE_PROTOCOL.md
- PAPERCLIP_CANONICAL_OPERATING_MODEL.md

---

# Rule 1 — Inspect Before Building

Before creating anything inspect:

- existing UI
- database models
- APIs
- components
- workflows
- configuration

Understanding comes before implementation.

---

# Rule 2 — Paperclip Already Contains The Platform

Do not recreate existing Paperclip capabilities.

Paperclip already provides:

- UI
- companies
- agents
- skills
- projects
- issues
- workflows
- model connections

The correct approach:

Understand.

Configure.

Extend.

Do not replace.

---

# Rule 3 — Do Not Build A Second Paperclip

Prefer:

Paperclip Core

+

Controlled Extensions

+

Governance Layer


Avoid:

Paperclip Core

+

duplicate custom platform

---

# Rule 4 — Protect Boundaries

Every company requires:

- scoped data
- scoped agents
- scoped skills
- scoped permissions
- scoped memory

---

# Rule 5 — Evidence Before Conclusions

Systems should preserve:

- source
- reasoning
- confidence
- action
- outcome

---

# Rule 6 — Human Oversight

High-impact decisions require:

- evidence
- review
- approval
- audit history

---

# Rule 7 — Stop Before Redesign

When uncertain:

STOP.

Document uncertainty.

Request architectural review.

Do not silently redesign.

---

# Rule 8 — Prefer Existing Primitives

Before adding code ask:

1. Does Paperclip already solve this?
2. Can configuration solve this?
3. Can an existing skill solve this?
4. Is new code actually required?

---

# Final Rule

Read the architecture before modifying the architecture.
