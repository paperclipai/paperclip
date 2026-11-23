# Company decision models

Decision model setup remains available in Company Settings → General when fast responses are off. Enabling **Experimental fast responses** in Company Settings → Experimental moves model setup to the Connections page. Company Settings → Connections → **Decision model** configures one shared API connection for optional Paperclip features. New companies remain unconfigured. A connection manager selects or adds an OpenAI, OpenRouter, or gateway API connection, picks a model, saves, and can run a small billed setup test. Test answers appear only in that session; request metadata and charges appear under Activity → Costs → Decisions.

**Allow company-sponsored background decisions defaults on.** Saving authorizes internal background features to charge the selected connection without a responsible human. An explicit off setting survives later edits, including changing the connection or omitting the field from an update. Deleting the selected connection or grant preserves the setting and blocks calls until a valid replacement is selected. Disabling decisions prevents new calls. It does not cancel or erase calls already dispatched.

Supported connections are company-owned API keys only:

| Connection | Protocol | Default model |
| --- | --- | --- |
| Native OpenAI | Decisions API | `gpt-6-luna` |
| OpenRouter (official endpoint) | Decisions API | `typesafe/jev-1.13` |
| Gateway with the Chat Completions protocol | JSON answer fallback over `POST {baseUrl}/chat/completions` | first model configured on the connection, otherwise none |
| Gateway with the Messages protocol | JSON answer fallback over `POST {baseUrl}/messages` | first model configured on the connection, otherwise none |

The model is selectable. Settings accept an optional `model`; omitting it keeps the saved model for the same connection and otherwise uses the connection's default. `null` resets to the default. A connection without a default model must be saved with a model before decisions can be enabled. The picker lists models from the connection and also accepts a typed model ID.

Personal grants, subscription credentials (including Claude and ChatGPT subscriptions), local endpoints, fallback chains, and images are outside this version. Decision compatibility is separate from CLI-adapter compatibility.

### Gateway JSON fallback

Gateways do not offer the Decisions API. Paperclip sends the state and questions in one request with instructions to reply with a single JSON object `{"answers": {...}}` that has exactly one entry per question:

- boolean: `{"probability": 0..1}`
- choice: `{"choice": "<one of the criteria keys>"}`
- score: `{"score": <integer index into the ordered criteria>}`

Each answer may include `confidence` (0..1). A single fenced JSON block is accepted. Any other reply (prose, missing or extra answers, unknown choices, out-of-range values, fractional scores) fails the invocation with `invalid_response`; no answer is invented. Requests use plain HTTPS with the connection's bearer or API-key header, a 30 second timeout, `temperature: 0`, at most 2000 output tokens, and no retries. Replies larger than 1 MB are rejected. Token usage comes from the response. Cost is unpriced unless the gateway reports `usage.cost` in USD.

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

Trusted server callers may set `connectionId` and `model` on the context to override the company default for one call (see plugins below). The setup test and plugins are the product callers in this release. Future callers must supply the existing budget enforcement hooks, handle unavailable/failure outcomes, and select their own thresholds. Boolean answers are probabilities, choice answers select a category, and scores use the ordered criteria's zero-based positions. Available distributions and provider confidence are preserved in returned answers. `succeeded` and `failed` results include an invocation ID and usage with reported, estimated, or unknown cost. Refusals and invalid responses never become invented answers.

`availability` reads local configuration and permissions only. It does not decrypt credentials, contact a provider, or promise reachability/budget admission. `availabilityForRequest()` returns a memoizing function; keep that function and its context object within one request. Dispatch never trusts this cached authorization.

Human calls use the authenticated user and retain the connection's audience checks. Agent calls reread the active persisted run and its current responsible user, check that user's current membership/resource access, and require an applicable agent/company connection installation. Task and project references must belong to that run/company. Attribution snapshots the effective identity at dispatch. Explicit internal system contexts additionally require a feature registered with `{ background: true }` and company sponsorship. A denied user/agent call cannot fall back to system context.

Credentials are resolved through the existing secret service immediately before admission, with the actual user/agent/system audit attribution. Authorization, connection/configuration revisions, current run identity, and budgets are rechecked before dispatch. Requests allow 1–20 named questions, text/JSON state, and at most 32 KB serialized request data. Execution is limited to 30 seconds and SDK paid retries are disabled.

## Plugins

Plugins that declare the `decisions.invoke` capability get `ctx.decisions`:

```ts
const { companyDefault, connections } = await ctx.decisions.connections({ companyId });
const { models, errorCode } = await ctx.decisions.models({ companyId, connectionId });
const result = await ctx.decisions.decide({ companyId, issueId, connectionId, model, state, questions });
```

`companyDefault` is `null` when decisions are not enabled. `connections` lists the company's active, enabled, compatible API-key connections with `provider` (`openai`, `openrouter`, or `gateway`) and `protocol` (`decisions`, `chat`, or `messages`). No credential or endpoint is returned.

