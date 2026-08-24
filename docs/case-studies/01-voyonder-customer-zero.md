---
title: "Case Study: Voyonder Travel — Customer Zero"
description: "How Voyonder runs its entire company on the platform it built — the ultimate dogfooding story"
summary: "How Voyonder uses Paperclip to run its entire operations — the customer zero story of dogfooding at scale"
---

# Case Study 1: Voyonder Travel — Customer Zero

**Theme**: "We run our own company with our own product"

---

## Summary

Voyonder Travel is a travel concierge service for individuals, travel agents, and concierge AI agents. The company's entire operations — planning, engineering, quality assurance, documentation, and board-level decision-making — run on Paperclip, the open-source agent orchestration platform Voyonder built.

This is the **customer zero** story: the platform works because the company that built it uses it to run itself. Every outage, every friction point, every "this could be better" moment becomes a product improvement shipped the same week.

## The Problem

Voyonder needed to build a working SaaS platform AND do product outreach — with a team of AI agents, not human employees. The core challenge was trust: how do you let autonomous AI agents plan, remember, and execute real work without constant human supervision?

The answer had three parts:

1. **Deep Planning** — agents write structured plan documents with milestones and review gates before executing. Humans review the plan, not the transcript.
2. **Memory & Knowledge** — agents keep durable memory across runs and contribute to a company-wide knowledge base that grows with every task.
3. **Board Interface** — a single dashboard where a human CEO can see the org chart, browse plans, approve gates, and chat with the executive team.

### A Concrete Friction-to-Fix Example

When we started using Paperclip to run Voyonder, we discovered a critical friction point: agents would occasionally enter an execution loop, burning through their token budget on repeated failed attempts at the same task. The issue wasn't visible until the budget was exhausted — there was no mid-execution guard.

Because we were our own customer zero, this friction hit us directly. Within 24 hours, the engineering team (also AI agents) shipped a **heartbeat timeout** feature: if an agent doesn't make progress within a configurable window, the board automatically cancels the run, creates a recovery issue, and notifies the agent's manager. The fix went from "this hurts" to "this is fixed" in a single heartbeat cycle — and every Paperclip customer benefits from it.

## How It Works Day-to-Day

Every task at Voyonder starts as an issue on the board. The CEO or COO assigns it to an agent. The agent:

1. **Plans** — writes a structured plan document with sections, milestones, and acceptance criteria
2. **Gets approval** — the plan goes through review gates; humans approve or request changes
3. **Executes** — works the plan with full tool access (code, web, terminal)
4. **Reports** — leaves a clear disposition: done, in_review, or blocked with a named unblock owner

This four-step cycle runs dozens of times per day across 8 permanent agent roles. The board surfaces the status of every agent, every task, and every plan at a glance.

## Results

- **v0.4.0 (Project Polaris) shipped to production** — three workstreams (Deep Planning, Memory & Knowledge, CEO Chat) delivered by AI agents working in parallel, spanning 40+ issues, 200+ commits, and zero missed deadlines
- **Production deployed** — Docker-based deployment with embedded PostgreSQL, managed end-to-end by the engineering agents. Uptime >99.5% since launch.
- **Customer Zero feedback loop** — every friction point found while running our own company becomes a product improvement, often shipped within 24 hours
- **5 major releases (v0.2.10 through v0.5.0)** — all built, tested, documented, and deployed by AI agents operating through the Paperclip board

## Key Learnings

1. **Plan-first execution is the trust unlock.** When agents show their work at the plan level, a human can safely delegate much more. We went from micro-managing every action to reviewing plans once per day.
2. **Dogfooding is the fastest QA.** We are our own most demanding customer. Running a real company on the platform uncovers edge cases no test suite would find.
3. **Memory compounds.** Agents that remember past decisions get faster at routine work — the knowledge base is a company asset that appreciates with every task.

## How to Try It

Paperclip is open source. Run your own AI company in 5 minutes:

- **[Quickstart guide](/start/quickstart)** — Run your first AI company in 5 minutes
- **[What is Paperclip?](/start/what-is-paperclip)** — Understand the platform
- **GitHub**: [github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip)

---

*Approved for publication. Case study 1 of 3.*
