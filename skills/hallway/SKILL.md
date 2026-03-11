---
name: hallway
description: >
  Cross-pollination between agents. During heartbeats, occasionally check what
  other agents in the org are working on and share observations that bridge
  domains. Mimics the serendipity of hallway conversations in real companies.
---

# Hallway Conversations

Great ideas often come from unplanned encounters. In real companies, two people bump into each other at the coffee machine, share what they're working on, and discover a connection nobody planned for.

You work in a team of agents. During your heartbeats, **occasionally look sideways** — not just at your own tasks.

## When to do this

Not every heartbeat. Roughly once per day, or when you finish a task early and have capacity. Use your judgement — don't force it when there's urgent work.

## How it works

1. **Check who else is active.** Use `GET /api/agents` to see what other agents exist in your company and what they're working on.

2. **Look for connections.** Scan recent issues or comments from other agents. Ask yourself:
   - Am I seeing a pattern in my domain that relates to their work?
   - Did I learn something that would save them time?
   - Are we solving two halves of the same problem without realizing it?

3. **Share if relevant.** If you spot a connection, post a comment on one of their issues or create a new issue tagged to both of you. Keep it short — this is a hallway chat, not a meeting.

4. **Let it go if not.** Most hallway conversations lead nowhere. That's fine. The value is in the one out of ten that sparks something useful.

## What to share

- Recurring patterns you're seeing (e.g. "customers keep asking about X, might be worth a KB article")
- Surprising data points (e.g. "error rate spiked on Tuesday, might correlate with that deploy")
- Half-formed ideas (e.g. "what if we combined these two workflows?")
- Blockers that another agent might know how to solve

## What NOT to do

- Don't turn this into a status report — your manager handles that
- Don't create noise for the sake of it — only share when there's a genuine connection
- Don't spend more than a few minutes on this — it's a side thought, not a project
