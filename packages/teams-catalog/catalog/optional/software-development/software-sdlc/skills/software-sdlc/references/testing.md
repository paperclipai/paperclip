# Testing

## Inputs

A fixed candidate revision, requirements acceptance criteria, and implementation handoff.

## Provenance

- Parent delivery issue:
- Phase issue:
- Producer:
- Source revision:
- Upstream artifact revisions:

## Test environment

- Candidate commit and clean/dirty workspace state:
- Runtime and tool versions:
- Test data and environment:
- Authorized check configuration:

## Acceptance matrix

| Criterion | Test or inspection | Expected result | Actual result | Evidence |
| --- | --- | --- | --- | --- |
| AC-1 | [test] | [expected] | [actual] | [artifact] |

## Quality checks

| Kind | Command or check ID | Exit status | Result | Report |
| --- | --- | --- | --- | --- |
| Tests | [configured check] | [code] | [pass/fail/incomplete] | [link] |
| Lint | [configured check] | [code] | [pass/fail/incomplete] | [link] |
| Build | [configured check] | [code] | [pass/fail/incomplete] | [link] |
| Coverage | [configured check and agreed threshold] | [code] | [pass/fail/incomplete] | [link] |

Use "not applicable" only with a reason and an explicit owner decision. Record
skipped cases and timeouts. Reject reports that describe a different revision.

## Findings and verdict

- Reproducible failures:
- Missing evidence:
- Residual risk:
- Verdict and native review decision:

## Checks performed and findings

- Checks performed:
- Findings:
- Evidence links:

Summarize this phase's checks and findings, or link to its detailed results
above. For planning phases, include document reviews and consistency checks;
do not imply that runtime tests were executed. If no check was performed,
record "not yet verified" and the reason. Use "none found" only for completed
checks with evidence.

## Exit criteria

Every required check has current evidence and every acceptance criterion has a result. Unresolved failures or missing evidence block a pass. Changes after review require fresh verification.

## Handoff

- Artifact document or attachment:
- Next owner:
- Required decision or blocker:
