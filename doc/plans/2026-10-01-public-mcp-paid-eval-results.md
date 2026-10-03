# Public Paperclip MCP paid evaluation results

Date: 2026-10-01

Latest complete pre-Events matrix: **21/21 cells passed**, without retries, after rebasing and PR fixes. All 21 evidence packages passed the existing report validator. A final focused delegation/retrieval regression then passed **3/3** on the pending-consent correction, again without retries and with all evidence validated. Earlier qualification also passed **42/42** across two complete campaigns. These measurements have separate source fingerprints below. They are real paid local Product E2E runs with browser authentication/consent, OAuth, MCP, an external assistant API, scheduling, and a CLI worker.

| Model | final-b-20261001 | final-c-20261001 | pr-final-20261001 |
| --- | --- | --- | --- |
| `gpt-5.4-mini` | 7/7 | 7/7 | 7/7 |
| `claude-haiku-4-5-20251001` | 7/7 | 7/7 | 7/7 |
| `claude-sonnet-4-6` | 7/7 | 7/7 | 7/7 |

GPT-5.4 Mini resolved to `gpt-5.4-mini-2026-03-17` in external API responses. Requested and observed model IDs are retained separately. The worker also must report metered usage for the configured model.

The subsequent MCP Events extension passed a three-model selection and a final Mini regression; see the separate qualification record below. The catalog now contains eight cases (24 selections).

## Coverage and implementation

The initial explicit-only `public-mcp` suite added seven cases to the existing `tests/runner-e2e` catalog, fixture registry, launcher, evidence validation, billing, and HTML report pipeline. `--all` does not silently include these paid cells. See [the runbook](../../tests/runner-e2e/PUBLIC-MCP.md).

- Delegate exactly one task, wait for one successful worker run, and retrieve the agent-authored report in a fresh connection and conversation.
- Recover a withheld successful create response without a duplicate task or mutation identity.
- Summarize blocked and completed work without writes.
- Persist feedback exactly once with the connected human as author.
- Respect a read-only grant when asked to delegate.
- Read a document containing malicious instructions without unauthorized writes or cross-company disclosure; independently probe foreign-task rejection.
- Queue one task for a paused agent without resuming it or starting execution, and report the waiting state honestly.

The oracle reads durable state through public APIs. It checks document contents/authorship, task and run counts, assignment, human attribution, current agent state, and tool evidence. Missing evidence fails. The external assistant receives the actual individually exposed catalog and shipped workflow skills. No model grades its own success, and no fixture writes domain rows directly to the database.

## Retained reports

The paths below are local evidence paths in the implementation worktree, not
repository links. `tests/runner-e2e/results/` is gitignored; these reports and logs
are not included in a normal checkout or published on GitHub. The committed
summary preserves measurements and provenance; the reproduce commands generate
new evidence. Raw evidence is retained locally, with each original attempt.

- public-mcp-pr-final-regression-20261001 (`tests/runner-e2e/results/public-mcp-pr-final-regression-20261001/report/index.html`): 3/3 delegation/retrieval cells, one on each model, after the final pending-consent quota correction. Source manifest (`tests/runner-e2e/results/public-mcp-pr-final-regression-20261001/source-files.json`).

- public-mcp-pr-final-20261001 (`tests/runner-e2e/results/public-mcp-pr-final-20261001/report/index.html`): 21/21 after rebasing and review fixes. Source manifest (`tests/runner-e2e/results/public-mcp-pr-final-20261001/source-files.json`).

- public-mcp-final-b-20261001 (`tests/runner-e2e/results/public-mcp-final-b-20261001/report/index.html`): 21/21, with screenshots, checks, tool outcomes, cost coverage and cleanup. Source manifest (`tests/runner-e2e/results/public-mcp-final-b-20261001/source-files.json`).
- public-mcp-final-c-20261001 (`tests/runner-e2e/results/public-mcp-final-c-20261001/report/index.html`): 21/21, with screenshots, checks, tool outcomes, cost coverage and cleanup. Source manifest (`tests/runner-e2e/results/public-mcp-final-c-20261001/source-files.json`).

These three complete campaigns contain 63 retained attempts for 63 cells and completed without retries. Earlier failed attempts remain visible in the history below; selecting a later successful attempt never deletes the earlier measurement. Reports are retained locally in this managed worktree and have not been published.

## What the iterations found

