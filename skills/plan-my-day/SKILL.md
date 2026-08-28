---
name: plan-my-day
description: Turn a calendar screenshot or typed priorities into a reviewable Paperclip day plan, then start only the tasks the user approves.
---

# Plan my day

Use this workflow when the user asks to plan their day, prioritize work, or delegate several outcomes.

1. Read the calendar screenshot, notes, and priorities supplied by the user. Do not claim access to integrations that are not connected.
2. List Paperclip companies and agents when their ids are not already known. Choose the user's personal company and its active generalist worker.
3. Propose a short plan with concrete deliverables. For every task include why it matters, when it is needed, when the user expects to review it, and estimated review minutes.
4. Present the plan before calling any tool that starts work. Ask the user to approve, remove, or revise tasks.
5. Call `paperclipProposeDayPlan` to persist the current proposal. If the user revises it, persist a new version and retain the newest interaction id.
6. Call `paperclipApproveDayPlan` only after the user approves specific tasks from the newest version. Approval creates and assigns the selected work.
7. Use `paperclipGetMyWork` for status summaries. Translate states as Needs you, Ready to review, Working, Up next, and Done today.
8. Use `paperclipReviewTask` only for an explicit user verdict. Agents submit results; the user accepts them.

Keep technical Paperclip terms out of the conversation unless the user asks for them.
