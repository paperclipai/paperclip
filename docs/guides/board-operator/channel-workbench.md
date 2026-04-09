---
title: Channel Workbench
summary: Drive channel delivery from source intake to DoD closure
---

The Channel Workbench turns a channel integration request into one continuous delivery flow.

It gives product, architecture, engineering, and test a shared place to see what is blocked, what should happen next, and who owns the next step.

## What You See

The workbench is split into six sections:

- **Source Documents** — whether critical source material exists, is accessible, and has been snapshotted
- **Spec Editor** — whether required sections are complete and publishable
- **Gate Result** — the latest gate decision, stale status, and rerun path
- **Issue Ledger** — blocking issues and external follow-ups
- **Snapshot & AI Export** — frozen snapshot state, export readiness, and active exceptions
- **Evidence & DoD** — required obligations, uploaded evidence, and final closure status

## Why It Matters

Without this view, each role sees only a fragment of the job:

- Product knows the business ask, but not which missing inputs block progress
- Architecture knows the rules, but not whether evidence is ready to close
- Engineering knows the implementation path, but not whether the latest decision is still valid
- Test knows the proof, but not whether export or exception handling is complete

The workbench pulls those pieces together and keeps the handoff explicit.

## Using the Workbench

Open **Channel Workbench** from the left sidebar after selecting a company.

From the overview page you can:

- See overall readiness, latest gate status, snapshot status, and DoD status
- Review the top three priority actions
- Inspect the main blockers
- Check each role's current lane
- Follow the stage flow from intake to closure

From each section page you can:

- See the section-specific metrics
- Review the current owner, primary action, and next handoff
- Trigger inline actions where available, such as rerunning Gate, exporting the AI package, or uploading evidence
- Read the recent activity timeline for the current case

## Scenario Views

The scenario switcher lets you inspect representative states such as:

- no source material
- incomplete spec
- gate failed
- gate stale
- passed with exception
- DoD blocked

This is useful for product walkthroughs, rule review, and acceptance testing.

## Activity Recovery

The workbench uses recent activity to recover the latest effective state.

That means if a Gate rerun, AI export, or evidence upload already happened, the page reflects that progress even after a refresh.
