---
name: first-task
description: >
  Guide the user's first Paperclip task when its description invokes /first-task.
  Interpret the opening answer, clarify their goal, propose a plan or a single
  task, and wait for approval before hiring agents or executing approved work.
---

# First task

Use this workflow only for the onboarding task that invokes `/first-task`,
including later replies and approval wakes on that same task. Do not apply it
to the agent's other tasks just because this skill is installed. Follow it
without announcing the first-task skill in routine messages, cards, or documents.
Say "I'm doing X," not "I'm using the first-task skill to do X," and explain
next steps directly. This is a wording preference: answer truthfully if the
user asks about the workflow, and always disclose relevant permissions,
security implications, and execution actions.

This is the user's first task in Paperclip. Your job is to understand what they want and propose a path forward. A greeting and an opening question card were already posted for you; the card offered two choices: "Interview me and propose a plan and an agent team to execute it." (option `interview`) or "I have a task in mind" (option `task`, with a text field). You are running because the user answered that card (the answer is in your wake payload) or wrote a message instead of answering. Don't re-introduce yourself and don't post the opening card again.

Work in this order.

1. Take the path the user picked.

   - `interview` → ask the user 3–4 questions in one `ask_user_questions` card that pin down what their organization does, what they want to achieve first, any constraints (time, budget, tools), and what "done" looks like. Don't guess; ask. Don't post anything else before the card. The answers lead to the plan-and-team path in step 2.

   - `task` → the text they typed is the task. If it is clear enough to propose on, go straight to step 2. If not, reply by asking 2–3 questions specific to their message (concrete goal, constraints, what "done" looks like), then go to step 2.

   - If they wrote a message instead of answering the card, treat the message as the `task` path.

2. Propose, then wait for acceptance.

   - If they want a plan, save a `plan` document on this onboarding task describing the goal, scope, steps, proposed team, and what done means. Post one `request_checkbox_confirmation` targeting the saved plan revision. A card or thread message alone is not a saved plan. This applies to explicit plan requests regardless of the single-task proposal mode. Proposing a team does not authorize hiring it.
   - If they want one thing done, propose exactly one child task with a clear outcome and scope. Ask them to accept it before creating the child. Do not produce the requested finished work inside the proposal, even when it is quick to do.
   - For a single-task proposal, follow the `Single-task proposal mode` saved in the task description: `confirmation` means one `request_confirmation` card describing the child task, without a plan document; `plan` means save a short `plan` document describing that same child task and post one `request_checkbox_confirmation` targeting its saved revision.
   - Keep this task `in_review` while waiting. You may clarify, research for planning, and save or revise a plan/proposal before acceptance. Do not hire, create execution tasks, perform the deliverable, save finished output, or claim completion yet.

3. Interpret the next reply against the latest proposal.

   - Acceptance is an accepted confirmation card or an explicit conversational reply agreeing to the proposal. The opening answer, a clear request, and answers to clarification questions supply scope; they are not acceptance of a proposal you have not yet made.
   - A clarification answer means update the proposal if needed and ask for acceptance. A requested revision supersedes the old scope: revise the proposal and wait for acceptance of the revised version.
   - If they reject the proposal, acknowledge and stop. Do not execute it. You may close the onboarding task after acknowledging the rejection; do not describe rejected work as completed.

4. Carry out the accepted scope.

   - For a plan-only request, retain the accepted plan on this task. Do not start its implementation or hire the proposed team without authorization to do that work.
   - For an accepted single task, check for an existing child from this proposal before creating anything. Create exactly one child linked to this onboarding task, assign it to yourself, and execute it. On later wakes, continue that same child instead of creating another.
   - Save the finished output as a document on the child task and mark that child done. Link it from the onboarding conversation. Completing the onboarding parent in place, or saving the output only on the parent, does not fulfill the accepted child-task proposal.
