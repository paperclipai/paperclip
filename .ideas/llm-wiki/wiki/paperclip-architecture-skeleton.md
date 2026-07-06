---
title: Paperclip Architecture & Skeletal Kernel
type: entity
status: reviewed
sources: [_skeleton-reference, 065]
updated: 2026-06-24
---

# Paperclip Architecture & Skeletal Kernel

Paperclip is a control plane for autonomous AI companies. Reverse-engineered from the code (~90 tables,
141 services, a 12.3K-line heartbeat), it reduces to one sentence and five tables.

## The one-sentence model

> A **company** is a tree of **goals** decomposed into a tree of **issues**, worked by a tree of
> **agents**, where a timer periodically wakes each agent to pick up an assigned issue and execute it
> through an **adapter**, recording every execution as a **run**.

## The spine — 5 tables (of ~90)

- **companies** — tenant/container; budget anchor.
- **agents** — the workforce; an agent *is* its `adapterType` + `adapterConfig`; `reportsTo` = org chart.
- **goals** — the "why"; a tree; the *all-work-traces-to-the-goal* invariant.
- **issues** — the "what"; a tree linked to a goal + assignee; run-level execution locking.
- **heartbeat_runs** — the "what happened"; status, token usage, session continuity, logs — the fact table.

## The engine — one loop

Two `setInterval` timers (`tickTimers`, `tickScheduledTriggers`) drive it. A heartbeat run = **wake →
admit → pick issue → resolve adapter config → execute → record → account (usage→cost→budget)**.
Event-driven wakeups are primary; the timer is the safety net.

## The one boundary — the adapter contract

`execute(ctx) → AdapterExecutionResult{ outputs, usage, sessionId }` is the *only* thing that talks to an
LLM/CLI. Swap the adapter, change the brain; the control plane is unchanged — see [[model-economy]].

## Concentric rings (everything else)

Core (above) → accounting/safety ([[runtime-control-and-safety]], [[economics-and-finance]]) →
governance ([[security-governance]]) → work substrate (workspaces/work-products) → extensibility
(plugins/MCP, [[external-integration]]) → people & UI. **The entire idea backlog is ring-2–6 enrichment;
the spine barely changes.**

## The minimal kernel (for [[software-building-and-self-hosting]])

5 tables + one tick loop + one adapter + a budget hard-stop + a manual approval gate + a few CRUD routes.
Because the architecture is already concentric rings, "[[bootstrap-ladder|scale down to the kernel, then
build up]]" is a true subset, not a rewrite.

## Provenance

- `../../_skeleton-reference.md` (full reverse-engineering); idea `065` (kernel concept).

## Open questions for human review

- Is the per-agent-only concurrency model (no fleet cap) the most urgent spine gap? (see [[runtime-control-and-safety]])
- Which ring-2 capability is the right *first* rung for self-hosting?
