# Complete Epic, human-task, and AI-execution linkage

Date: 2026-08-29
Status: follow-up — first slice is shipped; relationship UX remains incomplete

## Source

[Epics, human work, AI execution, and context-sized cycles](./2026-08-26-epics-human-ai-work-cycles.md)

## Remaining gap

The first slice distinguishes Epics, human tasks, and AI execution tasks, enforces human-only assignment, persists acceptance criteria, and supports 1/2/4/7-day cycles. The remaining product gap is that the UI does not yet make the execution relationship explicit enough:

```text
Epic
├── Human task: define/verify acceptance criteria
├── AI execution task: implement/test/iterate
└── Human task: final acceptance/release decision
```

## Required changes

- Let an AI execution task reference the acceptance task(s) it serves.
- Show Epic detail grouped into acceptance, human, and AI execution lanes.
- Show closure readiness and the exact unmet criteria/children blocking an Epic.
- Keep human tasks free of agent assignment controls and enforce the boundary server-side.
- Keep cycle duration deliberate and visible; do not reintroduce a one-week assumption.
- Add reporting/filter coverage for the three work types.

## Acceptance criteria

1. An operator can create the Epic, acceptance task, AI execution task, and final human acceptance task without ambiguous ownership.
2. The AI execution task can navigate to the criteria it is meant to satisfy.
3. Completing AI execution does not close human acceptance automatically.
4. Epic closure lists every open child and failed/pending criterion.
5. API, shared types, UI, and agent context preserve work-item type and relationships.
6. Browser coverage proves the complete flow on a disposable staging company.
