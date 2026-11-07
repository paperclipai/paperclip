# New-agent setup prerequisites

Reviewed against the adapter builders, runtime probes, and provider documentation on 2026-09-08.

| Adapter | Setup connection/prerequisites | Model and effort in setup |
| --- | --- | --- |
| Claude Code / Codex | Existing subscription/API connection step | Searchable model; supported effort options |
| Paperclip Runner | The selected Codex, Claude ACPX, or OpenCode connection | Provider model; no generic effort setting |
| Cursor CLI | `CURSOR_API_KEY`, existing organization secret, or host `agent login` | Model; no generic effort (Cursor uses modes) |
| Cursor Cloud | Enter a new `CURSOR_API_KEY` and repository URL; optional starting branch/ref. The key is saved as a new organization secret; setup does not reuse existing keys. | Account-default model; no generic effort |
| Gemini CLI | `GEMINI_API_KEY`, existing organization secret, or supported host login | Model; no effort control |
| Kimi Code | Host login, or `KIMI_MODEL_API_KEY` plus `KIMI_MODEL_NAME`; optional protocol/base URL | Existing model alias for host login; API model name for API auth; no effort on default ACP lane |
| Grok Build | Host `grok login` | Model and reasoning effort |
| Hermes | Provider API key or existing host configuration | Model; keep optional CLI tuning in full configuration |
| Hermes Gateway | API base URL and `API_SERVER_KEY` | Model is controlled by the gateway; no effort control |
| OpenCode / Pi | Provider/model ID and optional provider key/organization secret | Model; Pi thinking levels; OpenCode-specific variants remain in full configuration |

## Contracts and regression coverage

- Cursor Cloud sends `repoUrl` and `repoStartingRef`, matching its SDK adapter. It never sends the old, ignored `repository`/`branch` properties.
- New runtime keys are stored as distinct organization secrets when setup completes. They do not rotate existing keys. Existing Claude/Codex connection flows retain their user-specific credential behavior.
- A draft key goes only into the allowlisted `testCredentials` request field during testing. It does not pass through persistence normalization. Hermes Gateway's one-shot key maps to its top-level `apiKey` only after normalization.
- Failed tests and abandoned forms do not create secrets. A failed hire removes the newly created secret; cleanup errors remain visible.
- Kimi API mode omits `config.model`: passing `--model` would override the model synthesized from `KIMI_MODEL_*` variables.
- `ui/src/pages/NewAgent.test.tsx` covers field visibility, request payloads, secret reuse/storage, failure cleanup, and Kimi/Hermes mappings. `server/src/__tests__/agent-test-environment-routes.test.ts` verifies transient credential handling and rejects arbitrary environment variables.

UI and mocked contract tests do not prove a provider account can run a task. Successful live authentication requires the user's credential and, for Cursor Cloud, a repository connected to that Cursor account. The live invalid-key browser check verifies that a populated repository no longer produces the missing-repository diagnostic.

## Provider references

- [Cursor Cloud API](https://prod.cursor.com/docs/cloud-agent/api/endpoints) and [source-control prerequisites](https://prod.cursor.com/docs/cloud-agent).
- [Kimi environment-defined models](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html).
- [Grok CLI sign-in](https://docs.x.ai/build/cli/reference).
