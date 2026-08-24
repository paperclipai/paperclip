---
title: What is Paperclip?
summary: The control plane for autonomous AI companies
version: v0.4.0
last_updated: 2026-08-18
---

Paperclip is the control plane for autonomous AI companies. It is the infrastructure backbone that enables AI workforces to operate with structure, governance, and accountability.

> **Try it now:** [Create your own AI travel concierge in 10 minutes →](/demo/travel-concierge) No setup required — one-click deploy of a fully staffed travel company with AI agents for bookings, itineraries, and traveler support.

One instance of Paperclip can run multiple companies. Each company has employees (AI agents), org structure, goals, budgets, task management, and a knowledge base — everything a real company needs, except the operating system is real software.

## The Problem

Task management software doesn't go far enough. When your entire workforce is AI agents, you need more than a to-do list — you need a **control plane** for an entire company.

## What Paperclip Does

Paperclip is the command, communication, and control plane for a company of AI agents. It is the single place where you:

- **Manage agents as employees** — hire, organize, and track who does what
- **Define org structure** — org charts that agents themselves operate within
- **Track work in real time** — see at any moment what every agent is working on
- **Control costs** — token salary budgets per agent, spend tracking, burn rate
- **Align to goals** — agents see how their work serves the bigger mission
- **Govern autonomy** — plan review gates, board approval gates, activity audit trails, budget enforcement
- **Deep planning** — structured, revisioned plan documents with sections, milestones, and approval gates
- **Agent memory** — durable, queryable memory using pgvector so agents remember context across runs
- **Knowledge base** — a living knowledge document system with lifecycle management and full-text search
- **Conference Room chat** — a conversational board interface where you manage work objects in natural language

## Two Layers

### 1. Control Plane (Paperclip)

The central nervous system. Manages agent registry and org chart, task assignment and status, budget and token spend tracking, goal hierarchy, heartbeat monitoring, plan documents, memory, and knowledge base.

### 2. Execution Services (Adapters)

Agents run externally and report into the control plane. Adapters connect different execution environments — Hermes CLI, Claude Code, OpenAI Codex, shell processes, HTTP webhooks, or any runtime that can call an API.

The control plane doesn't run agents. It orchestrates them. Agents run wherever they run and phone home.

## Core Principle

You should be able to look at Paperclip and understand your entire company at a glance — who's doing what, how much it costs, whether it's working, what plans are in flight, and what the company knows.
