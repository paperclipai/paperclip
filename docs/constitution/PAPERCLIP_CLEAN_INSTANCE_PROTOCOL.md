# Paperclip Clean Instance Protocol

## Status

FOUNDATIONAL DEPLOYMENT DOCUMENT

## Purpose

Prevent accidental contamination from previous Paperclip experiments.

A Paperclip installation contains the platform.

The runtime instance contains the organizations operating on that platform.

These must remain separate.

---

# Code vs Instance Separation

Code:

- Paperclip repository
- source code
- extensions
- documentation

Runtime:

- database
- configuration
- companies
- agents
- projects
- conversations
- memory
- credentials

Never assume an existing runtime is clean.

---

# Rule 1 — Inspect Before Use

Before operating on any Paperclip instance determine:

- database location
- configuration files
- existing companies
- existing agents
- existing projects
- existing credentials
- existing integrations

Unknown state is not production state.

---

# Rule 2 — Fresh Instances Start Empty

A clean deployment begins with:

- no companies
- no agents
- no projects
- no experimental data

Organizations are created intentionally.

---

# Rule 3 — Preserve Before Reset

Never destroy:

- databases
- experiments
- audit history
- logs
- screenshots
- previous configurations

Backup first.

Document second.

Reset last.

---

# Rule 4 — Reproducible Deployment

Every production instance must document:

- configuration
- database initialization
- companies
- agents
- skills
- models
- permissions
- governance

---

# Deployment Flow

Fresh Paperclip Instance

        |
        v

Database Migration

        |
        v

Empty Paperclip UI

        |
        v

Create Companies

        |
        v

Create Agents

        |
        v

Attach Skills

        |
        v

Connect Models

        |
        v

Enable Governance

        |
        v

Begin Operations


---

# Company Isolation

Companies are operational boundaries.

Each company requires:

- scoped data
- scoped agents
- scoped skills
- scoped permissions
- controlled memory

Example:

Paperclip Instance

 +-- QuantumShield Labs

 +-- TheBinMap

 +-- Client Organization


Companies must not accidentally share:

- private information
- instructions
- credentials
- memory
- workflows


---

# Final Principle

The platform is reusable.

The organizations are intentional.

A clean instance is created, not assumed.
