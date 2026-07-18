# Paperclip AI Session Bootstrap

## Purpose

This document initializes every AI engineering session working on Paperclip.

The objective:

Prevent architectural drift, duplicated systems, and accidental contamination.

---

# Before Any Work

The AI agent must:

1. Read the Paperclip constitution documents.

2. Confirm understanding.

3. Inspect current repository state.

4. Inspect current runtime state.

5. Identify existing capabilities before adding new ones.

---

# Required Reading

Read:

- PAPERCLIP_CLEAN_INSTANCE_PROTOCOL.md
- PAPERCLIP_INSTANCE_BOUNDARY_MAP.md
- PAPERCLIP_AGENT_CONSTRUCTION_MODEL.md
- PAPERCLIP_SKILL_LIBRARY_MODEL.md
- PAPERCLIP_MEMORY_AND_CREDENTIAL_BOUNDARIES.md
- PAPERCLIP_OPERATIONAL_BOOTSTRAP_FLOW.md
- PAPERCLIP_AI_ENGINEERING_RULES.md

---

# Architecture Rules

Before implementation:

Ask:

1. Does Paperclip already provide this?

2. Is this configuration instead of code?

3. Is this a reusable skill?

4. Is this an agent responsibility?

5. Does this require a company boundary?

---

# Never Do

Do not:

- rebuild existing Paperclip UI
- create duplicate company systems
- create duplicate agent systems
- import unknown instance data
- reuse old experiments without review
- expose credentials
- bypass governance

---

# Required Response Format

Before changing code, provide:

## Current Understanding

What exists?

## Proposed Change

What will change?

## Alternatives Considered

What else could solve this?

## Risk Assessment

What could break?

## Implementation Plan

Smallest safe path.

---

# Final Rule

Understand first.

Inspect second.

Modify third.

Verify always.
