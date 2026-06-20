# GPT-5.5 Fleet Cost Exposure Review

Date: 2026-06-20

Issues: LIB-638, LIB-641

## Summary

The FinOps alert is valid. GPT-5.5 usage is present in the current Codex local fleet, with high token volume over a short window, weak OpenAI prompt-cache reuse in newer telemetry, and no dollar-cost accounting recorded in Paperclip.

The immediate risk is not just model choice. Paperclip is currently reporting token volume with `costCents: 0`, `budgetMonthlyCents: 0`, and `spentMonthlyCents: 0`, so budget enforcement cannot catch this exposure. The cache-prefix implementation path is already represented by PR #8392 from LIB-636; this report remains the audit and review artifact for Alex.

## Evidence

The LIB-638 issue payload reported this 5-hour GPT-5.5 window on 2026-06-20:

| Agent | Input | Cached input | Cache ratio |
| --- | ---: | ---: | ---: |
| Software Engineer | 80M | 72M | 90% |
| Site Reliability Engineer | 49M | 44M | 90% |
| Code Reviewer | 44M | 41M | 92% |
| CTO | 44M | 42M | 95% |
| Security Engineer | 41M | 37M | 91% |
| Memory & Context Engineer | 30M | 27M | 89% |

Total: about 288M input tokens in 5 hours, with about 263M cached input tokens.

LIB-641 later reported a broader same-day `openai/gpt-5.5` exposure row:

| Metric | Value |
| --- | ---: |
| Fresh input tokens | 356,254,571 |
| Cached input tokens | 321,604,864 |
| Output tokens | 2,624,059 |
| Total tokens | 680,483,494 |
| Cache hit | 47.44% |
| Cold share | 52.56% |
| Recorded spend | $0.00 |

The same LIB-641 snapshot reported Anthropic at 20,752,239 fresh input tokens, 1,468,662,306 cached input tokens, and 10,427,038 output tokens, for a 98.61% cache hit rate. If GPT-5.5 matched that 98.61% cache hit on the same 677,859,435 prompt-token base, fresh input would drop to about 9,422,246 tokens, avoiding about 346,832,325 fresh input tokens in the observed window.

Paperclip API checks during this review showed:

| Check | Result |
| --- | --- |
| Company cost summary | `spendCents: 0`, `budgetCents: 0`, `utilizationPercent: 0` |
| By-agent cost rows | Large token counts present, all `costCents: 0` |
| CTO detailed config | `adapterType: codex_local`, `adapterConfig.model: gpt-5.5` |
| Other five named agents | `adapterType: codex_local`, no explicit `adapterConfig.model` |
| Codex local adapter default | Code default is `gpt-5.3-codex`; empty model omits `--model`, allowing the Codex CLI subscription default to select GPT-5.5 |
| Available cheap profile | `gpt-5.3-codex-spark` with `modelReasoningEffort: high` |

## Pricing Basis

OpenAI's API pricing page lists GPT-5.5 standard short-context prices per 1M tokens as:

| Token class | Price |
| --- | ---: |
| Input | $5.00 |
| Cached input | $0.50 |
| Output | $30.00 |

The GPT-5.5 pricing table also lists long-context standard prices at 2x input, 2x cached input, and 1.5x output for the full session. This review uses the lower short-context standard price unless noted, so the estimate is conservative for long-context runs.

Sources:

- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-5.5

## Exposure Estimate

Input-side cost for the 5-hour LIB-638 window:

| Agent | Uncached input | Cached input | Estimated input-side cost |
| --- | ---: | ---: | ---: |
| Software Engineer | 8M | 72M | $76.00 |
| Site Reliability Engineer | 5M | 44M | $47.00 |
| Code Reviewer | 3M | 41M | $35.50 |
| CTO | 2M | 42M | $31.00 |
| Security Engineer | 4M | 37M | $38.50 |
| Memory & Context Engineer | 3M | 27M | $28.50 |

Total input-side estimate for the 5-hour window: $256.50.

Linearized run rate from that 5-hour window:

| Period | Input-side estimate |
| --- | ---: |
| 24 hours | $1,231.20 |
| 30 days | $36,936.00 |

This excludes output tokens, long-context multipliers, priority/fast processing, tool charges, and any non-listed agents. It is therefore a lower-bound exposure estimate.

Using the currently stored by-agent token ledger for the six named agents, and pricing those stored uncached input, cached input, and output tokens at GPT-5.5 standard rates, the implied exposure is about $2,829.36 for the stored ledger rows. Paperclip records that as $0 today.

LIB-641 same-day exposure estimate:

| Basis | Estimate |
| --- | ---: |
| Standard short-context GPT-5.5 rate | $2,020.80 |
| Standard long-context GPT-5.5 rate | $4,002.23 |
| Fresh-input exposure avoidable at Anthropic-equivalent cache hit | $1,734.16 |

These figures remain estimates because Paperclip currently records the events as subscription-included and does not apply price mapping to the ledger rows.

## Root Cause Assessment

1. The CTO is explicitly configured to use GPT-5.5.
2. The other named agents do not show explicit model overrides in the agent API.
3. The Codex local adapter omits `--model` when `adapterConfig.model` is empty.
4. Adapter source comments state that an empty model lets the Codex CLI pick its subscription default, which is GPT-5.5 on subscription auth.
5. Paperclip's cost ledger is not converting subscription token telemetry into cost events.
6. Company and agent monthly budgets are zero, so the 80% and 100% budget gates cannot protect spend.
7. The cache-prefix code mitigation for fresh Codex sessions is already proposed in PR #8392 from LIB-636. That change reorders fresh-session prompt assembly so the stable heartbeat template precedes issue-specific wake payload text, which should improve OpenAI prefix-cache reuse without disabling any work.

## Proposed Mitigation

Do not make live config changes without Alex approval. The approval-gated implementation should:

1. Review and merge PR #8392 if Alex accepts the scoped cache-prefix mitigation.
2. Pin bulk worker agents to an explicit cheaper model profile, starting with `gpt-5.3-codex-spark` for routine worker/reviewer lanes.
3. Keep GPT-5.5 available only for roles or tasks where frontier reasoning is explicitly required.
4. Add a FinOps guardrail that treats empty `codex_local.adapterConfig.model` as a cost-risk state when Codex CLI would default to GPT-5.5.
5. Fix Paperclip cost accounting so subscription token telemetry produces nonzero `costCents`.
6. Set monthly budgets on company and high-volume agents so the documented budget thresholds can fire.
7. Add a regression check that prevents new Codex local agents from silently inheriting GPT-5.5 as the runtime default.

## Acceptance Criteria For Follow-Up

- Every active Codex local agent has an explicit model policy: frontier, standard, or cheap.
- At least the Software Engineer, SRE, Code Reviewer, Security Engineer, and Memory & Context Engineer no longer inherit GPT-5.5 through an empty model config unless Alex approves that role.
- Company and by-agent cost endpoints report nonzero `costCents` when token telemetry is present.
- A test or documented verification demonstrates that an empty Codex local model config is detected as a FinOps risk.
- Alex receives a before/after table showing expected monthly run-rate reduction.

## Verification

Commands run:

- `GET /api/issues/{issueId}/heartbeat-context`
- `GET /api/companies/{companyId}/costs/summary`
- `GET /api/companies/{companyId}/costs/by-agent`
- `GET /api/companies/{companyId}/costs/by-project`
- `GET /api/agents/{agentId}` for the six named agents
- `GET /api/companies/{companyId}/adapters/codex_local/models`
- Official OpenAI API pricing page checked on 2026-06-20

No live agent configuration, budget, deployment, database, or infrastructure changes were made.
