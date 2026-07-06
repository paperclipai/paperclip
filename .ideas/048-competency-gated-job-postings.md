# 048 — Competency-Gated Job Postings (Test-to-Hire)

## Suggestion

Hiring in Paperclip today is **immediate and unverified**: an operator creates an agent, gives it
a role, and it starts working — there's no concept of an open *position* with requirements, and no
check that the agent can actually do the job before it's handed real work and budget. There's no
job-posting / vacancy / requisition primitive in the codebase at all (the `hire-hook.ts` flow is
manual agent creation; the JOB-POST/HIRING-REQUEST patterns some operators use are conventions
bolted on top). Meanwhile the catalog already knows how to express what a role *needs*
(teams-catalog `requiredSkills` / `CatalogTeamSkillRequirement`), and the repo ships an eval
harness (`evals/promptfoo/`) that can *test* whether an agent meets a bar.

Combine them into a real hiring pipeline: a **job posting** is a first-class open position that
declares required skills and an acceptance test, and it **stays open until a candidate agent
proves it can do the work** — test-to-hire, not hire-and-hope.

## How it could be achieved

1. **Job posting as a first-class object.** A posting = `{ role, requiredSkills, acceptanceTest,
   budget, reportsTo, status: open|filled }`. Required skills reuse the teams-catalog
   `requiredSkills` model; the acceptance test is an eval suite (idea 011) encoding "can this
   agent actually do this job?"
2. **Postings sit in a queue.** An open posting is visible, unfilled work-to-staff. It can be
   filled two ways: (a) an **existing** agent applies/is nominated, or (b) a **new** candidate
   agent is created to attempt it (reusing the create-agent flow).
3. **Gate on a competency test.** Before a candidate gets the job, run the posting's acceptance
   test against the candidate's config in a side-effect-free mode (the `planOnly`/shadow path from
   ideas 004/032). Only a passing candidate is hired into the role — the eval *is* the interview.
4. **Skill-readiness gating.** A posting can require skills the candidate must hold first; pair
   with auto-provisioning (idea 047) so a near-fit agent gets equipped with the missing skills,
   then re-tested. A posting genuinely "sits until an agent is skilled enough to fulfill it."
5. **Hire on pass, with probation.** A passing candidate is hired but enters at probation
   (idea 009) — the test proves baseline competence; the trust ramp proves sustained performance.
   Every attempt (pass/fail, score, cost) is logged to the audit trail (idea 023) as a hiring
   record.
6. **Re-posting & backfill.** If an agent is removed or fails reliability SLOs (idea 044), its
   role can auto-reopen as a posting, so the org self-heals its staffing instead of silently
   running short-handed.

## Perceived complexity

**Medium–High.** This introduces a **new domain object** (the job posting) and a hiring state
machine — open → candidate(s) → tested → hired/rejected → filled — which is more than a thin layer
over existing services. But the hard sub-parts already exist: required-skill declaration
(teams-catalog), the testing mechanism (eval harness + shadow execution), and probationary
onboarding (idea 009). The real design work is the posting/candidate/test lifecycle, a fair and
side-effect-free competency test (shares the `planOnly` guarantees of ideas 004/032), and the UX
of an operator-or-agent-driven hiring queue. Ship the posting object + manual "test this candidate
against this posting" first; auto-backfill and skill-readiness re-testing are powerful follow-ons
that make staffing genuinely autonomous.
