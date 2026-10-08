# Harnesses and runners

Users choose a harness. New agents use Paperclip Runner when that harness and execution target are qualified; Advanced offers a Legacy runner override. The choice is resolved when saving and remains fixed for existing agents, pending hire approvals, and exported packages. Unrelated edits never reselect a runner.

| Harness | Default on a qualified target |
| --- | --- |
| Codex | Paperclip Runner, native Codex |
| Claude Code | Paperclip Runner, ACPX Claude |
| OpenCode | Paperclip Runner, OpenCode |
| Grok Build | Paperclip Runner, ACPX Grok |
| Cursor | Paperclip Runner, ACPX Cursor |
| Gemini, Kimi, Hermes, Pi, Cursor Cloud, gateways, process/HTTP and external adapters | Existing adapter |

Pi and Copilot remain outside production native defaults. Disabled adapters, active external overrides, platform qualification and environment-driver support constrain automatic selection. An unsupported execution combination selects legacy; missing dependencies, invalid models, incompatible settings and authentication failures do **not** cause fallback. Setup reports the missing prerequisite and offers the explicit Legacy runner choice.

## API and CLI

Creation, hiring, setup tests, built-in provisioning and import overrides accept optional `runner: "auto" | "paperclip" | "legacy"`. Omission means automatic selection for a new agent. The CLI exposes `agent create --runner` and `agent hire --runner`. Supply a harness adapter type such as `codex_local`; the server resolves the execution contract before credentials, instructions and skill normalization.

```json
{
  "name": "Builder",
  "adapterType": "codex_local",
  "runner": "auto",
  "adapterConfig": { "model": "gpt-5.6-sol", "modelReasoningEffort": "high" }
}
```

Native storage remains `adapterType: "paperclip_runner"` plus `provider` and, for ACPX, `acpxAgent`. Legacy storage retains the original adapter type. There are no agent-table changes. Existing requests with an explicit native adapter/profile remain supported. Unknown providers are rejected; they never become Codex.

Cursor requires an explicit model (not `auto`). OpenCode requires a `provider/model` identifier. Codex reasoning effort is retained. Custom CLI commands, arguments, unsupported effort/search settings and incompatible permissions produce field-specific errors: remove those fields or request `runner: "legacy"`.

PATCH without `runner` preserves the existing execution choice. An explicit change uses ordinary configuration revision and session invalidation. Active and recovered runs keep their recorded execution configuration; transcripts use the run's adapter identity.

Exports record the resolved runner in the adapter extension. New imports with no runner choice use automatic resolution. Updates preserve the existing agent's choice unless the package or override explicitly changes it. Hire approvals activate the already reviewed, resolved configuration.

## Accounts and managed services

Authentication, account reuse, model catalogs and agent branding follow harness identity. Execution, sessions, transcripts and skill delivery follow runner identity. Claude Code always means the Claude CLI harness. Claude Managed and AWS AgentCore are separate advanced profiles and retain their qualification, credential, retention and spending requirements.

The `enableNativeRunner` experimental field is deprecated compatibility data and has no execution effect. Native runner setup checks the runner binary in the selected environment in addition to the provider's dependencies and authentication. Packaged installations and standard images ship the runner; source development prepares it at startup. Custom environments must provide the qualified runtime and provider artifacts. See [Grok installation](grok-native-runner.md) for its pinned executable requirement.

## Verification

Use the real `paperclipai test-drive` server to verify creation, task execution, follow-up and reload. A passing UI test or legacy authentication probe is not proof of native execution. `test-drive --harness grok --model grok-4.7` can use an existing `XAI_API_KEY`; Cursor requires both credentials and `--model`. Managed acceptance requires an authorized target and bound credentials. Record unavailable prerequisites explicitly.
