# OpenCode skill routing and clickable delivery — 2026-10-02

**TL;DR: 0 newly failing cells, 0 newly passing cells, 2 unchanged passes, and 0 pending pairs in this matched trial. Both document cases pass in both variants, so this does not establish that the metadata/link change caused the earlier failures to recover. Handoff remains imperfect in the original case:** candidate uses a clickable link with the wrong `PAP` company prefix; baseline supplies only a bare prefix-less slug path. Neither defect is scored by the preserved original document-storage oracle. The explicit clickable-link cases deliver the correct `RUN` link in both variants.

The narrow correction expands the operational skill's stock discovery description to include Paperclip task/heartbeat work and document/file delivery. The early API recipe asks for a clickable Markdown link, and the reference shows a canonical UI-link example. The full skill stays on disk; the eight-word manual and shared prompts remain reduced. No full-body injection, adapter policy override or native tool guidance is added to legacy runs.

| Classic OpenCode case | Pre-correction skill | Corrected skill | Independent evidence and limitation |
| --- | --- | --- | --- |
| Original assigned skill, verbatim request | Pass | Pass | Exactly one saved document with skill-only marker and persisted revision in each. Both handoff paths are deficient and outside this case's link-free oracle. |
| Explicit Paperclip storage with clarified clickable UI link | Pass | Pass | Saved revision/content and exact clickable `/RUN/issues/RUN-1#document-context-integrity-output` in both. |

Original machine results, source/configuration proof, tool-read sequence, costs and evidence hashes are preserved in the [safe evidence projection](2026-10-02-opencode-skill-routing-link-qualification.json). All four cells clean up successfully; none uses automatic disposition recovery or an extra attempt. No provider was rerun to improve these results.

## Sources, admission and inspectable reports

