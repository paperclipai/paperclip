# Paperclip Instance Boundary Map

## Purpose

Define the separation between:

- Paperclip platform
- Companies
- Agents
- Skills
- Memory
- Governance

The goal is a scalable AI operating environment without accidental data contamination.

---

# Core Architecture

Paperclip is the operating platform.

Companies are organizations running on the platform.

Agents are workers assigned to companies.

Skills are reusable capabilities.

Governance controls permissions and decisions.

Paperclip Instance

    |
    |
    +-- Company A
    |
    +-- Company B
    |
    +-- Client Organization

Company

    |
    +-- Agents

    |
    +-- Skills

    |
    +-- Projects

    |
    +-- Memory

    |
    +-- Governance

---

# Important Rule

Do not create separate platforms when a company boundary is sufficient.

Use:

Paperclip
+
isolated companies

instead of:

multiple uncontrolled Paperclip copies.

---

# Paperclip Provides

Paperclip already contains:

- User interface
- Company management
- Agent management
- Skills
- Projects
- Issues
- Workflows
- Conversations
- Model connections


The engineering task is configuration and controlled extension.

Do not rebuild existing functionality.

---

# Separation Principle

Each company must have:

- separate agents
- separate instructions
- separate memory
- separate credentials
- separate operational data

---

# Current Organizations

## QuantumShield Labs

Purpose:

Security intelligence and governed automation.

Focus:

- cybersecurity
- evidence collection
- threat analysis
- verification


## TheBinMap

Purpose:

Retail intelligence and market operations.

Focus:

- store intelligence
- customer acquisition
- data products
- SEO


## Future Clients

Every external organization receives:

- isolated workspace
- scoped agents
- approved skills
- controlled permissions


---

# Final Rule

The platform is shared.

The intelligence is governed.

The companies are separated.

The humans remain responsible.
