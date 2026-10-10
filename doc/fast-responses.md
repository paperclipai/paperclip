# Company fast responses

Fast response is an optional company service that acknowledges an accepted human turn while the assigned agent follows its normal execution path. It starts disabled. First enable **Experimental fast responses** in **Company settings → Experimental**; this reveals Connections below Environments and allows generation. Turning it off hides that page and suppresses new requests and pending delivery, while retaining settings, history, and recorded charges. Decision model setup remains accessible under General while the experiment is off. Configure a shared API connection and model in **Company settings → Connections → Fast response**, beside the decision model configuration. OpenRouter's recommended model is `openai/gpt-oss-120b`. Subscription accounts are ineligible.

The direct Vercel AI SDK service supports OpenAI Responses, Anthropic Messages, Google, xAI, OpenRouter, Bedrock, and connection-configured Responses, Messages, Chat Completions, and local endpoints. Routing, region, endpoint and authentication come from the saved connection. Model choices reuse existing catalogs; custom endpoints permit manual IDs. Decision-model execution is independent.

**Allow company-sponsored fast responses** defaults on. It covers accepted external senders without linked Paperclip users. A linked user must retain both task access and connection audience permission; denial never falls back to sponsorship. Connection management permissions govern settings, model selection and tests. Costs history uses company cost visibility, with task links checked separately.

## Accepted turns and receipts

Task creation, task comments (including comments submitted with updates), persistent agent chat, steering and queued follow-ups enqueue at human acceptance boundaries. Shared external chat intake covers the existing Slack, GitHub and other chat connectors; email has its own authorization and publication adapter. Experimental board chat uses the same inference service.

The durable request is unique by `(company_id, source_key)`. The worker runs at most eight pending requests per sweep, receives database work signals, and expires excess work. A claimed request is never regenerated after a restart. A stale claimed request becomes an unknown billing outcome with its reservation retained.

The visible acknowledgement is an ordinary attributed issue comment with server-owned `origin = fast_response`, a request reference and no heartbeat run. Its source turn is retained on the request. Message details explain its provenance. It must not settle a conversation, supersede an interaction, count as recovery progress, trigger an agent subscription, or inherit a worked-run summary. Agent context labels receipts and includes standing guidance to start substantive work without another generic acknowledgement. Receipt insertion does not steer or interrupt an active model.

## Bounded generation and delivery

The prompt includes the current message, agent name, accepted/queued state, permitted task title, up to two prior visible turns, and attachment names/types only. External adapters supply only destination-authorized context; they do not copy the internal task history. The serialized prompt has a 4 KiB limit, dropping older turns first and marking a shortened current message. Instructions are sent as a system message, with conversation content as untrusted data.

Generation requests one sentence (two permitted), at most 256 output tokens and 320 visible characters. Optional reasoning is disabled or minimized where supported. There are no tools, agent runtime, repository access or SDK retries. Empty, overlong, truncated, question-shaped or unsafe formatted output is discarded. The prompt prohibits invented findings, completed-work claims, questions and ETAs, and distinguishes queued work from execution.

The deadline is three seconds from acceptance through publication admission. Access, configuration, source validity, assignment, pause/cancellation, conversation generation and real-agent replies are checked before admission and again before the comment/outbox is committed. Native visible text also suppresses obsolete receipts. Failure quietly preserves existing progress feedback.

External publication uses the existing sanitized outbox, exact originating endpoint/conversation, transport leases and final authorization checks. Published contextual receipts suppress subsequent generic queued/working notices for the same turn. Reactions and typing remain on their existing paths. Expired receipts are not posted; ambiguous external attempts stay subject to existing delivery reconciliation rather than being blindly retried.

## Accounting and endpoints

Every dispatched attempt uses the existing accounting lock, budget checks, reservation and cost ledger with `usageKind = fast_response`. Settlement is idempotent and keeps actual charges even when output is suppressed. OpenRouter supplies reported costs. Direct OpenAI/Anthropic models covered by the repository's reviewed rate cards receive explicit estimates. Unsupported pricing and ambiguous network outcomes remain unpriced, never fabricated as zero; reservations remain held until billing reconciliation.

**Costs → Fast responses** shows connection, model, tokens, cost, timing, generation outcome and current publication outcome. Operational request rows contain identifiers and safe outcome codes, not prompts. Delivered comment text remains in conversation history.

Company-scoped endpoints under `/api/companies/:companyId/fast-response`:

| Method/path | Purpose |
| --- | --- |
| `GET /` | Settings, eligible shared connections, management capability |
| `PUT /` | Save enabled, connection/grant, model and sponsorship |
| `GET /models?connectionId=…` | Existing catalog or connection-configured models |
| `GET /availability` | Local authorization/connection availability, no inference |
| `POST /test` | Fixed border-styling sample; text, duration and usage; no conversation comment |
| `GET /history` | Metadata-only usage history with existing cost date/limit parameters |

## Verification

Provider-contract tests use the real SDK adapters with mocked HTTP, including endpoint/auth/model/output/token/abort/error behavior. Database tests cover deduplication, simultaneous workers, provenance, completion isolation, revoked audience access, real-reply races, source mutation/deletion/cancellation/reassignment, retained charges and unknown billing. Stories cover configured, disabled, revoked, testing, timeout, result and mobile settings states.

Live OpenRouter latency, prompt quality and complete Paperclip/Slack/GitHub journeys are a separate evidence category. Passing contract tests does not establish those live results. Live verification requires an authorized OpenRouter connection and designated channel test destinations.
