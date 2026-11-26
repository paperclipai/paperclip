# Legacy document skill repair qualification — 2026-10-02

**TL;DR: one newly passing case (Claude original document delivery), one unchanged pass (Claude explicit storage), two unchanged OpenCode failures, and no pending pairs or new overall machine failures. OpenCode's explicit-case clickable handoff nevertheless got worse:** baseline supplied a clickable API document URL, while candidate supplied only a code-formatted path. Both fail the original UI-only link oracle, whose intended route was narrower than the request's "usable link" wording. This result does not establish general non-regression.

This focused repair keeps the eight-word manual, reduced shared prompts and merged Codex base fix #14920 fixed. It varies only the early operational Paperclip skill recipe and the presence of the new `issue-documents.md` reference. The earlier combined prompt-removal comparison retains its two new classic Claude/OpenCode storage failures; this trial repairs Claude's original case but leaves OpenCode's original regression unresolved.

| Classic profile | Case | Pre-fix skill → repaired skill | Retained evidence |
| --- | --- | --- | --- |
| Claude | Original assigned skill | Fail → Pass | Baseline lacks a durable task document; candidate saves one containing the skill marker. |
| Claude | Explicit Paperclip document | Pass → Pass | Both save the document/revision and provide a canonical UI link. |
| OpenCode | Original assigned skill | Fail → Fail | Both write a workspace file rather than a public task document. Candidate requires automatic disposition recovery. |
| OpenCode | Explicit Paperclip document | Fail → Fail | Both save the document/revision. Baseline provides a clickable API URL; candidate gives a code-formatted UI path without an anchor. Original UI-link checks fail in both. |

Original machine verdicts and evidence hashes are retained in the [safe evidence projection](2026-10-02-legacy-document-skill-repair.json). No model was rerun to improve these results.

## Frozen sources and public reports

- [Repaired skill campaign](https://github.com/paperclipai/paperclip/actions/runs/37060885547), source `abd0b628ca642c09a54a4edc56a5227402f6686e`, branch `codex/legacy-document-repaired-skill`. [Published candidate report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37060885547-1/index.html).
- [Pre-fix skill campaign](https://github.com/paperclipai/paperclip/actions/runs/37060888047), source `bc83fe030234439ac51279502a28803958963e2e`, branch `codex/legacy-document-pre-fix-skill`. [Published baseline report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37060888047-1/index.html).
- Both trusted default-branch workflows ran concurrently on separate concurrency targets. All eight cells pass their exact-source prerequisite gate before providers; all eight clean up successfully. Failed campaigns are published successfully and remain failed.
- The four model/effort/auth/tool/permission/environment configurations match. Models are `claude-sonnet-4-6` and `openrouter/deepseek/deepseek-v4-flash-0731`. The comparison records 203 byte-identical fixture/behavior sources and explicit present/absent skill-source fingerprints. The new reference is absent from the baseline, rather than silently introduced into it.
- Local admission preparation passed 909 E2E support tests, E2E typecheck and four-cell discovery; the candidate exact-source gate passed 571 checks, including one Rust check. Initial sandbox and obsolete catalog-count attempts remain retained. The original request and behavioral oracle were not weakened.

## What OpenCode actually received

The repaired original assignment invokes only its assigned Context integrity output skill, then writes `task-document.md`. There is no operational Paperclip skill load or issue-document reference read before that local write. A separate automatic `issue_disposition_repair` run then loads Paperclip. Its returned content contains the new early saved-document paragraph and reference pointer even though the overall skill result is marked truncated; it never reads the reference or saves a document, and only finalizes the issue's status.

This is evidence of operational-skill selection after work, not evidence that the assignment saw and ignored the new recipe. The pre-fix original run also writes locally before loading the old Paperclip skill. Whether the adapter should activate operational Paperclip guidance before work is a production-delivery question for review; expanding a skill the first assignment never opened would not address the observed sequence.

The explicit candidate loads the assigned skill, then Paperclip, receives the new early paragraph, reads `issue-documents.md`, and calls the document API successfully. Its saved document has a persisted revision. The remaining defect is its comment's non-clickable path. Baseline supplied an actual Markdown link to the issue-document API GET endpoint. Read-only source review confirms that this endpoint returns the document in board context, and the unprefixed UI issue route redirects through the selected company's prefix while preserving the document hash. Actual authenticated browser navigation against these cleaned-up measured instances was not replayed, so neither URL is classified as a proven broken route. Candidate's missing clickable anchor is directly observable.

A future explicit fixture should name a clickable Paperclip UI document link if that is the intended contract. This clarification would not retroactively pass or fail either original result. A short canonical Markdown UI-link example can be considered separately from operational-skill delivery. No further production instruction change or paid rerun was made for this diagnosis.

## Runs, timing and cost

Eight provider turns were expected; nine actual runs are retained. Candidate OpenCode's original assignment succeeds but leaves the task `in_progress`, triggering automatic disposition recovery. The recovery succeeds and marks it done, without creating the missing document. Both runs, their time and cost are counted rather than selecting a better attempt.

| Profile | Case | Baseline provider seconds | Candidate provider seconds | Baseline reported USD | Candidate reported USD |
| --- | --- | ---: | ---: | ---: | ---: |
| legacy-claude | Original | 23.032 | 27.702 | 0.1668394500 | 0.2267947500 |
| legacy-claude | Explicit storage | 34.999 | 40.513 | 0.1997571000 | 0.2561425500 |
| legacy-opencode | Original | 36.770 | 68.032 | 0.0033927116 | 0.0047148437 |
| legacy-opencode | Explicit storage | 206.191 | 46.300 | 0.0102644593 | 0.0042468724 |

Reported LLM totals are $0.3802537209 baseline and $0.4918990161 candidate. All four baseline and five candidate ledger rows contain token usage and reported cost. Local runtime is unmetered and actual external billing is not established. Single trials, the additional recovery and baseline OpenCode's long explicit-case execution prevent a general timing or spending conclusion.

## PR maintenance and remaining qualifications

The skill insertion shifted generated capability heading anchors. General PR CI detected stale `capabilities.yaml`; the paid workflow's narrower build and every exact-source admission still passed before provider access. Both canonical capability metadata inventories are regenerated after measurement, include the new reference where declared, and adds a credential-free admission test that rejects stale/missing manifests. These maintenance changes do not modify the frozen measured branches or the skill bytes used in this comparison.

Draft [PR #14948](https://github.com/paperclipai/paperclip/pull/14948) keeps this repair and the tiny manual; draft [PR #14961](https://github.com/paperclipai/paperclip/pull/14961) measures native completion documentation separately. OpenCode original delivery remains unresolved, and existing Claude chat-memory and legacy ACP credential/receipt findings remain separate. No broad matrix rerun was launched, and merging remains user-controlled.
