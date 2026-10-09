# Stock-harness live comparison — 2026-10-02

**TL;DR:** Two newly failing paired cases: classic Claude/OpenCode document delivery. Two newly passing cases: classic and native OpenCode ordered continuation. Seven unchanged failures and 13 unchanged passes. The extra ACP Claude storage symptom occurs beneath an existing credential-guard failure. All 48 results are available; no general performance equivalence is established.

The reduced instructions are **not yet qualified for merge**. Classic Claude and classic OpenCode pass the historical skill-output case but fail with the reduced instructions: they finish without saving a Paperclip task document. Native Codex and native Claude pass all three journeys in both variants. Single trials and ambiguous fixture storage wording limit causal attribution; the failed oracle remains unchanged.

The reductions and evaluation setup are in draft [PR #14948](https://github.com/paperclipai/paperclip/pull/14948). This report and its [safe evidence projection](2026-10-02-stock-harness-live-comparison.json) record the measured revisions rather than claiming the final documentation head was run through the full matrix.

## Revisions and matched inputs

- Candidate: `f02d8d0df327abb43b20c7e7beb86798239abbf5`, eight-word hire manual plus reduced shared startup/resume instructions.
- Historical baseline: `12c5433c67dc2e62916b879349c7ba2b6e0431f0`, the same evaluation harness with only the prior default manual and shared prompt source restored from `e00d10d5d5594f6e2d1e8cf4e0ec81c074b0bd88`. Its manifest records ten identical behavioral/fixture source hashes.
- Native Codex fix [#14920](https://github.com/paperclipai/paperclip/pull/14920) is held constant. This comparison does not measure its before/after performance.
- Same eight profiles, three journeys, provider models, effort configuration, skills, tools, permissions, credentials, local runtime, and independent graders. Effort inherits provider defaults where the existing profile does not set it.
- Each variant selects 24 cells and initially budgets 48 turns, with existing bounded retries and 1,000-cent company/agent hard stops. Recorded run-ledger counts can differ after early failures, retries and cleanup.

## Per-profile and case outcomes

These are recorded overall qualifications, including security and receipt failures. A credential-guard failure does not imply every behavioral matcher failed.

| Profile | Model | Journey | Historical | Reduced |
| --- | --- | --- | --- | --- |
| `legacy-codex` | `gpt-5.6-sol` | `assigned-skill-explicit-invocation` | Pass | Pass |
| `legacy-codex` | `gpt-5.6-sol` | `ordered-comment-continuation` | Pass | Pass |
| `legacy-codex` | `gpt-5.6-sol` | `continuity-restart` | Pass | Pass |
| `legacy-claude` | `claude-sonnet-4-6` | `assigned-skill-explicit-invocation` | Pass | Fail: no Paperclip document |
| `legacy-claude` | `claude-sonnet-4-6` | `ordered-comment-continuation` | Pass | Pass |
| `legacy-claude` | `claude-sonnet-4-6` | `continuity-restart` | Fail: chat memory | Fail: chat memory |
| `legacy-opencode` | `openrouter/deepseek/deepseek-v4-flash-0731` | `assigned-skill-explicit-invocation` | Pass | Fail: no Paperclip document |
| `legacy-opencode` | `openrouter/deepseek/deepseek-v4-flash-0731` | `ordered-comment-continuation` | Fail: deadline/run-start timeout | Pass |
| `legacy-opencode` | `openrouter/deepseek/deepseek-v4-flash-0731` | `continuity-restart` | Pass | Pass |
| `legacy-acp-codex` | `gpt-5.6-sol` | `assigned-skill-explicit-invocation` | Fail: credential guard | Fail: credential guard |
| `legacy-acp-codex` | `gpt-5.6-sol` | `ordered-comment-continuation` | Fail: credential guard, receipt incomplete | Fail: credential guard |
| `legacy-acp-codex` | `gpt-5.6-sol` | `continuity-restart` | Fail: credential guard, receipt incomplete | Fail: credential guard, receipt incomplete |
| `legacy-acp-claude` | `claude-sonnet-4-6` | `assigned-skill-explicit-invocation` | Fail: credential guard | Fail: credential guard, no Paperclip document |
| `legacy-acp-claude` | `claude-sonnet-4-6` | `ordered-comment-continuation` | Fail: credential guard, receipt incomplete | Fail: credential guard |
| `legacy-acp-claude` | `claude-sonnet-4-6` | `continuity-restart` | Fail: credential guard, receipt incomplete | Fail: credential guard |
| `runner-codex` | `gpt-5.6-sol` | `assigned-skill-explicit-invocation` | Pass | Pass |
| `runner-codex` | `gpt-5.6-sol` | `ordered-comment-continuation` | Pass | Pass |
| `runner-codex` | `gpt-5.6-sol` | `continuity-restart` | Pass | Pass |
| `runner-acpx-claude` | `claude-sonnet-5` | `assigned-skill-explicit-invocation` | Pass | Pass |
| `runner-acpx-claude` | `claude-sonnet-5` | `ordered-comment-continuation` | Pass | Pass |
| `runner-acpx-claude` | `claude-sonnet-5` | `continuity-restart` | Pass | Pass |
| `runner-opencode` | `openrouter/deepseek/deepseek-v4-flash-0731` | `assigned-skill-explicit-invocation` | Pass | Pass |
| `runner-opencode` | `openrouter/deepseek/deepseek-v4-flash-0731` | `ordered-comment-continuation` | Fail: deadline/run-start timeout | Pass |
| `runner-opencode` | `openrouter/deepseek/deepseek-v4-flash-0731` | `continuity-restart` | Pass | Pass |

## Findings and next step

The classic Claude and classic OpenCode skill runs read the pinned skill marker and complete the task, but save zero Paperclip documents; both historical runs save exactly one. The legacy ACP Claude skill run has the same document difference under its credential-guard failure. The earlier reduced-instruction Claude pilot also failed this document oracle. The pinned skill asks for a “task document” without explicitly naming Paperclip storage, so this may reveal both reliance on the former manual and a fixture ambiguity. It remains a failed delivery result, not a regraded pass.

Keep the agreed tiny manual. Next, verify that legacy agents discover and follow the existing **Paperclip skill/API path for durable task documents and artifacts**. The skill already prohibits file-only handoff, lists issue-document routes and gives a plan-document example; audit that delivery before adding a concise generic-document recipe if needed. Run the same preserved case plus a clearly storage-specific case on both variants. Legacy agents do not receive native `paperclip_finish`/`paperclip_block` tools. Native tool descriptions are a separate item 2.3 change; guidance must follow the actual runtime capability. No production or skill instructions were changed to make these runs pass.

Classic Claude chat fails the memory assertion in both variants. Six legacy ACP cells per variant fail the persisted-credential guard: the scanner finds a scoped provider credential in persisted ACP session state. Raw session files and credential values are not published. These are existing qualification failures requiring their own investigation; they cannot be waived or interpreted as instruction-reduction quality evidence.

Historical native OpenCode ordered comments hit the case deadline without the required continuation outcome. The initial historical classic OpenCode ordered cell lost its AWS runner before result upload; its one unchanged-source recovery also hits the 12-minute deadline. Both OpenCode ordered cases pass in the candidate. Completed failures are never rerun to select a better result. Those candidate passes against historical timeouts are observed differences, not proof of a general improvement.

Historical public prompt retrieval is clipped in three legacy ACP cells (four invocations), including identity/connection suffix text. Those structural receipt failures cannot establish that the provider omitted instructions. The candidate ACP Codex chat run also lacks a complete per-run invocation receipt. Instruction presence/absence claims are bounded by the retained public receipts.

## Timing, usage and cost

| Variant | Retained cells | Pass / fail / missing | Cell duration sum | Provider duration sum | Recorded runs with tokens / with reported cost / total | Reported LLM subtotal |
| --- | ---: | --- | ---: | ---: | --- | ---: |
| baseline | 24 | 15 / 9 / 0 | 3250.195s | 2108.034s | 52 / 43 / 58 | $1.749425 |
| candidate | 24 | 15 / 9 / 0 | 2804.913s | 1540.860s | 45 / 36 / 47 | $1.743151 |

For the 13 cells that pass both variants, median cell time is 85.550s historical versus 69.761s reduced; median provider time is 57.150s versus 43.862s. This excludes failures and is descriptive, not a reliable speedup estimate.

Provider billing is incomplete. Legacy Codex/ACP usage is unpriced in several runs; native Codex/Claude often report zero with billing type `unknown`. Reported subtotals do not prove zero native spending or invoice totals. Local runner costs and interrupted partial runs are not metered. Diagnostic/pilot costs and repeated interrupted work are outside the matched-cell subtotal and remain retained. No aggregate cost-saving claim is justified.

## Campaign and evidence history

| Campaign | Source | Outcome / evidence |
| --- | --- | --- |
| [Initial diagnostic Codex](https://github.com/paperclipai/paperclip/actions/runs/37034213743) | `a63437069` | Skill passes; predates mandatory admission. |
| [Cold full attempt](https://github.com/paperclipai/paperclip/actions/runs/37037105491) | `36e987246` | Missing SDK build; cancelled before provider admission. |
| [SDK pilot](https://github.com/paperclipai/paperclip/actions/runs/37039240025) | `4163dbfd0` | Missing daemon; stops before providers. |
| [Daemon pilot](https://github.com/paperclipai/paperclip/actions/runs/37040493183) | `ac6ddefb5` | Missing fake Codex fixture; stops before providers. |
| [Complete-build Claude pilot](https://github.com/paperclipai/paperclip/actions/runs/37041741124) | `f02d8d0df` | 537 prerequisites pass; skill document oracle fails; reported $0.175308. |
| [Initial candidate matrix](https://github.com/paperclipai/paperclip/actions/runs/37042856368) | `f02d8d0df` | 4 pass, 7 fail, 13 cancelled when a same-target-branch pilot superseded it. Original attempts retained. |
| [Candidate cancelled-cell recovery](https://github.com/paperclipai/paperclip/actions/runs/37045368302) | `f02d8d0df` | Only the 13 cancelled cells: 11 pass, 2 fail. Combined candidate has 24 results, 15 pass / 9 fail. |
| [Historical matrix](https://github.com/paperclipai/paperclip/actions/runs/37042864888) | `12c5433c6` | 15 pass, 8 recorded failures, one AWS-runner shutdown without result upload. |
| [Historical interrupted-cell recovery](https://github.com/paperclipai/paperclip/actions/runs/37048838402) | `12c5433c6` | Only legacy OpenCode ordered comments: 720.616s deadline failure; evidence and cleanup valid. Historical cohort now has 24 results, 15 pass / 9 fail. |
| [Current packaging pilot](https://github.com/paperclipai/paperclip/actions/runs/37044967981) | `1eb5ba420` | Attempt 1 stopped before cell/provider execution; attempt 2 passes, evidence valid and cleanup pass. |

The same-target-branch workflow concurrency rule caused the candidate interruption; that orchestration mistake was acknowledged and corrected with a separate unchanged-source recovery branch. No completed model failure was retried. The historical missing cell is recovered once for a runner shutdown. Partial/failed attempts remain part of the history and unknown-spend accounting.

The measured matrix packages contain a prerequisite folder beside the exact campaign root. The trusted selector correctly rejects this layout, so their original published reports synthesize missing-result infrastructure failures. A separate local reconstruction nests that prerequisite folder under the campaign root and verifies byte identity for every copied file; result, scorer, usage, screenshot and prerequisite content are unchanged. The unchanged trusted selector then selects 11/24 original candidate, 13/13 recovery 23/24 original historical packages and 1/1 interrupted-cell recovery; recovered normalization validates every retained result’s evidence. Original missing packages stay missing in their original campaign; the separate recovery result has its own provenance. This is declared directory-layout recovery, not a canonical successful publication or a change to the oracle. The safe JSON records result/receipt/scoring hashes and recovery-manifest hashes.

The fix at `1eb5ba420` writes prerequisites beneath the exact campaign root. Its single selected Codex skill cell passes through the protected report and publication pipeline: [interactive pilot report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37044967981-2/index.html), [GitHub evidence](https://github.com/paperclipai/paperclip/actions/runs/37044967981#artifacts). It has `evidenceValid=true`, cleanup pass, 27.149s provider / 49.523s cell, and a reported zero subtotal with unknown billing type. It does not replace the full matched cohort or qualify untested providers.

Original historical/recovery dashboards retain the publication failure: [historical](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37042864888-1/index.html), [candidate recovery](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37045368302-1/index.html). Inspect their access-controlled raw artifacts for measured cell evidence; do not read synthetic missing-result rows as task performance.

## Verification and remaining qualification

At `1eb5ba420`, all 557 credential-free prerequisites pass (556 TypeScript plus one Rust), along with 895 E2E support tests, E2E typecheck and 24-cell discovery. The cold builder prepares SDK/shared outputs and both daemon/fake protocol binaries, records hashes, and fails closed before credentials. The 313 filtered native tests are not counted as passing coverage. This head has 52 passing CI gates and two skipped gates; Greptile reviewed that exact head at 5/5 with zero open threads. Later documentation heads require fresh checks/review; measured sources remain explicit above.

Repository typecheck and build pass. The complete local Vitest run has 14,870 passed, 83 skipped and three unrelated timing failures; the three affected files pass unchanged narrow reruns (25 auth, 16 reviewed-chat binding, four webhook tests). Original failures are retained rather than calling the first full run green.

PR #14948 stays draft while document delivery is unresolved. Unrepresented harnesses, legacy ACP credential safety, public-receipt clipping, the independent ACP base-replacement issue, existing Claude chat memory behavior and saved-session migration are not qualified away by these results. This small matrix measures skill/context/chat behavior, not broad coding quality or statistical equivalence.

## Retained delivery diagnosis and approved repair

Both failed classic agents loaded the operational Paperclip skill. This is not an observed skill-discovery failure. In the reduced Claude run, the agent wrote a workspace Markdown file before loading Paperclip and then completed the issue without a document API write. The reduced OpenCode run loaded Paperclip, accessed the assigned skill through the public skills API, and wrote a workspace task-document file; it made no document, attachment, or work-product delivery write. Both corresponding historical runs saved a Paperclip issue document.

Claude received the full operational skill, including its existing no-local-only delivery guidance. OpenCode's skill result was explicitly truncated in both variants: the early artifact rule survived, but the later generic document endpoint and plan-only write example were omitted. That truncation is existing behavior, not a newly measured regression. Removing always-on delivery reminders may interact with it, but the combined manual/shared reduction and ambiguous assigned-skill wording prevent a causal attribution to one layer.

Dotta approved a small early API-runtime skill recipe and a generic issue-document reference. The tiny manual remains eight words. The recipe checks the successful write's returned saved revision/content and links the returned key; it does not require another GET after a clear valid receipt. It preserves explicit destinations, downloadable-file delivery, and native document-tool boundaries.

The focused repair comparison will hold the tiny manual/shared prompts fixed and vary only `skills/paperclip/SKILL.md` plus the new `references/issue-documents.md`. Classic Claude and OpenCode each run the preserved original case and an added explicitly Paperclip-storage case: four cells per variant, eight expected provider turns in total. This measures the skill repair separately from the original reduction. The explicit case independently checks public saved body/revision and an agent comment linking the exact same-app document; local-only, missing-revision, wrong-document, local-path, and other-origin outcomes cannot pass. Current state: fixture preparation and source freeze, no repair provider run yet.
