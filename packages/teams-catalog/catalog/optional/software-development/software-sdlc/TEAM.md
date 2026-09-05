---
name: Software SDLC
description: An opt-in software delivery team with reusable requirements, architecture, implementation, testing, security review, release, and retrospective templates.
schema: agentcompanies/v1
slug: software-sdlc
category: software-development
key: paperclipai/optional/software-development/software-sdlc
manager: agents/delivery-lead/AGENTS.md
includes:
  - agents/implementer/AGENTS.md
  - agents/test-reviewer/AGENTS.md
  - agents/security-reviewer/AGENTS.md
  - projects/software-sdlc/PROJECT.md
  - skills/software-sdlc/SKILL.md
defaultInstall: false
recommendedForCompanyTypes:
  - software
  - startup
  - product
tags:
  - sdlc
  - requirements
  - architecture
  - testing
  - security-review
  - release
requiredSkills:
  - software-sdlc
  - paperclipai/bundled/software-development/github-pr-workflow
  - paperclipai/bundled/quality/qa-acceptance
  - paperclipai/bundled/paperclip-operations/task-planning
---

# Software SDLC

A reusable delivery method for a software team. This is a content pack, not a
workflow engine or a command runner. It does not enforce gates in server code.

## Install and start

1. Preview this team in the Teams catalog.
2. Choose the parent manager and review agent and skill changes.
3. Choose an adapter for each agent. This pack does not set models or credentials.
4. Apply the import through the normal governed team installation flow.
5. Assign a delivery request to the Delivery Lead. Include the project workspace,
   scope, acceptance criteria, budget, and the person who can authorize release.

Installation creates no starter tasks or routines. It does not start a delivery
cycle or grant hiring, release, or approval permissions.

## Contents

- Delivery Lead: requirements, architecture, coordination, and release preparation.
- Implementer: scoped code changes and their tests.
- Test Reviewer: independent acceptance and regression evidence.
- Security Reviewer: threat analysis and security findings.
- Software SDLC project: a home for delivery requests.
- Software SDLC skill: a reusable seven-phase method and artifact templates.

For an existing team, reuse the skill and map phase owners to existing agents.
Do not create extra agents only to match these role names.

## Flow and interface

The skill uses normal issues, blocker relations, revisioned documents, artifacts,
and typed review stages. Those objects keep Paperclip's existing layout and
approval controls. Each delivery cycle has its own parent issue and artifact
revisions. See [the skill](skills/software-sdlc/SKILL.md) for the dependency flow.

Workflow-template work is tracked in
[#3950](https://github.com/paperclipai/paperclip/issues/3950) and
[#3951](https://github.com/paperclipai/paperclip/pull/3951). This pack neither
replaces that work nor requires its unmerged API. A future invocation layer can
reuse the phase inputs, outputs, and acceptance criteria here.

## License and limitations

This pack is original contribution content under [Paperclip's MIT license](LICENSE.md). It
does not vendor ECC prompts or scripts. External tools and dependencies retain
their own licenses.

The templates are instructions. A model can fail to follow them. Deterministic
test execution, verified evidence ingestion, and server-side completion
enforcement are separate capabilities. A completed checklist is not proof of a
passing build, a secure system, or an authorized release.
