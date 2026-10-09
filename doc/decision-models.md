# Company decision models

Company Settings → General → **Decision model** configures one shared API connection for optional Paperclip features. New companies remain unconfigured. A connection manager selects or adds an OpenAI or OpenRouter connection, saves, and can run a small billed setup test. Test answers appear only in that session; request metadata and charges appear under Activity → Costs → Decisions.

**Allow company-sponsored background decisions defaults on.** Saving authorizes internal background features to charge the selected connection without a responsible human. An explicit off setting survives later edits, including changing the connection or omitting the field from an update. Deleting the selected connection or grant preserves the setting and blocks calls until a valid replacement is selected. Disabling decisions prevents new calls. It does not cancel or erase calls already dispatched.

V1 supports native OpenAI Decisions (`gpt-6-luna`) and OpenRouter Decisions (`typesafe/jev-1.13`). It accepts company-owned API keys only. Personal grants, subscription credentials, custom endpoints, fallback chains, images, and public agent/plugin execution tools are outside this version. Decision compatibility is separate from CLI-adapter compatibility.

## Internal service

Register a feature once in its server module, then call `decisionModelService(db)` with trusted server context:

```ts
const classifyTask = defineDecisionFeature("tasks.classify");
const service = decisionModelService(db, { budgetHooks });
const context = { companyId, actor: req.actor, feature: classifyTask, issueId };
const available = await service.availability(context);
if (!available.available) return existingBehavior();
const result = await service.decide(context, {
  state: { title: task.title },
  questions: {
    billing: { type: "boolean", instructions: "Is this about billing?" },
    team: { type: "choice", instructions: "Which team should handle it?",
      criteria: { billing: "Payments", support: "Product support" } },
    urgency: { type: "score", instructions: "How urgent is it?",
      criteria: ["Routine", "Soon", "Immediately"] },
  },
});
```

The setup test is the only product caller in this release. Future callers must supply the existing budget enforcement hooks, handle unavailable/failure outcomes, and select their own thresholds. Boolean answers are probabilities, choice answers select a category, and scores use the ordered criteria's zero-based positions. Available distributions and provider confidence are preserved in returned answers. `succeeded` and `failed` results include an invocation ID and usage with reported, estimated, or unknown cost. Refusals and invalid responses never become invented answers.

`availability` reads local configuration and permissions only. It does not decrypt credentials, contact a provider, or promise reachability/budget admission. `availabilityForRequest()` returns a memoizing function; keep that function and its context object within one request. Dispatch never trusts this cached authorization.

Human calls use the authenticated user and retain the connection's audience checks. Agent calls reread the active persisted run and its current responsible user, check that user's current membership/resource access, and require an applicable agent/company connection installation. Task and project references must belong to that run/company. Attribution snapshots the effective identity at dispatch. Explicit internal system contexts additionally require a feature registered with `{ background: true }` and company sponsorship. A denied user/agent call cannot fall back to system context.

Credentials are resolved through the existing secret service immediately before admission, with the actual user/agent/system audit attribution. Authorization, connection/configuration revisions, current run identity, and budgets are rechecked before dispatch. Requests allow 1–20 named questions, text/JSON state, and at most 32 KB serialized request data. Execution is limited to 30 seconds and SDK paid retries are disabled.

## Accounting and privacy

`decision_invocations` records feature, actor/responsible user, applicable task/project/agent/run and identity revision, connection/grant, provider/model, request ID, timing, status, question types/count, token counters, and a cost-ledger reference. It does not store state, question text, answers, or raw provider payloads. SDK input/output telemetry is disabled and provider errors are reduced to bounded codes. These are local database records, not first-party telemetry events.

Cost events have `usageKind: decision` and may have no agent. Agentless reporting uses **Paperclip services**. The public agent cost-reporting API still requires an agent; only the internal service receipt path accepts agentless charges. Decision events snapshot responsible-user attribution; historical run costs continue to use their existing attribution rules. Decision events have no heartbeat receipt reference, so run receipt reconciliation cannot count them again.

Admission and settlement use the company accounting lock. Company and applicable agent/project budgets include held reservations and observed spend. Reservations use the largest configured applicable reservation amount. Settlement is idempotent. Explicit provider authentication/validation/rate-limit rejection releases the hold when no model work occurred. Uncertain dispatches, timeouts, and unknown prices remain unpriced with the reservation held. Startup/periodic accounting recovery marks stale invocations interrupted without resubmitting them. Use the existing audited cost adjustment workflow to resolve the charge and release its hold, including a verified zero charge when appropriate.

OpenRouter-reported USD costs are converted to fractional cents. OpenAI uses a dedicated, versioned Decisions rate snapshot: $0.10 per million input tokens for the bounded short requests at the native default endpoint. No chat-model price is substituted. Missing usage or an unsupported rate stays unknown; it is never displayed as a free request. The ledger retains seven decimal places in cents. Pricing provenance accompanies the cost event and remains available to accounting corrections.

History follows company cost visibility and rechecks task access before returning task/run links. It shows the latest 100 requests in the selected date window. Input/output contents remain absent after refresh.

## HTTP surface

All paths are under `/api/companies/:companyId/decision-model`:

| Method/path | Access and behavior |
| --- | --- |
| `GET /` | Board; returns manager capability and settings/compatible choices to connection managers |
| `PUT /` | Connection manager; validates and audits configuration |
| `GET /availability` | Authenticated company caller; local authorization check |
| `POST /test` | Connection manager; fixed server-owned three-question sample, ignoring client prompts/identity |
| `GET /history` | Existing company cost-read rules; date bounds and limit up to 500 |

There is no general HTTP decision execution endpoint.

## Provider dependencies and verification

The experimental Vercel contract is hidden behind Paperclip-owned types. Dependencies are pinned to `ai@7.0.130`, `@ai-sdk/openai@4.0.86`, and `@openrouter/ai-sdk-provider@3.1.0`. That OpenRouter release calls its compatible model factory `evaluationModel`; the wrapper adapts it to the current Decisions interface. Upgrade these together and rerun native wire-format tests.

CI owns lockfile updates. Before a direct Docker build of a feature checkout whose dependency manifests changed, refresh the local build context with `pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile`. Do not commit that generated lockfile; the hosted Docker workflow performs the same preparation and the lockfile bot updates master.

References: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), [Vercel AI SDK](https://ai-sdk.dev/docs/reference/ai-sdk-core/decide), [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request).

Automated coverage lives in the provider contract and database-backed decision service tests. Provider tests use actual pinned SDK adapters with simulated HTTP responses; they do not establish live account/model availability. Storybook's **Decision models** group uses production components and includes settings states, metadata history, and a settings-to-history journey. A live acceptance check must run the fixed setup test with each authorized shared provider connection and inspect the corresponding persisted invocation/charge. Record live and simulated evidence separately.
