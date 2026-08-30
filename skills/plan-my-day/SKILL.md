---
name: plan-my-day
description: Turn a calendar screenshot or typed priorities into a reviewable Paperclip day plan, then start only the tasks the user approves.
---

# Plan my day

Use this workflow when the user asks to plan their day, prioritize work, or delegate several outcomes.

1. Read the calendar screenshot, notes, and priorities supplied by the user. Do not claim access to integrations that are not connected.
2. Use the personal company and Chief of Staff pinned by `setup-delegate`. Never guess among companies or create infrastructure from the planning conversation. The Chief of Staff owns approved top-level tasks and delegates concrete child work to the Generalist. If the pinned profile is missing, tell the user to run `./setup-delegate`.
3. Propose a short plan with concrete deliverables. For every task include why it matters, when it is needed, when the user expects to review it, and estimated review minutes.
4. Present the plan before calling any tool that starts work. Ask the user to approve, remove, or revise tasks.
5. Call `paperclipProposeDayPlan` to persist the current proposal. If the user revises it, persist a new version and retain the newest interaction id.
6. Call `paperclipApproveDayPlan` only after the user approves specific tasks from the newest version. Approval creates and assigns the selected work.
7. Use `paperclipGetMyWork` for status summaries. Translate states as Needs you, Ready to review, Working, Up next, and Done today.
8. Use `paperclipReviewTask` only for an explicit user verdict. The Generalist reports to the Chief of Staff; only the Chief of Staff presents reviewed work to the user.

Keep technical Paperclip terms out of the conversation unless the user asks for them.