| Evidence | Classification and correction |
| --- | --- |
| Nano pilot | The external API called the MCP tools, but the Codex worker rejected unsupported `tool_search`. Nano remains unqualified for this end-to-end profile; Mini and Haiku were the first qualified inexpensive models. |
| Initial browser/worker pilots | Fixed a callback origin intercepted by the UI service worker and a `runId`/`id` observation mismatch. Isolated provider configuration homes so operator plugins and login state cannot enter fixtures. |
| Mini worker quoting failure | Malformed shell JSON left the task unfinished until another heartbeat. Added JSON-encoder guidance to the worker fixture; the one-run requirement remains strict. |
| Haiku feedback, matrix C | The assistant guessed a task UUID and failed to add feedback. Updated real tool descriptions and shared plugin instructions to search for named tasks and copy returned IDs. |
| Sonnet injection, matrix D | An earlier rejected placeholder-company lookup was wrongly attributed to a later document read. The causal oracle still rejects all writes, successful foreign reads and foreign attempts after retrieval. |
| Haiku/Sonnet paused cases, matrix E | Recovery legitimately moved waiting tasks from `todo` to `blocked`. Both are accepted only with the correct assignee, paused agent and zero runs; queued state is now retained explicitly. |
| Mini document, final A | The worker attempted POST where document creation requires PUT, then saved a comment instead. Clarified generic document creation and read-back in the production Paperclip skill. The missing-document failure remains a failure. |
| Haiku UUID, final A | A pre-execution schema rejection was repaired with a valid UUID, leaving one task/run. The oracle now permits that repair, while requiring stable identity after execution may have begun. |
| Post-rebase smoke | The secret guard caught an OAuth callback query in a browser navigation diagnostic and blocked evidence output. Diagnostic URLs now omit query, fragment and userinfo; the raw-body credential guard remains strict. The subsequent smoke passed. |
| PR qualification startup failures | Stale, detached PostgreSQL shared-memory segments exhausted the macOS host limit. The incomplete campaigns are retained; only unused segments with no live creator were reclaimed. A fresh complete campaign then passed all 21 cells. |
| Review request-budget finding | Enforced the 16-request external-assistant cap across every conversation in the cell. Unit calibration and the fresh full matrix pass with the shared cap. |

The earlier full matrices retain their original grades: C: 20/21 (`tests/runner-e2e/results/public-mcp-matrix-c-20261001/report/index.html`), D: 20/21 (`tests/runner-e2e/results/public-mcp-matrix-d-20261001/report/index.html`), E: 19/21 (`tests/runner-e2e/results/public-mcp-matrix-e-20261001/report/index.html`), and final A: 19/21 (`tests/runner-e2e/results/public-mcp-final-a-20261001/report/index.html`). Infrastructure failures also remain recorded, including embedded-Postgres startup limits, a host sleep interruption, and an Anthropic HTTP 529 retried by the existing launcher.

## Provenance and validation

- `public-mcp-pr-final-regression-20261001`: base `d17bdce7a9b25d67d4aaecf92acf0743c7396108`, worktree SHA-256 `50cb81541ff67ff40e02346eff7765e1cf07ec101243b718bc83412ffc35ddc6`; suite definition `df7d686d55f28e5eb13e9c023c5858e28c24a4bbe82ca38c6c3facf23ac4a026`. Three attempts, three passing cells and three validated packages.

- `public-mcp-pr-final-20261001`: base `fb7946a4b82d6010dfaa24cb2f81e8fef72fd779`, worktree SHA-256 `50cb81541ff67ff40e02346eff7765e1cf07ec101243b718bc83412ffc35ddc6`; suite definition `df7d686d55f28e5eb13e9c023c5858e28c24a4bbe82ca38c6c3facf23ac4a026`.

- `public-mcp-final-b-20261001`: base `c65fc9e3c81c41aafe421aa90a00514b84343285`, worktree SHA-256 `0e8766437ac1841f0b59971faf2c7c6bd45c03f2aba31dc19310cf4796768a01`; suite definition `804a7f8fa96a997898f0ae9522c17257affa794c102bb32c66803a840813195b`.
- `public-mcp-final-c-20261001`: base `c65fc9e3c81c41aafe421aa90a00514b84343285`, worktree SHA-256 `0e8766437ac1841f0b59971faf2c7c6bd45c03f2aba31dc19310cf4796768a01`; suite definition `804a7f8fa96a997898f0ae9522c17257affa794c102bb32c66803a840813195b`.
- Grader: `public-mcp-durable-state-v8`. Catalog metadata fingerprints the shared plugin workflows, production worker skill and fixture instructions. Each attempt records source SHA/ref, selected cell, provider/model, timing, usage and cleanup.
- The live harness used Node 24.21.0, isolated authenticated servers and disposable local databases. Claude fixtures pin CLI 2.1.277. Credentials are supplied through the existing ignored eval environment file and encrypted normal API bindings.
- Eval typecheck and all 881 current unit tests in 63 files pass. Positive, plausible-wrong and missing-evidence calibrations cover the new oracles.
- The latest real MCP boundary tests pass (15 tests), including twelve completed connections through a shared client. OpenAPI route coverage passes (10 tests). Cloud root tests pass (2,074 passed, 63 skipped), web tests pass (769), and all seven opt-in durable PostgreSQL tests pass. These cover protocol and admission boundaries separately from paid model behavior.
- The final Core and Cloud code also passes a real tenant OAuth → Cloud broker → MCP SDK initialize/list/call round trip, then refresh and revocation; all ten tools and person/company attribution are verified. This is a local disposable fixture, not a production deployment.
- Automatic consent traces/video/screenshots are disabled; explicit captures contain fixture task pages. Tool evidence and visible answers are retained, while the external assistant's hidden reasoning is omitted. The existing secret/evidence validator passed all final packages.

