# Decision: which component performs the K-247 Day-1 send

**Issue:** K-20062 (acceptance criterion 1 — "decide and record … write it down before building")
**Decided:** 2026-09-28
**Decided by:** Lead Developer
**Status:** settled. This document is the answer AC1 asked for; the guard was built against it in the same change.

---

## The question

The suppression store has zero production callers. A guard that has no call site proves
nothing, so the first question is not "where do I add a check" but **"who actually sends?"**
Three candidates were on the table. One was already ruled out before this issue was filed
(the retraction in K-20051 of `server/src/services/email-channels.ts`). The remaining two
are resolved below on evidence.

## Evidence

### 1. The send is an agent action, not a repo code path

[K-19858](/K/issues/K-19858) — "K-247 Day-1 send: dispatch 46-email batch + 9 LinkedIn touches",
status `blocked` — defines the send in its own words:

> **Step 2.** In a task-bound run, use `connections_search` for an email-sending connection;
> if none is ready, file a `connection_request` and note it here. Do NOT paste credentials anywhere.
>
> **Step 3.** Send the 46 emails in tier order (Tier 1 first), throttled to protect sender
> reputation. Update the tracker doc rows to `sent` with sent_at timestamps.

There is no function, route, job, or service in this repository that sends marketing email.
The send is performed by **an agent, in a task-bound run, driving an email provider through a
user connection.** The dispatch tool is whatever MCP tools the connected provider exposes.

### 2. There is no K-247 sender in code

`resend` appears repo-wide only in:

| Location | What it actually is |
|---|---|
| `packages/shared/src/app-definitions/resend.json` | A **user-connectable MCP app definition** — an OAuth card a user completes to attach Resend. Not a sender Paperclip drives. |
| `doc/connections/AGENTMAIL.md`, `doc/plans/*` | Documentation. |

Confirmed by search: no `resend` call site, no marketing send service, no campaign dispatch
job. `email-channels.ts` (`queueSend` L1450, `emailSends` L1569, AgentMail dispatch L1752) is
Paperclip's **agent/publication** email over AgentMail — a different product surface with a
different audience. Confirmed wrong for this campaign; not touched.

### 3. Which provider is not yet fixed, and does not change the answer

K-20053 (research, `done`) recommends Amazon SES or Mailgun as the relay; `resend.json` is
available as a connection. The provider is undecided. **The guard is provider-agnostic on
purpose**: it runs before dispatch, not inside a provider SDK, so a provider change cannot
bypass it. The alternative — enforce inside a provider SDK — would be re-broken by the
first provider switch, which is precisely how this defect arose.

---

## The decision

> **The Day-1 send is performed by an agent (the CMO marketing agent) inside a task-bound run,
> driving a user-connected email provider over MCP. There is no repo code path for the send.
> The suppression guard must therefore be a preflight the agent calls immediately before
> dispatch, backed by the one store that serves `{OPT_OUT_URL}`.**

### Why the guard cannot be a code-level hook in the sender

Because there is no sender. A hook inside `email-channels.ts` — or any provider SDK — governs
a code path this campaign never enters. Any such hook would be another control that cannot
fire, which is the same defect class this issue was filed to close. Naming a hook location
before knowing the send path is what produced the original misdiagnosis.

### What follows from an agent-performed send

An agent loop can skip a step it is merely *advised* to take. "Consult the suppression list
before every send" written in a README is advice, not a control — the failure mode the issue
describes (silent, unobservable) survives advice intact. So the preflight is built to be
**checkable rather than trusted**:

1. **Fail closed, always.** An unreadable/absent store, an unreachable origin, or an
   unparseable recipient blocks the send. A preflight that cannot prove an address is clear
   must never return "clear". *(This closes the fail-open hole that `filterImport` has by
   design — see §"Deliberately not changed" below.)*
2. **The store is read at dispatch time, not batch start.** The preflight re-reads the store
   on every call. An opt-out recorded while a batch is in flight suppresses the unsent
   remainder. This is AC2 and it is proven by test, not described.
3. **One store, one process.** The preflight is served by the same origin that serves
   `{OPT_OUT_URL}`, from the same in-process store. There is no second copy of the list and
   no second reader that can drift. A suppression list the send step cannot read is not a
   control (AC4).
4. **Every exclusion is logged with a reason**, append-only, to a durable audit log — so a
   suppression is not merely enforced but *attestable* to Legal. The record is part of the gate,
   not a report beside it: if the audit log cannot be written the preflight returns **no allowed
   recipients** and exits `4`, because a dispatch nobody can reconcile against the store is the
   same failure as an unsuppressed one. Previously a clear list was returned with the audit
   failure noted in a field the CLI printed nowhere — provable in a test, invisible in use.

## Consequences accepted

- The agent must actually call the preflight. This is enforced by the send runbook
  (K-19858 step 3) plus the distinct exit codes and the audit log, which make a skipped
  preflight visible in the record. It is **not** enforceable by the type system while the
  send is an agent action. That residual gap is named here rather than papered over: the
  strongest available enforcement is a post-send reconciliation against the audit log, which
  must be added to K-19858's acceptance when the send is unblocked. Filed as a follow-up.
- The preflight is provider-agnostic, so it survives the provider decision in K-20053.
- The store stays **uncommitted to git** (it holds real opted-out addresses — personal data).
  It is shared between the opt-out origin and the send step by being *one file behind one
  origin*, not by being in version control. K-20062 acceptance criterion 5 is satisfied by
  committing the **code and tests**, which is what CI runs; see `README.md` §2.

## Deliberately not changed

`filterImport` silently `continue`s past an invalid address (`suppression.cjs:281`). That is
acceptable for an import filter, whose job is to keep bad records out of a list, and AC3 asks
the preflight to *mirror* `filterImport` semantics against the same store. Rewriting it to
fail closed would change import behaviour for a legal review that has not asked for it. The
fail-closed rule therefore lives in the new `preflight()` function, which shares the store and
the `globally_suppressed` reason string with `filterImport` but is a separate, stricter gate.

## Follow-ups (not in scope here)

| Follow-up | Why it is out of scope |
|---|---|
| Send-audit reconciliation step in K-19858 acceptance | K-19858 is `blocked` by K-20015 (Legal) and K-20016. Editing its acceptance now would be editing a frozen send gate. |
| Inbound mail routing so a STOP reply is *received* automatically | No inbound mail path exists in this repo and none can exist before P3 lands a verified sending domain. See `README.md` §1a — the reply-"STOP" footer is **withheld from publication** until receiving is real. |
| Wiring the preflight into a live sender | Explicitly forbidden by this issue: P1 (entity) and P3 (domain) are open, and zero sends are authorised. |
