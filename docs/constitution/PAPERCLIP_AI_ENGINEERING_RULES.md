# Paperclip AI Engineering Rules

## Status

FOUNDATIONAL DEVELOPMENT POLICY

## Purpose

Define the rules AI agents, developers, and automation systems must follow before modifying Paperclip.

The goal:

Extend Paperclip safely without rebuilding existing capabilities or contaminating operational boundaries.

---

# Mandatory Reading

Before making architectural changes, read:

- PAPERCLIP_CLEAN_INSTANCE_PROTOCOL.md
- PAPERCLIP_INSTANCE_BOUNDARY_MAP.md
- PAPERCLIP_AGENT_CONSTRUCTION_MODEL.md
- PAPERCLIP_SKILL_LIBRARY_MODEL.md
- PAPERCLIP_MEMORY_AND_CREDENTIAL_BOUNDARIES.md
- PAPERCLIP_OPERATIONAL_BOOTSTRAP_FLOW.md

Understanding comes before implementation.

---

# Rule 1 — Inspect Before Building

Before creating anything:

Inspect:

- existing UI
- database models
- APIs
- routes
- components
- workflows
- configuration
- documentation


Required question:

"Does Paperclip already provide this capability?"

If yes:

Configure or extend.

Do not recreate.

---

# Rule 2 — Paperclip Already Contains The Platform

Paperclip already provides:

- user interface
- company management
- agent management
- skills
- projects
- issues
- workflows
- conversations
- model connections


The objective is not:

"Build a new Paperclip."


The objective is:

"Create a governed operational system using Paperclip."

---

# Rule 3 — Never Build Duplicate Systems

Avoid:

- replacement UIs
- duplicate company systems
- duplicate agent systems
- duplicate workflow engines
- duplicate memory systems


Prefer:

Paperclip Core

+

Small Controlled Extensions

+

Governance Layer

---

# Rule 4 — Protect Company Boundaries

Every company requires:

- isolated data
- scoped agents
- scoped memory
- scoped credentials
- controlled permissions


Never assume another company's context is available.

---

# Rule 5 — Skills Before Agents

When a capability is needed:

First ask:

"Does this belong as a reusable skill?"

Prefer:

Reusable skill

+

Specialized agent


over:

One-off custom agent.

---

# Rule 6 — Evidence Before Conclusions

Systems should preserve:

- source
- reasoning
- confidence
- decision
- outcome


Important outputs require traceability.

---

# Rule 7 — Human Oversight

Automation should increase capability.

It should not remove accountability.

High-impact actions require:

- evidence
- review
- approval
- audit trail

---

# Rule 8 — Security First

Never expose:

- credentials
- private keys
- tokens
- client data
- company memory


Follow:

Least privilege.

Minimum access.

Maximum traceability.

---

# Rule 9 — Respect Existing Architecture

Before modifying architecture:

Document:

- current behavior
- reason for change
- alternatives considered
- expected impact


Do not silently redesign foundational systems.

---

# Rule 10 — Preserve Evidence

Before destructive actions:

Create:

- backup
- audit record
- migration plan


Never delete unknown state.

---

# Rule 11 — When Uncertain, Stop

If architecture is unclear:

STOP.

Do not guess.

Do not create large changes.

Document:

- uncertainty
- options
- recommendation

Request review.

---

# Rule 12 — Use Small Controlled Changes

Prefer:

- small commits
- documented decisions
- reversible changes
- tests
- verification


Avoid:

large undocumented transformations.

---

# AI Session Bootstrap

Every AI coding session should begin:

1. Read governance documents.

2. Confirm understanding.

3. Inspect current repository state.

4. Inspect current runtime state.

5. Create a plan.

6. Execute only approved changes.

---

# Final Principle

AI systems become trustworthy through:

clear boundaries,

reusable capabilities,

traceable decisions,

and disciplined engineering.

The architecture must remain understandable to the humans responsible for it.
