# 017 — Run Change-Review Surface (PR-Style Diff per Agent Run)

## Suggestion

When an agent run touches a workspace, Paperclip records what happened
(`workspace-operations.ts`, `workspace-operation-log-store.ts`) and produces work products —
but the operator's review experience is fragmented: read a comment, maybe open files, infer
what actually changed. There's no single **"here's the diff this run produced"** surface, the
way a pull request shows exactly what a developer changed before you approve it. For an
operator governing agents they don't fully trust, *seeing the change* is the core review act,
and it's harder than it should be.

Add a **change-review surface per run**: a consolidated, PR-style view of everything a run did
to its workspace — files added/modified/deleted with diffs, commands executed, work products
generated — attached to the run and wired into the approval flow.

## How it could be achieved

1. **Aggregate the operation log.** `workspace-operation-log-store.ts` already captures file
   and command operations per run; group them into a single changeset keyed by run id.
2. **Render diffs.** For text files, compute before/after diffs (reuse the file-resources
   read path, `routes/file-resources.ts`); for binaries/large files, show metadata and a
   download. Summarize commands run and their exit status.
3. **Attach to review.** Surface the changeset directly in the approval item (idea 016) so a
   reviewer approves *a concrete diff*, not a vague "work product." Feeds the risk score with
   real diff size.
4. **Run-to-run comparison.** Let the operator diff the workspace across two runs of the same
   issue to see incremental progress — and to spot a Diminishing-Returns loop (idea 003)
   visually: "three runs, basically the same diff."
5. **AI change summary.** Optionally generate a one-paragraph plain-English summary of the
   changeset (cheaply, on a local model — idea 008) so reviewers triage faster.

## Perceived complexity

**Medium.** The raw operation data is already logged, so this is primarily an aggregation +
diff-rendering + review-integration feature, much of it front-end. The fiddly parts are diffing
large/binary artifacts gracefully and reconstructing accurate before/after states for files the
run mutated (may need to snapshot file contents at operation time rather than diffing live).
High operator value relative to effort because it makes the existing review/approval flow
actually trustworthy.
