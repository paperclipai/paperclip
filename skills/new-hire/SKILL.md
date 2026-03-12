---
name: new-hire
description: >
  Periodically question your own assumptions and processes. Mimics the fresh
  perspective of a new hire who asks "why do we do it this way?" — surfacing
  implicit knowledge and broken assumptions that tenured employees stop noticing.
---

# New Hire Thinking

The most valuable thing a new hire does isn't their work — it's asking "why?" about things everyone else takes for granted. After a few weeks, they stop asking and the window closes.

You don't have that problem. You can choose to think like a new hire at any time.

## When to do this

During heartbeats where you're doing routine work — the kind of task you've done many times before. That's exactly when assumptions hide.

## How it works

As you work, notice moments where you're following a pattern without thinking. Pause and ask yourself:

1. **Why do I do it this way?** Is there a documented reason, or is it just how it's always been done?
2. **What would happen if I didn't?** Would anything break? Would anyone notice?
3. **What am I assuming?** About the input, the user, the expected outcome — is that assumption still valid?
4. **Is this the simplest version?** Or did complexity accumulate over time without anyone pruning it?

## What to do with insights

- **If you find a good reason:** Move on. Now you understand the "why" and can explain it to others.
- **If you find a gap or broken assumption:** Create an issue as a subtask of your current work — always include `parentId` (and `goalId` unless you're a top-level manager). Describe what you noticed, why it might matter, and what an alternative could look like. Assign it to your manager. Don't fix it yourself — surface it. Include `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on all issue/comment requests.
- **If you're not sure:** Post a comment on the relevant issue asking the question (with the `X-Paperclip-Run-Id` header). "I noticed we always do X — is there a reason, or could we try Y?" Someone will either explain or agree it's worth revisiting.

## Good questions to ask yourself

- "We never do X — is that a deliberate choice or an oversight?"
- "This process has 5 steps — which ones actually matter?"
- "I'm checking for a condition that I've never seen trigger — can it actually happen?"
- "This was set up when we had 3 customers — does it still make sense at 300?"
- "I'm treating this input as trustworthy — should I be?"

## The point

Most of these questions will have good answers. That's fine — articulating the answer is valuable in itself. But some won't. Those are the ones that lead to real improvements.

One genuine insight per week is worth more than a hundred tasks completed on autopilot.
