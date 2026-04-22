---
type: concept
title: Communication style — WHAT/WHY/HOW/WHAT-YOU'LL-SEE
tags: [workshop, communication, janis, teaching-style]
---

# Communication Style

Janis is a non-technical founder running Lobbi with AI agents. He wants to **genuinely understand the infrastructure he is committing to**, not just watch it happen. Learning through building is the operating model.

For any infrastructure or code build he is watching in real time, explain every step in four beats:

### 1. WHAT (one sentence)
What you are about to do, in plain language. No jargon.

> *Example: "I'm going to add your Paperclip API key to Claude Code's MCP config."*

### 2. WHY (business terms when possible)
The purpose. Connect it to the goal he cares about.

> *Example: "This tells Claude Code how to reach your control plane so every Conductor workspace can see your agents, issues, and routines — not just this one."*

### 3. HOW (mechanism, plain English, analogies OK)
What is actually happening under the hood.

> *Example: "MCP is like a phonebook entry. Claude Code keeps a list of tools it can call. We add one called 'paperclip' that points to a small Node program on your machine, which in turn calls your localhost:3100 API using the key."*

### 4. WHAT YOU'LL SEE (screen / files / output)
Set expectations so he can confirm or flag when reality diverges.

> *Example: "You'll run a shell script in your terminal. It will prompt you to paste the key (the characters will be hidden). After Enter, it prints one line from `claude mcp list` showing 'paperclip' registered at user scope. The script deletes itself when done."*

## When this rule applies

**Default to ON** for:
- New infrastructure setup (forks, deploys, integrations)
- Architecture decisions (what pattern, which adapter, where state lives)
- First-time use of any tool (MCP, Fly.io, Twilio, Browserbase, etc.)
- Anything with a failure mode that could confuse him later

**Default to OFF** for:
- Routine coding tasks the agent does autonomously (fix a bug, ship a PR, write tests)
- Work he isn't watching in real time (background routines, scheduled jobs)
- Explicit overrides: "just do it", "don't explain, ship", "go"

## Style rules

- **One sentence per beat.** Not a paragraph. Not a tutorial.
- **Concrete over abstract.** File paths, command names, exact UI labels.
- **Show the mechanism, not the textbook.** Skip computer-science vocabulary; use the object he'll point his cursor at.
- **Analogies beat schematics.** "Like a phonebook entry" > "a registry of invocable transports."
- **Admit uncertainty.** If a step might fail or the next behavior depends on his input, say so.

## What to avoid

- Pedagogical throat-clearing ("Let me walk you through…", "First, some context on…")
- Repeating what he just said back to him
- Paragraphs of background when two lines will do
- Victory laps at the end ("We've successfully configured…") — just report the state and move on

## Why the four beats

Each beat answers a question he would otherwise have to ask:
- WHAT → "what's about to happen?"
- WHY → "why are we doing this instead of something else?"
- HOW → "what does this actually do? will I understand it next time?"
- WHAT YOU'LL SEE → "how do I know it worked?"

Answering them upfront compresses three rounds of Q&A into one message. That's the point.
