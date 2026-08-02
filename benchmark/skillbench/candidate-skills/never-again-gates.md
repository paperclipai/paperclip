# Never Again Gates

Canonical source: TSKB0055. Treat TSKB0055 as the full register; this skill only carries the compact G1-G15 operating gates.

## Use This Gate

Before `done`, handoff, review-pack submission, operator card, or external-review artifact, check every relevant gate below. If a gate cannot be satisfied, do not close as done; attach the missing evidence, reopen/route the work, or name the blocker.

## G1-G15 Checklist

- G1 Atomic handoff: submitted bytes match candidate bytes, gate-log checksum, and promote record. No stale `assets/final` handoff.
- G2 Artifact-bound evidence: every green gate names the exact submitted sha256 and has known-bad/self-test proof where the gate claims coverage.
- G3 Mandatory-path truth: a detector not wired into the mandatory report path is not coverage. Retire, downgrade, or label checklist-only; do not over-claim.
- G4 Entrypoint discipline: render/build through the approved entrypoint and runner. Any bypass has explicit in-issue justification and evidence.
- G5 Waiting-path truth: operator decisions, stamps, and approvals must be live and cited. Do not manufacture `in_review` waits or rely on expired/cleared cards.
- G6 Review-pack completeness: operator-facing packs include manifest, review instructions, sha-bound evidence, and the required acceptance-contract citation when TSM media is involved.
- G7 Root-cause closure: "fixed", "reran", "superseded", or "green now" is not a closeout. Name the root cause and the recurrence mechanism. If acceptance required an artifact/report/PDF/manifest, verify a direct issue attachment or work product exists before `done`.
- G8 Directive completeness: issue-stated parameters are acceptance criteria. Deliver every one or label an approved `DEVIATION`; never silently scope-narrow.
- G9 Payload verification: verifying the pipe is not verifying the payload. Exercise the exact acceptance action the feature exists for.
- G10 Schedule semantics: after platform/routine changes, diff routine run skip/failure reasons and prove scheduled work still fires on the served tree.
- G11 Capability inference trap: if a non-media assignment fails on inferred media/tool requirements, sanitize the text and file/route the product defect; do not hand it to a human by default.
- G12 Approval memory: before raising any operator-facing card, check prior resolved interactions and acceptance stamps for the same artifact sha-set. A new card needs new bytes or a named reason the old stamp does not cover it.
- G13 External reference truth: validation references must come from outside the system under test. Consume approved bytes; do not re-render locked marks or self-generate gate references.
- G14 Alert path degradation: watchdog/alert creation must degrade, not abort. If a monitor or decoration is rejected, create the alert without it and record the degradation.
- G15 Authentic external evidence: artifacts for app-store, marketplace, partner, or platform review must be real captures of the real system. A mock/demo/fabrication is a blocker, not a deliverable.

## Closeout Sentence

End closeouts with a compact evidence line:

`Never-again gates checked: Gx, Gy, Gz. Evidence: <artifact/work-product/issue links>. Unsatisfied gates: none.`

If any gate is unsatisfied, replace `none` with the owner and action required.