`decide` returns the shared `DecisionResult`. Without `connectionId` and `model` it uses the company default. A given `connectionId` must be an active, enabled, compatible API-key AI connection of the same company, otherwise the result is `{ status: "unavailable", reason: "incompatible_connection" }`. A `model` without a `connectionId` uses the default connection with that model. Calls run as an explicit internal system context with the feature `plugin.<plugin key>` (lowercased; other characters replaced by `-`), registered with `{ background: true }`. They therefore require decisions to be enabled and **Allow company-sponsored background decisions** to be on, even when an override connection is given. An `issueId` must belong to the company. Budget admission, the invocation ledger, cost events, request limits, and privacy rules are the same as for other callers; plugin calls appear under Activity → Costs → Decisions with their feature.

The SDK test harness exposes the same client. It returns an empty configuration and `not_configured` by default; `harness.setDecisions({ connections, models, decide })` stubs it, and `harness.decisionCalls` records `decide` inputs.

## Accounting and privacy

`decision_invocations` records feature, actor/responsible user, applicable task/project/agent/run and identity revision, connection/grant, provider/model, request ID, timing, status, question types/count, token counters, and a cost-ledger reference. It does not store state, question text, answers, or raw provider payloads. SDK input/output telemetry is disabled and provider errors are reduced to bounded codes. These are local database records, not first-party telemetry events.

Cost events have `usageKind: decision` and may have no agent. Their biller is the decision provider (`openai`, `openrouter`, or `gateway`); the provider is the model's vendor prefix when the model ID has one. Agentless reporting uses **Paperclip services**. The public agent cost-reporting API still requires an agent; only the internal service receipt path accepts agentless charges. Decision events snapshot responsible-user attribution; historical run costs continue to use their existing attribution rules. Decision events have no heartbeat receipt reference, so run receipt reconciliation cannot count them again.

Paid admission and settlement use independent operation transactions. Admission keeps shared manual-control fences and best-effort budget observations; concurrent starts can exceed the same observed balance. Settlement does not acquire a company writer mutex. Company and applicable agent/project budgets include held reservations and observed spend. Reservations use the largest configured applicable reservation amount. Settlement is idempotent. Explicit provider authentication/validation/rate-limit rejection releases the hold when no model work occurred. Uncertain dispatches, timeouts, and unknown prices remain unpriced with the reservation held. Startup and deadline-driven accounting recovery marks stale invocations interrupted without resubmitting them. Late authoritative receipts can correct provisional interrupted accounting without another provider call. Use the existing audited cost adjustment workflow to resolve an otherwise unknown charge and release its hold, including a verified zero charge when appropriate.

OpenRouter-reported USD costs are converted to fractional cents. OpenAI uses a dedicated, versioned Decisions rate snapshot: $0.10 per million input tokens for the bounded short requests at the native default endpoint. No chat-model price is substituted. Missing usage or an unsupported rate stays unknown; it is never displayed as a free request. The ledger retains seven decimal places in cents. Pricing provenance accompanies the cost event and remains available to accounting corrections.

History follows company cost visibility and rechecks task access before returning task/run links. It shows the latest 100 requests in the selected date window. Input/output contents remain absent after refresh.

## HTTP surface

All paths are under `/api/companies/:companyId/decision-model`:

| Method/path | Access and behavior |
| --- | --- |
| `GET /` | Board; returns manager capability and settings/compatible choices to connection managers |
| `PUT /` | Connection manager; validates and audits configuration |
| `GET /models?connectionId=` | Connection manager; `{ models: [{ id, name }], errorCode? }` from the connection (OpenRouter public list, OpenAI `/v1/models`, or the gateway's `GET {baseUrl}/models`). 10 second timeout, at most 1000 models and 8 MB; failures return an empty list with an error code |
| `GET /availability` | Authenticated company caller; local authorization check |
| `POST /test` | Connection manager; fixed server-owned three-question sample, ignoring client prompts/identity |
| `GET /history` | Existing company cost-read rules; date bounds and limit up to 500 |

There is no general HTTP decision execution endpoint. Plugins use the `decisions.invoke` capability instead.

## Provider dependencies and verification

The experimental Vercel contract is hidden behind Paperclip-owned types. Dependencies are pinned to `ai@7.0.130`, `@ai-sdk/openai@4.0.86`, and `@openrouter/ai-sdk-provider@3.1.0`. That OpenRouter release calls its compatible model factory `evaluationModel`; the wrapper adapts it to the current Decisions interface. Upgrade these together and rerun native wire-format tests.

CI owns lockfile updates. Before a direct Docker build of a feature checkout whose dependency manifests changed, refresh the local build context with `pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile`. Do not commit that generated lockfile; the hosted Docker workflow performs the same preparation and the lockfile bot updates master.

References: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), [Vercel AI SDK](https://ai-sdk.dev/docs/reference/ai-sdk-core/decide), [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request).

Automated coverage lives in the provider contract and database-backed decision service tests. Provider tests use actual pinned SDK adapters with simulated HTTP responses; they do not establish live account/model availability. Storybook's **Decision models** group uses production components and includes settings states, metadata history, and a settings-to-history journey. A live acceptance check must run the fixed setup test with each authorized shared provider connection and inspect the corresponding persisted invocation/charge. Record live and simulated evidence separately.
