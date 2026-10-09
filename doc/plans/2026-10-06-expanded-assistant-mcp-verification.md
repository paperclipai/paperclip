# Expanded assistant MCP qualification — 2026-10-06

This record separates model qualification from client interoperability and deployment. Core PR [15380](https://github.com/paperclipai/paperclip/pull/15380) and Cloud PR [678](https://github.com/paperclipai/paperclip-cloud/pull/678) contain implementation and final delivery status. Merging requires a separate action.

## Paid Product E2E

All eight added `public-mcp` cases passed on each of three models, with automatic retries disabled. Each case uses a real runner worker, a separate assistant, and independent durable-state assertions. The grader requires the expected report, one successful worker execution and no extra runs. Task editing additionally requires newly attributed human activity in edit → block → finish order. File tests independently compare SHA-256 hashes and automatic attachment creation. Calibration tests reject fabricated completion, missing transitions, wrong actors/order and secret leakage.

| Model | Initial qualified result | Source | Campaign |
| --- | --- | --- | --- |
| `gpt-5.4-mini` | 8/8 | `9089870a4da4b03b12f7eab0afd134311b840a02` | `local-2026-10-06T20-28-55-414Z` |
| `claude-haiku-4-5-20251001` | 8/8 | same | same |
| `claude-sonnet-4-6` | 8/8 | `b9c4be5f0f8a3f1143f83edf3e8a047d02888eea` | `local-2026-10-06T20-44-06-234Z` |

Cases: `expanded-task-edit`, `expanded-documents`, `expanded-files`, `expanded-agent-config`, `expanded-projects`, `expanded-skills`, `expanded-api`, `expanded-permissions`. Those initial runs use suite fingerprint `d86dc8451519467b8680e92b7d6c3bee975a4bff419e6beaace2d8eeb5ce43f5` and grader v15. Sonnet ran after the legacy-instruction guard; Mini/Haiku ran before that narrow rejection was added. The latter guard has named-tool/API route regressions at the final runtime revision.

The final cheap-model campaign reports $1.5474926 estimated assistant cost plus $0.4521314 provider-reported worker cost: **$1.999624 known, plus unpriced Mini worker usage**. Sonnet reports $4.175256 estimated assistant cost plus $1.6985064 worker cost: **$5.8737624**. These are qualification campaign costs, not total development spend. Cached usage, provider-reported costs and estimates remain separate in the evidence.

The selected new cases do not cover the entire existing 63-case/model `public-mcp` suite; campaign `complete: false` reflects that coverage distinction, not failed selected cases. Both final campaigns executed every selected case and passed cleanup. `billing.complete` separately represents missing pricing.

### Earlier attempts retained

| Campaign time (UTC) | Passed/executed | Result and response |
| --- | --- | --- |
| 19:42:13 | 0/1 | Worker used the wrong report key. Diagnostic run did not record source SHA; do not treat it as qualified evidence. |
| 19:46:03 | 0/2 | Wrong report key and invalid UUID. Added useful sanitized validation detail. |
| 19:53:49 | 2/13 | Canceled incomplete campaign; shared-memory exhaustion, deliberate transfer URL redaction, stale UI marker and incomplete worker execution. Preserved completed results; fixed environment and evidence sanitization. |
| 20:04:15 | 12/16 | Missing explicit worker completion/readback and wrong report marker. Made worker instructions explicit, preserving durable success assertions. |
| 20:13:15 | 8/8 | Earlier Sonnet run passed. Reran with stronger activity-order grading and final instruction guard. |

[Machine-readable evidence](2026-10-06-expanded-assistant-mcp-eval-evidence.jsonl) retains every available case result, source and suite fingerprints, failed matcher details, usage and costs. Raw transcripts/results remain in the implementation worktree under `tests/runner-e2e/results/<campaign>/`; paths in the evidence point to those retained files. The checked-in projection excludes credentials and transfer URLs. Missing campaign-level billing from the canceled run is not invented.

## Actual clients, independent of model evals

The local disposable instance was created with `paperclipai test-drive`, then configured for authenticated sign-in. No worktree database clone was used.

- **Codex CLI 0.153.4:** native OAuth/CIMD; read organization and agents, updated EXP-1, wrote the report document. A first attempt with a ChatGPT login could not use Mini, so the authorized API provider was used. A noninteractive approval-disabled attempt correctly refused mutation; explicitly approved only the two fixture mutation tools for that invocation.
- **Claude Code 2.1.245:** Paperclip device OAuth and the credential-protected stdio bridge. A later conversation read Codex's report, performed a revision-checked update, and read it back. Revision 2 preserved the original body and appended its own verification line.
- **OpenCode 1.18.17:** native remote OAuth; read organization/agents, created and updated a project, uploaded a file, downloaded it, compared hashes, then registered the existing attachment as a deliverable and listed it alongside the report. No completion tool was called.

The 79-byte file round trip matched SHA-256 `fdec086f7051ebf67a596661e7567d8a53c471d6b86e63303da7734b8afc046a`. OpenCode's shell tool UI can display temporary transfer URLs in history; walkthrough captures use its safe summary instead. Transfer URLs are credentials even though short-lived.

Storybook's configuration consent story renders the production page and exercises opt-in configuration. Protocol/domain tests separately assert unchecked configuration defaults and that old grants never gain this scope through refresh.

## Regression and deployment checks

At runtime revision `b9c4be5f0f8a3f1143f83edf3e8a047d02888eea`, 75 focused MCP tests pass. The combined catalog/grader checks pass (56 tests); full workspace typecheck/build and token gates passed at the immediately preceding merge revision, with server typecheck repeated after the final guard. Latest-head CI and the full local test run are tracked in the PR rather than inferred from these narrower results.

Cloud revision `7b7ad76b302282c9fe8007185fa80ef37ddded6d` passes 2,488 tests, with 73 explicit skips and no failures. The opt-in published migration replay also passes separately. The replay verifies that the exact earlier MCP preview lineage can rejoin mainline without losing OAuth clients/grants/tokens, pending PKCE/device requests, tasks or upload receipts. It uses immutable published package archives and tests an idempotent second migration pass. All other migration histories remain subject to the existing strict checks.

Butter deployment and the hosted screenshot walkthrough are separate acceptance gates. Consult the PR verification section for their final outcome; local results above do not substitute for hosted proof. Browser directory installation, store approval and hosted MCP Events are outside this direct-connection expansion and are not claimed by these tests.

### Full local suite and mainline integration

The local full-suite attempt completed its general-server phase with 15,614 tests
passing and two timeouts (heartbeat comment wake batching and the existing
40,000-file Git streaming fixture); later phases did not run after that failure.
The heartbeat case passed in isolation. The Git fixture also exceeded its
five-minute macOS limit in isolation; its Linux CI lane passed. This is not a
claim of a completely passing local full-suite run. At `8ac64ae0a`, all 52 Core CI
checks succeeded (two optional checks skipped).

Mainline subsequently added migration 0310. The merge preserves that migration,
regenerates the combined schema snapshot, and moves the byte-identical, replay-safe
MCP transfer migration to 0311. Both private-commentary and transfer log redaction
are retained. Post-merge checks and qualification are recorded in the PR.

### Merged-source repeat and review regressions

The full 24-cell repeat on `e81f114bc6c813e7784cde0d8199538880aebe1f`
(`local-2026-10-06T21-17-35-704Z`, grader v15) passed 23 cells. Haiku's
agent-configuration cell timed out during application startup before writing a
model result. The failed attempt is retained. Known campaign cost was
$7.56693965, including $5.5999777 estimated assistant cost and $1.96696195
reported worker cost, plus unpriced worker usage.

The final review found nested pool queries during upload and OAuth transactions.
Authorization now uses the held transaction, including live settings/membership
checks and the domain issue-read decision. A real one-connection PostgreSQL test
exercises PKCE, refresh, device approval/redemption and six concurrent/repeated
uploads yielding exactly three attachments. The MCP/privacy regressions pass
139 tests. Later-conversation grading now requires a successful read of the
expected company/task report containing both references and rejects all writes;
the grader advances to v16. Its combined calibration suite passes 76 tests.
Affected paid cases and the startup failure are rerun separately at the final
source; do not reinterpret the earlier v15 runs as v16 evidence.

Local revocation was also exercised: revoking only the Paperclip CLI device
grant makes the same stdio bridge reject subsequent MCP initialization. The
Codex and OpenCode grants stay independent. A Claude diagnostic attempt that
hallucinated a shell script is retained and is not counted as proof; the
independent protocol rejection supplies that proof.

### Final affected-case qualification

At `b2196fae1a60077eb40dfe7f67e95f65f81ed8b2`, campaign
`local-2026-10-06T21-43-35-026Z` passes **9/9**: documents, binary files
and agent configuration on Mini, Haiku and Sonnet, with no automatic retries.
The prior Haiku startup failure is now followed by a passing independent attempt.
All selected cases and cleanup passed. Grader v16 uses suite fingerprint
`0d49f11ce0ebed41e74866616a1e5f03b1e52ead86131f3bbd239cbd36a81dba`.
Known cost is **$3.3112918** ($2.54030125 estimated assistant cost and
$0.77099055 reported worker cost), plus unpriced Mini worker usage.
The other five expanded cases passed across all three models on the preceding
merged source; this targeted repeat covers the changed transfer/OAuth path and
stronger later-document grading.

Butter's merged-source deployment was verified on `e81f114bc` by workflow
[37535338093](https://github.com/paperclipai/paperclip-cloud/actions/runs/37535338093).
The public metadata advertises configuration scope; invalid upload and download
tickets both return 403 through the tenant gateway. In a fresh OpenCode workspace,
the copied invitation fetched setup instructions, added the remote server, started
OAuth and produced a real Butter consent page with configuration unchecked.
The hosted grant awaits human approval under the browser tool's persistent-access
confirmation rule. Successful hosted transfers/delegation are not yet claimed.
The follow-up deployment of `b2196fae1` is tracked in the PR.
