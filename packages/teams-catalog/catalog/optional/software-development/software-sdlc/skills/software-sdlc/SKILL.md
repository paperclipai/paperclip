---
name: software-sdlc
description: Use for a software delivery request that needs requirements, architecture, implementation, independent testing, security review, release, and a retrospective with inspectable artifacts.
---

# Software SDLC

Apply this method within the assigned issue's scope and the normal Paperclip
heartbeat contract. It does not expand permissions or override user instructions.

## Intake and approval

Inspect the existing parent issue, plan, children, and artifacts before creating
work. Ask for missing scope, target workspace, acceptance criteria, budget,
phase owners, and release authority through the normal question interaction.
Do not guess an executable command, production target, credential, or approver.

Write a revisioned plan with the phase mapping below. Request approval when the
task or company policy requires it. Keep implementation in planning until the
current plan is accepted. A plan approval does not grant hiring or deployment
permission. If an owner is unavailable, record the missing owner and request the
normal governed hire or reassignment; do not bypass a permission refusal.

## Reusable phase map

| Phase | Suggested owner | Requires accepted output from | Artifact template |
| --- | --- | --- | --- |
| Requirements | Delivery Lead | Approved intake | [requirements](references/requirements.md) |
| Architecture | Delivery Lead | Requirements | [architecture](references/architecture.md) |
| Implementation | Implementer | Architecture | [implementation](references/implementation.md) |
| Testing | Test Reviewer | Implementation | [testing](references/testing.md) |
| Security review | Security Reviewer | Implementation | [security review](references/security-review.md) |
| Release | Delivery Lead | Testing and security review | [release](references/release.md) |
| Retrospective | Delivery Lead | Release outcome or explicit cancellation | [retrospective](references/retrospective.md) |

Testing and security review may run in parallel against the same candidate
revision. Start threat analysis during architecture; the later security phase
verifies the implementation. A rejected review returns work to implementation.
Both reviews must cover the new candidate after a change.

## Issues, dependencies, and review

- Use one parent issue per delivery cycle. Map phases to child issues only when
  they need independent ownership or a durable handoff; small changes may use
  one issue with the same artifact headings.
- Reuse existing phase issues on retry. Record their IDs in the parent plan.
  Inspect that mapping before creating children. If concurrent work leaves the
  mapping uncertain, reconcile it before creating more issues.
- Use blocker relations for required handoffs. Parent-child structure alone
  does not prevent a child from running. Add dependencies before waking owners.
- For an independent verdict, use the issue's native execution-policy review
  stage with a named eligible participant. Do not replace it with a comment,
  a self-checked box, or a separate review task that can be ignored.
- The testing and security phase issues produce evidence; they do not substitute
  for typed review approval on the implementation or release issue.
- Leave a live owner, durable wait, or explicit escalation at every handoff.
  A pending human response needs a persisted interaction, not a polling loop.
- An unavailable or denied operation is a blocker. Do not mark it done or grant
  yourself more authority to proceed.

## Artifact contract

Read only the template for the current phase and its prerequisite outputs.
Copy its headings into the issue's revisioned document. Fill placeholders from
evidence; use "not yet verified" when evidence is missing. Do not edit the
installed templates for a single run.

Every output records the cycle's parent issue, producer, source revision,
upstream artifact revisions, checks performed, findings, and next owner.
Link documents and attach file deliverables through Paperclip's artifact flow.
Do not use a local file path as the only delivery record.

## Evidence and completion

A reported pass needs the exact candidate commit, command or external check
identity, environment, exit status, and an inspectable result. Missing tools,
timeouts, skipped checks, stale reports, and partial output are not passes.
Do not treat a language model's summary as test execution.

Record tests, lint, build, coverage, and security checks separately. A project
owner selects commands and thresholds. Never claim a universal coverage target
or no-vulnerability result merely because the template lists a check.

Release stays blocked until required evidence and native reviews are accepted
and the authorized release actor approves the exact target and revision.
The template itself cannot authorize or enforce release.