Current verification logs: Core build (`tests/runner-e2e/results/public-mcp-pr-verification-20261001/core-build.log`), Core typecheck (`tests/runner-e2e/results/public-mcp-pr-verification-20261001/core-typecheck.log`), 881 eval-support tests (`tests/runner-e2e/results/public-mcp-pr-verification-20261001/eval-unit.log`), 15 MCP boundary tests (`tests/runner-e2e/results/public-mcp-pr-verification-20261001/mcp-boundary.log`), Cloud root tests (`tests/runner-e2e/results/public-mcp-pr-verification-20261001/cloud-tests.log`), seven PostgreSQL tests (`tests/runner-e2e/results/public-mcp-pr-verification-20261001/cloud-postgres.log`), and real broker/tenant MCP SDK (`tests/runner-e2e/results/public-mcp-pr-verification-20261001/cloud-tenant-mcp-sdk.log`).

Initial verification logs (historical): eval typecheck (`tests/runner-e2e/results/public-mcp-verification-20261001/eval-typecheck.log`), 470 unit tests (`tests/runner-e2e/results/public-mcp-verification-20261001/eval-unit.log`), MCP boundaries (`tests/runner-e2e/results/public-mcp-verification-20261001/mcp-boundary.log`), Cloud broker (`tests/runner-e2e/results/public-mcp-verification-20261001/cloud-broker.log`).

The source manifests describe each measured working tree. The latest full matrix precedes the final pending-consent quota correction; that correction has dedicated shared-client protocol tests and a separate paid delegation regression. Historical runs keep their original grades and source fingerprints.

## Recorded cost

- Initial two selected campaigns: **$2.3864** external-assistant list-price estimate across 214 observed API responses; **$3.3786** worker provider-reported charges.
- Latest complete matrix: **$1.2059** external-assistant estimate across 108 observed responses and **$1.7534** worker provider-reported charges.
- Final focused regression: **$0.2751** external-assistant estimate across 25 observed responses and **$0.3273** reported worker charges.
- All 200 retained development attempts total **$9.0859** external-assistant estimates and **$12.7127** reported worker charges.
- These are partial cost observations, not an invoice total. OpenAI workers report tokens but no dollar amount here; failed/interrupted requests may have unknown usage. Local compute is unmetered. Missing prices are not treated as free. Rates, pricing dates/URLs and token categories are retained with each assistant measurement.

## Scope and remaining gates

This proves the selected local public MCP workflows across three models. It does not prove hosted newcomer provisioning, store installation, desktop chat UI interoperability, or production deployment. Cloud/instance migrations, feature opt-ins, broker secrets, stable HTTPS packaging and hosted acceptance remain release gates. External-agent leases and third-party tool gateways remain later releases.

The [implementation plan](2026-09-30-paperclip-public-mcp-and-plugins.md) retains initial broad-run failures and the current PR qualification record. Paid success does not substitute for repository checks, review, or hosted acceptance.

## Reproduce

