# How a Paperclip agent resolves its model

An agent stores one string in `adapterConfig.model`. What the string must look like is decided by whether the agent is bound to a company AI connection, not by the adapter type and not by the current value alone.

## Connection-backed models

An agent is connection-backed when `runtimeConfig.aiConnection` holds a binding. Paperclip then supplies the provider, base URL, credential, and wire protocol from that connection, and the model string names a model inside it.

The harness and the bound connection's route decide the format, following `aiRoutingModel()`:

| Harness (`agentHarnessType`) | Value written |
| --- | --- |
| `opencode_local` | `openrouter/<id>` for OpenRouter; `paperclip/<id>` for other routes |
| `pi_local` | `openrouter/<id>` for OpenRouter; `<provider>/<id>` for a native provider |
| other harnesses | bare `<id>` |

- Valid ids: `GET /api/companies/{companyId}/ai-connections` → `connections[].routing.models[].id`.
- Supply `--connection-model` as an upstream ID, not a preformatted harness value. For example, `beam-free` becomes `paperclip/beam-free` for a gateway-backed OpenCode agent and remains `beam-free` for Codex. The upstream OpenRouter ID `openrouter/auto` becomes `openrouter/openrouter/auto` for OpenCode and Pi; Codex and Claude retain `openrouter/auto`.
- `routing` is optional. A native OpenRouter account stores no route, and a `responsible_user` binding names no connection, yet both still resolve. The prefix follows the provider in those cases: OpenRouter takes `openrouter/`, and Pi takes `<provider>/` because `isAiConnectionCompatible()` requires it for every Pi binding.
- An OpenCode agent on a native account whose provider is not OpenRouter has no derivable prefix: Paperclip leaves that harness on its own provider configuration, and the API does not say which shape it expects. The script blocks the target and names the reason instead of writing a guess.
- A record with no binding whose value still starts with `paperclip/` is read as connection-backed, so older data keeps working.
- A model missing from the bound connection's advertised list cannot be validated against that list. Saving a value alone does not prove that the next run will succeed.
- For an explicit binding, validate against that connection rather than the union of company connections. A legacy `paperclip/` value without a binding can only be checked against the union; confirm its intended connection separately. If a bound route needed for prefix selection is unavailable, the script blocks the target instead of guessing from another connection.

## Provider-resolved models

Anything else is passed to whatever the agent's harness uses: a local CLI's own configuration, a gateway alias, an OpenRouter-style id, or a direct provider id.

Examples of the same field holding different kinds of value:

| Agent | Value | Resolved by |
| --- | --- | --- |
| `paperclip_runner` | `paperclip/beam-free` | a Paperclip AI connection |
| `paperclip_runner` | `opencode-go-beam-free` | the local gateway that fronts the provider, when no connection is bound |
| `codex_local` | `gpt-5` | Codex's own configuration |
| `claude_local` | `claude-sonnet-4-5` | the Claude CLI's own configuration |

Paperclip cannot verify this value. If a gateway is configured (`--gateway-url`, `PAPERCLIP_GATEWAY_URL`), the script compares against its `/v1/models`; otherwise the plan reports `unverified` and leaves the judgement to the operator.

## Reasoning suffix

Some agents carry a trailing `(max)`, `(high)`, `(medium)`, or `(low)` on the model string. It is a reasoning-effort hint read by the harness, not part of the model id. The script preserves an existing suffix when the model changes and strips it from validation lookups. Pass `--drop-suffix` when the target provider would treat the suffix as part of the id.

## Failure signatures

- Written fine, fails on the next turn, model echoed back in the error: the value belongs to the other family.
- `422` answered in milliseconds: the gateway or server rejected the request locally. Read the body before changing models.
- `429` with `Retry-After`: rate limit or exhausted free tier. Another model may dodge it; changing models does not lift the limit on the same one.
- Agent stays idle after the switch: check the agent's lifecycle state and pause reason before suspecting the model.
