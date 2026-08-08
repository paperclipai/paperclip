---
name: "paperclip-classify-issue"
description: ">"
slug: "paperclip-classify-issue"
metadata:
  paperclip:
    slug: "paperclip-classify-issue"
---

# Paperclip Classify Issue

Single-purpose classifier: **issue → one of `chore`, `bug`, `feature`, `spike`**. The output drives plan variant selection in , branch type in , and commit subject in .

This skill is the Paperclip-native port of `tac-4/.claude/commands/classify_issue.md`. The original operated on a GitHub issue JSON blob; this version reads the issue from Paperclip directly so the canonical thread is the source of truth.

## When to use

- A new issue is assigned and has no `chore`/`bug`/`feature`/`spike` label yet.
- A manager or CTO is fanning out child issues and needs to decide which plan template each child uses.
- A Coder is picking up an unlabelled issue at the start of a heartbeat.

## When NOT to use

- The issue already has a definitive label (`chore`, `bug`, `feature`, `spike`) — trust it.
- The issue is a meta-task (`agent-hires`, approval follow-up, routine setup) — these are not coded work; skip classification.
- You are converting a known plan into child issues — use  instead. That skill assumes type is already known.

## Inputs (Paperclip primitives, not files)

Read these in order, stop as soon as you have enough signal:

1. `GET /api/issues/{issueId}/heartbeat-context` — title, description, ancestor summaries, comment cursor.
2. `GET /api/issues/{issueId}/comments?after={lastSeen}&order=asc` — only if title + description are ambiguous.
3. `GET /api/issues/{issueId}/documents/plan` — only if a plan was already drafted by an earlier agent.

Do **not** read repository files for classification. The issue thread is the canonical input.

## The four labels

| Label | One-line meaning | Typical signals |
|---|---|---|
| `bug` | A documented behaviour broke, regressed, or never matched its spec. | "fails when", "regressed in", "expected X got Y", stack trace, repro steps, bisect output. |
| `feature` | A new user-facing capability or surface area that did not previously exist. | "add", "new endpoint", "support for", a story arc, a UX mockup, a board-approved spec. |
| `chore` | Internal maintenance — refactor, dependency bump, cleanup, doc edit, naming, log noise — with no behaviour change visible to a user. | "rename", "delete dead code", "bump", "tidy", "split", "extract", "dedupe". |
| `spike` | Time-boxed investigation, prototype, or research with a question to answer — not a deliverable to ship. | "investigate", "prototype", "spike", "compare options", "find out whether", "<= N hours". |

When two labels fit, pick the one that names the **deliverable**, not the **work**: a refactor that ships a new capability is a `feature`; a bug fix that incidentally tidies code is still a `bug`; an investigation that produces a doc is a `spike`.

## The decision procedure

1. Read the title + description. Most issues resolve in one read.
2. Look for an explicit reproduction or regression claim → `bug`.
3. Look for "investigate / prototype / find out" framing or an explicit time-box → `spike`.
4. Look for new surface area or new user-visible behaviour → `feature`.
5. Otherwise → `chore`.
6. If still ambiguous after the above, sample the latest comment for clarification before deciding. If the thread doesn't disambiguate, leave a single `ask_user_questions` interaction rather than guessing.

## Output contract

Return exactly two things, in this order:

```
label: <chore|bug|feature|spike>
why:   <one-sentence justification grounded in the title/description>
```

Do not return prose paragraphs. Do not return more than one label. Do not invent a fifth category.

If you genuinely cannot decide, return:

```
label: unknown
why:   <what is ambiguous, and the one question that would resolve it>
```

…then create a `ask_user_questions` interaction on the issue asking that question.

## How the label is consumed

Downstream skills branch on this label:

-  selects the matching plan section (chore / bug / feature variants; `spike` writes a short investigation plan).
-  uses the label as the `{type}` segment (`bug--fix-...`).
-  uses it as the conventional-commit prefix (`feat`, `fix`, `chore`, `refactor`).

## Anti-patterns

- **Reading repo files to classify.** The issue thread is the source of truth. Filesystem reads belong in the implement step, not the classify step.
- **Returning a list of plausible labels.** The classifier picks one; if it can't, it returns `unknown` and files a question.
- **Re-classifying labelled issues.** If a label already exists, trust it. Override only with a comment justifying the change and reassigning if needed.
- **Treating `spike` as "small."** Size is not a label. A small bug is a `bug`. A short feature is a `feature`. `spike` is defined by the absence of a deliverable, not by hours.
