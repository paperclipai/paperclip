---
name: definition-of-done
description: >
  What "done" means and how sign-off works. Use when starting work on an issue
  (write the Done check), before moving an issue to done, and when an issue is
  waiting on you for review. Covers the Done check, the four points of done,
  verifying against the live source, and escalating to a human.
key: paperclipai/bundled/paperclip-operations/definition-of-done
recommendedForRoles:
  - manager
  - engineer
  - product
  - general
tags:
  - paperclip
  - done
  - review
  - verification
  - issues
---

# Definition of Done

Agents tend to close work when an artifact exists (a design, a plan, a PR, a doc)
rather than when the outcome the requester asked for has happened. In an early
audit on one Paperclip board, roughly 1 in 10 agent-closed issues were closed
early: real work dropped, with "next steps" left in comments that nobody tracked.
This skill exists to make that number zero.

## Before you start: write the Done check

Decide how "done" will be proven **before** you do the work, not after. A check written at
the end tends to be whatever the work happens to pass.

On any issue that is more than a trivial one-step task, put a `Done check` section in the
plan document (or the first comment if there is no plan) that answers four questions:

1. **What would a top professional in this field do here** that the request does not spell
   out? (A data recovery: verify the restored files open, not just that they copied. A
   network change: a rollback path tested before the change.)
2. **What raw material would they start from?** The live system, the original data, the
   manufacturer's documentation, the requester's own words. Not a summary of them.
3. **Which methods and tools would they use?** If you are about to use a simpler stand-in
   (a table in a comment instead of the real tool), say why.
4. **What, other than you, will show the result is right?** A test, a live reading, a
   command's output, a page, a measurement, the requester's confirmation. Name the exact
   check and what a pass looks like. "I reviewed it" does not count.

Examples of good answers to question 4:
- "The open owner-card count in the UI equals the API's open owner-card count."
- "A file restored from last night's backup opens and matches the original's checksum."
- "With the tunnel down, the VM has no internet route (curl to an outside host fails)."

Two kinds of work have a fixed rule for question 4:
- **Bug fixes:** a test that **fails without the fix and passes with it**. "The tests pass"
  alone does not show the bug is gone. Record both runs.
- **UI work:** the browser check must **assert the expected text or element** on the page. A
  click or a page load only proves the control exists.

If the requester stated how they will judge it, that is part of the check. If no outside
check is possible, say so in the plan. The reviewer then decides whether that is acceptable.

## The four points

An issue is done only when all four hold:

1. **Outcome, not artifact.** What the requester actually asked for has happened in
   the real world: deployed, installed, ordered, repaired, decided, in use. A design,
   plan, PR, document, or "ready for you" is a *step*.
2. **Verified.** There is evidence it was exercised for real: a test run, a live state
   read, a screenshot, the requester's confirmation. If something couldn't be verified,
   say so plainly. Never imply it.
3. **Remaining work is in open, owned issues.** Every leftover step is an open issue
   with an assignee, linked by identifier. "Next steps" in a comment, document, or
   README are lost work.
4. **Root cause, not symptom.** If you fixed a symptom, the underlying cause is fixed
   too, or it is an open, owned issue.

## As the implementer (asking for sign-off)

Your closing comment must contain, in this order:

- **Outcome:** one line on what is now true in the real world.
- **Evidence:** the Done check you wrote at the start, what you ran or read, and what it
  showed (paste the key output or link it). If the check changed during the work, say how and why.
- **Not verified:** anything you could not check, and why. Write "none" if none.
- **Remaining work:** linked open issues with owners. Write "none" if none.
- **Root cause:** fixed / tracked in <issue> / not applicable.

**Don't ask for sign-off while you're waiting on a human.** If the outcome depends on an
owner card, purchase, or physical step that hasn't happened yet, keep the issue `blocked` (or
`in_review` with the card pending) and resubmit once it's answered.

Then move the issue to `done`. If the issue has an approval stage, this routes it to
the reviewer instead of closing it. If the reviewer requests changes, address the gap;
don't argue it.

When you create an issue for real-world work, set the approval stage your workflow
requires at creation time — you usually can't add it to another agent's issue later.

## As the reviewer (an issue is waiting on you)

1. **Check the live source yourself**: the repo/branch, the system's real state,
   the issue record, and the requester's original words. The implementer's summary
   is a claim, not evidence.
2. **Test the four points.** Follow every "remaining work" link and confirm the issue
   is open and assigned.
3. **Check the Done check.** Confirm one was written before the work, that it names
   evidence from outside the implementer, and that the evidence shows a pass. Re-run it
   yourself where you can. A missing or after-the-fact check is a request for changes,
   unless the issue is a trivial one-step task.
4. **Decide:**
   - **Approve:** move to `done` with a comment quoting the evidence you checked.
   - **Request changes:** send it back with a status update to `in_progress` plus a
     comment naming exactly what is missing. A comment alone leaves the review pending —
     the implementer's assignment is restored only when you also change the status.
     Doing this often is normal and expected.
   - **Never leave a review pending.** End every review run with a decision (approve, or
     request changes). A review left open invites the issue to stall with no one driving it.
   - **When a human must decide or verify** (physical installs, purchases, how something
     behaves in the physical space, the requester's satisfaction): **request changes** with a
     comment like "Waiting on owner: <exactly what to check or decide>". The implementer posts or
     keeps one card to the owner and resubmits after they answer. Don't escalate things you
     can check yourself.
5. **Never approve your own work.** It goes to the next approver.
6. Batch reviews: handle every pending sign-off in one run.

## Red flags (request changes)

- "✅ Complete" with no evidence section.
- No Done check, or one written after the work, or one whose only evidence is the
  implementer's own judgement.
- "Ready for the owner to …" / "Next steps: …" with no linked open issue.
- A design, PR, or plan presented as the deliverable when the ask was a working thing.
- "Should work", "likely fixed", "as discussed" in place of a test result.
- A symptom reset (a toggle flipped, a service restarted) with no root-cause line.
