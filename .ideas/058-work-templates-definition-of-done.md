# 058 — Work Templates & Definition-of-Done

## Suggestion

Every issue in Paperclip is free-form. There's no concept of a **work type** with a reusable
template — a code scan finds no issue templates, acceptance-criteria scaffolds, or
definition-of-done (DoD) structure on issues. So agents create and complete work to inconsistent
standards: one "ship a feature" issue includes tests and docs, another doesn't; one bug report has
repro steps, another is a sentence. Reviewers (idea 016/017) have no consistent bar to check
against, and an agent has no checklist telling it when work is *actually* done versus
superficially finished. Consistency and completeness are exactly what scales poorly when the
workforce is autonomous and tireless.

Add **work templates with definition-of-done**: reusable templates per work type that scaffold an
issue's structure, required fields, acceptance criteria, and a DoD checklist agents must satisfy
before work is considered complete.

## How it could be achieved

1. **Template model.** Per company, named work types (`feature`, `bug`, `content`, `research`,
   `outreach`) each defining: a description scaffold, required fields/inputs, acceptance criteria,
   and a DoD checklist. Operators author them once; agents instantiate them.
2. **Instantiate on creation.** When an agent/operator creates an issue of a type, pre-fill it from
   the template so every issue of that type starts complete and consistent — and the creating agent
   knows exactly what's expected.
3. **DoD gate at review.** The DoD checklist becomes the concrete bar the review/approval gate
   (`approvals.ts`, idea 016) checks against, and that work-product security/scan gates (idea 050)
   and change-review (idea 017) attach to. "Done" stops being subjective.
4. **Agent-legible.** Inject the template's acceptance criteria + DoD into the working agent's run
   context so it self-checks before submitting, reducing rework (which calibration, idea 055, and
   unit economics, idea 013, will show dropping).
5. **Library + sharing.** Ship sensible default templates and let them travel with company
   blueprints (idea 018) / exports, so good standards are reusable across companies.

## Perceived complexity

**Low–Medium.** This is primarily a template data model, instantiation-on-create, and wiring the
DoD into the existing review gate — no new execution machinery. The effort is in designing a
template structure that's expressive without being bureaucratic, and in making the DoD checks
*meaningful* (a checklist agents rubber-stamp is worse than none — ideally some items are
machine-verifiable, e.g. "tests present," tying to idea 050). Ship templates + pre-fill first;
DoD-gated review is the higher-value second step that makes quality consistent.