- Candidate `fe9dc1e3c518825242ed889ab9c8352986f8c2ed`, frozen branch `codex/opencode-stock-routing-qualified`: [workflow](https://github.com/paperclipai/paperclip/actions/runs/37069547401), [published dashboard and screenshots](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37069547401-1/index.html).
- Baseline `0d7ecfa96d72fba79b7f0a25052b42c0686c0488`, frozen branch `codex/opencode-pre-routing-skill`: [workflow](https://github.com/paperclipai/paperclip/actions/runs/37069552374), [published dashboard and screenshots](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37069552374-1/index.html).
- Trusted default-branch workflows ran concurrently on separate targets. Each of four measured cells passed its own exact-source, credential-free 587-assertion prerequisite before provider credentials. Candidate source fingerprint is `aeb792549146cc29eda779e83ae22d336276e31162f738a1dde85a82e7833902`; baseline is `0315602ac6788cf0d65561a73cc85d790768ef90c6815257077a2381f961b96e`.
- Git tree comparison verifies 8,242 identical tracked files. Only the two operational skill sources and an explicit baseline provenance receipt differ. Models, effort, tools, auth, permissions, budgets, manual/shared prompts and behavioral fixtures/graders are fixed; both fixture configuration hashes match. Suite/source digest differences correctly include the changed skill bytes.
- Local source preparation passed 918 E2E support tests, eight canonical inventory calibrations, skill validation, E2E typecheck, two-cell discovery and both exact-source prerequisites. Both capability inventories use the same declared source list. Initial setup mistakes remain retained and did not reach providers.

The explicit fixture now asks for a clickable company-prefixed Paperclip UI document link, matching its intended oracle. Bare paths and code-formatted paths fail calibration; correct relative/same-app absolute links pass. The original assigned-skill request and procedure remain verbatim. Earlier API-link grades are not retroactively changed, and these explicit results are not a direct repeat of the older “usable link” cohort.

## Which guidance was read before delivery

In the candidate original assignment, OpenCode loads the assigned Context integrity output skill, then operational Paperclip before any document write. The returned Paperclip skill is marked truncated, but the early saved-document recipe and reference pointer are visible. It reads `issue-documents.md`, then writes the public task document through the API. This differs from the previously failing candidate, which first loaded Paperclip only in a separate disposition-recovery run after its local-only output.

The current baseline original assignment first loads the assigned output skill and writes a workspace Markdown file. It later loads Paperclip and reads the issue-document reference, then saves a public document before completing the **same** assignment. Thus its successful delivery did not require improved metadata; stock selection timing varies between trials. Both explicit variants load Paperclip and read the reference before the document API call. Four rendered final-state screenshots were inspected, and public document revisions/content and completion comments agree with the retained results.

The candidate original comment has an actual Markdown href `/PAP/issues/RUN-1#document-context-integrity-output`, despite the measured company prefix being `RUN`. Baseline's original comment has a bare `/issues/runner-e2e-…#document-task-document` path without a Markdown anchor. The candidate's literal prefix matches the reference's example, making example copying a plausible cause, but this trial does not isolate that cause. Authenticated click navigation was not replayed after cleanup; neither original link is presented as a verified usable handoff. A minimal follow-up can show an issue-derived prefix instead of a literal company example. These original machine passes must not be presented as fully correct links.

## Timing, usage and cost

Four provider turns were expected and four assignment runs occurred. All four ledger receipts contain token usage and reported LLM cost. Local runtime remains unmetered; actual external billing is not established.

| Case | Baseline provider seconds | Candidate provider seconds | Baseline cell seconds | Candidate cell seconds | Baseline reported USD | Candidate reported USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original | 25.870 | 67.897 | 46.285 | 89.455 | 0.0058472545 | 0.0041383700 |
| Explicit clickable storage | 73.984 | 82.751 | 94.804 | 102.901 | 0.0049436470 | 0.0066440790 |

Reported LLM totals are **$0.0107909015 baseline** and **$0.0107824490 candidate**. The candidate original case takes longer in this trial; these single observations, different cache/token receipts and unmetered runtime do not establish general speed, cost or quality equivalence.

## Preserved failures and scope

The [original combined prompt-removal report](2026-10-02-stock-harness-live-comparison.md) still records two new classic Claude/OpenCode document-delivery failures, two OpenCode ordered-case improvements, and separate unchanged credential/chat failures. The [first recipe repair report](2026-10-02-legacy-document-skill-repair.md) still records Claude's improvement, OpenCode's unresolved local-only output, and the candidate's worse non-clickable explicit handoff. New successes do not erase those earlier observations or establish robustness.

This comparison qualifies only classic OpenCode's two selected journeys. Existing classic Codex/Claude/OpenCode and ACP Codex skill mounts were audited; ACP Claude's names/root-only metadata and unsupported custom ACP delivery remain separate. Hermes/Pi/OpenClaw are not live-qualified here. Native completion descriptions and hiring templates have separate changes and measurements. Both PRs remain draft; no merge or further paid breadth is part of this report.

## Provider-free follow-up after measurement

The approved reference-only follow-up replaces the literal `PAP` link with a
JavaScript construction using the current `issue.identifier` and the successful
write receipt's `saved.key`. It is a later source change, **not live-qualified**
by the frozen candidate above. The independent storage grader now calibrates a
wrong-company link as failure, and executes the shipped recipe against two
other company prefixes plus a locked-write redirected document key. All 25
focused document/source-digest tests, eight inventory calibrations, canonical
generated metadata checks and E2E typecheck pass. An initial sandboxed support attempt denied localhost/tsx
pipe creation; the failed attempt is retained, with its affected files rerun
unchanged under permitted local execution: 906 assertions passed in the original
921-assertion attempt, and all 82 selected assertions passed in the permitted
retry, including every originally failed assertion. No new model calls or old verdict
changes are part of this follow-up.

Fresh native-PR review caught a supported edge case in that later recipe:
`issue.identifier` may be null. The recipe now uses the current issue ID in the
unprefixed UI route when no identifier exists. Provider-free tests cover both
null and absent identifiers, preserving the returned document key. Source review
confirms that the board resolves the loaded issue's actual company and preserves
the document hash; no agent-side company fetch is needed. This route logic also
corrects wrong prefixes, so the frozen candidate's `PAP` href is noncanonical,
not a proven broken link. No authenticated click replay or further model run was
made. The previous 4/5 review and local setup/timing failures remain retained;
current focused document/source/manifest/admission checks pass 56 assertions and
E2E typecheck passes. This correction still has no live qualification.