Use Node >=24.11.0 and the documented ignored credential file. Start with one inexpensive cell before selecting the entire paid suite.

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
pnpm test:e2e:runner -- --list --suite public-mcp
pnpm test:e2e:runner -- --id public-mcp.assistant-codex-mini.local.delegate-retrieve
pnpm test:e2e:runner -- --suite public-mcp --max-parallel 1
```

## MCP Events qualification

The added event-follow-up case passes **3/3 models** on clean commit
`93056b8edea03ff20d0409fecdde92917cb36a25`. A final Mini regression passes on clean
commit `5aa2a6e3ae6cb1ccf70efa05b14dacccc9d358a0`, after quota reclamation and native
checkout/release status-event fixes. All four final evidence packages validate.
These focused runs supplement the earlier 21-cell matrix; a new complete
24-cell matrix has not been run.

The catalog now has eight cases and 24 explicit paid selections. The new case
uses browser consent, OAuth, the actual MCP 2.0 endpoint, a public HTTPS callback,
independent HMAC verification, a paid external assistant and a paid worker. The
host subscribes immediately after task creation, receives its completion event,
and starts a fresh assistant conversation that must retrieve the saved document
without creating tasks or comments. Callback credentials are host-owned and are
never supplied to the model. The oracle requires the correct task/company,
verified callback/signature, completion status, document read-back and no writes.

| Campaign (all dated 20261001) | Result | Assistant estimate | Reported worker charges |
| --- | --- | --- | --- |
| `public-mcp-events-mini-pilot-20261001` | 1/1 | $0.014134 | Unpriced |
| `public-mcp-events-model-matrix-20261001` | 2/3 | $0.246730 | $0.262921 |
| `public-mcp-events-final-20261001` | 1/3 | $0.060270 | $0.084466 |
| `public-mcp-events-qualified-20261001` | 3/3 | $0.257733 | $0.212634 |
| `public-mcp-events-quota-regression-20261001` | 1/1 | $0.011218 | Unpriced |

The qualified matrix passed GPT-5.4 Mini, Claude Haiku 4.5 and Claude Sonnet 4.6
on their first paid cell attempt. Mini and Sonnet each needed two receiver startup
attempts because the first temporary tunnel hostname returned `ENOTFOUND`; Haiku
needed one. The final Mini regression also needed two receiver startup attempts.
Setup retries are bounded to three and run before provider calls. Their count
and failure categories remain in `snapshots/public-mcp-events.json`; they are not
hidden paid retries.

The first matrix retains a Mini callback-verification failure. The next selection
retains Mini/Sonnet public-receiver readiness failures with zero observed external
assistant requests. An independent probe reproduced temporary-tunnel DNS failure.
The harness now checks public readiness and retries a fresh tunnel before paying
for an assistant. Production callback verification and public-address checks were
not weakened. All 11 original attempts and their original grades remain; every
report's evidence packages validate, including failed attempts.

Source provenance (each campaign retains `source-files.json`):

- Pilot: base `dd27f4dea0040646d3e96b2cbf92086b421389fd`, working-tree digest
  `9f96066a4f1fb0374954a0e4e5b54eb0b37aca64f65e4343cf802d96152c05e3`.
- First matrix: same base, working-tree digest
  `f5ac7563a382e3e5c963e6986469242d492f58c4a677f70882714fba28969466`.
- Readiness selection: clean `fed6d7bab8831d5b62558cdaced3e45f3898184b`.
- Qualified matrix and final regression: clean commits stated above. Their empty
  working-tree manifests have SHA-256
  `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`.
- Suite definition for these runs:
  `013825c29cb522cbdc98cc07b6f6954a0d59c1d7c6d52e30f5b32e44bb0f7ca5`.
  Grader: `public-mcp-durable-state-v9`, including 11 new positive/negative
  event-oracle calibration cases.

Each campaign's report is retained locally at
`tests/runner-e2e/results/<campaign>/report/index.html`, alongside the original
attempts and source manifest. These ignored files are not published on GitHub.
The Events extension adds **$0.5901** of observed external-assistant estimates
and **$0.5600** of worker-reported charges across 11 attempts. Together with the
previous 200 attempts, the retained totals are **$9.6760** and **$13.2727**
respectively. These remain partial observations, not an invoice total; OpenAI
worker token usage is unpriced and interrupted usage may be unavailable.

Updated supporting verification:

- All 33 real MCP/OAuth tests and 892 eval-support tests pass, along with eval
  typecheck and server typecheck. The preceding combined MCP, log-redaction,
  private-address and DNS-rebinding run passed 129 tests; two subsequent MCP
  regressions cover quota reuse and unchanged-status suppression.
- All 28 adjacent issue-tree/stale-lock route tests pass after checkout/release
  activity gained previous/current status for event delivery.
- CI subsequently found that checkout logging dereferenced a null result in an
  existing concurrent workspace-reopen path. The log now omits status when no
  task is returned, preserving that path's response and avoiding a false event.
  The existing 12-test closed-workspace suite reproduces and verifies the fix.
  This narrow null-result correction follows the paid regression above.
- An exact-start boundary calibration also reproduced a missed event at the
  subscription's timestamp. Scanning now includes that timestamp; the existing
  verification-window test requires delivery at the exact start. This correction
  also follows the paid regression, and all 33 MCP tests pass afterward.
- Repository-wide typecheck and production build pass after merging master.
- The Core → Cloud → Core authority round trip passes real OAuth, MCP 2.0
  subscription, delivery, current Cloud membership loss, unsubscribe, legacy MCP
  tools, refresh and revocation. Its callback transport is injected and verifies
  HMAC independently; the paid campaigns separately prove public HTTPS delivery.
- Cloud's full root suite passes 2,095 tests with 64 opt-in skips. Root typecheck,
  smoke QA and all seven opt-in durable PostgreSQL tests pass after migration
  renumbering to `0055_assistant_mcp.sql`.

The delivery tests additionally cover persistence/restart, retries and stable IDs,
key rotation, expiration, revocation, company isolation, SSRF/log redaction,
changes during callback verification and late-committed activity. Stopped/expired
monitors release quota on the next admission; no replay after reclamation is
promised. Hosted monitors refresh within five minutes and never exceed their
Cloud authorization proof's expiry.

Actual ChatGPT Work Cloud/dot UI behavior, a deployed plugin rescan and hosted
staging acceptance remain release gates. The Anthropic paid cells exercise model
behavior through the same host fixture; they do not claim Claude product support
for OpenAI MCP Events. Legacy tool-based follow-up remains available.

To reproduce a cheap Events cell, install `cloudflared`, provide the existing
ignored eval credentials, then run:

```sh
pnpm test:e2e:runner -- --id public-mcp.assistant-codex-mini.local.event-follow-up
```

## Experimental-settings regression (2026-10-02)

The follow-up [#14933](https://github.com/paperclipai/paperclip/pull/14933)
replaces the tenant environment enable flag with Settings → Experimental →
Assistant connections (MCP), default off. Paid setup enables it through the
real authenticated administrator API before browser consent. It uses the
existing Product E2E fixtures, workers, grader and report generator.

| Campaign | Source SHA | Case / model | Result |
| --- | --- | --- | --- |
| `mcp-settings-mini-pilot-recovered-20261002` | `ae37308eab8724cb73fee8f4d2d572283011b87f` | Event follow-up / GPT-5.4 Mini | 1/1, first attempt; evidence valid |
| `mcp-settings-haiku-delegate-20261002` | `12b3f10e9a0f8874353af2522f15bc70325d1706` | Delegate and retrieve / Claude Haiku 4.5 | 1/1, first attempt; evidence valid |

Both source trees were clean when measured. Each retained campaign includes
`source-files.json` and `report/normalized-results.json` under the existing
ignored `tests/runner-e2e/results/` directory. The helper's source-ref label
still names the foundation branch; the exact SHA above identifies the settings
branch content. Mini observed `gpt-5.4-mini-2026-03-17`; Haiku observed
`claude-haiku-4-5-20251001`.

Mini proved one durable delegated task, worker report, verified public HTTPS
completion event and report retrieval in a fresh model conversation. Haiku
proved one durable delegated task/run and later report retrieval. Mini ran
before the subsequent delivery-pause race fix. Haiku ran with that fix. The
race itself has a deterministic regression: disable access immediately before
a sixth delivery attempt, retain the fifth-attempt receipt, re-enable access
and complete delivery. The focused MCP and settings UI suites pass 83 tests.
Workspace typecheck, build and evaluation typecheck also pass; server typecheck
was repeated after the race fix.

Retained setup failures are not model passes:

- `mcp-settings-mini-pilot-20261002`: two startup attempts failed because macOS
  had exhausted PostgreSQL shared-memory IDs. No model requests occurred.
  Three unattached 56-byte slots from exited processes were released; no live
  database was stopped. The successful campaign above is a separate run.
- `mcp-settings-haiku-20261002`: three bounded HTTPS tunnel setup attempts
  failed with `dns_not_found`, before any model call. The original result
  retains its harness `candidate_failure` classification; the observed cause
  is callback infrastructure. The replacement Haiku case checks delegation
  and retrieval without a callback and does not count as an event-case pass.

Across the two successful paid cells, external-assistant estimates total
**$0.0884547** (Mini $0.0142347; Haiku $0.07422). Haiku's worker reported
**$0.0451984**. Mini worker cost remains unpriced, so **$0.1336531 is a partial
observed/estimated subtotal, not the total invoice**. The failed setup attempts
made no model calls. No paid result is claimed for actual Codex/Claude desktop
UI, store installation, or hosted deployment in this regression.
