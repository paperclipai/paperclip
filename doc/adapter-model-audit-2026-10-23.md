# Adapter model and harness audit: October 23, 2026

This audit follows the [October 2, 2026 audit](adapter-model-audit-2026-10-02.md).
It covers model selection in the coding-agent adapters and the CLI pins in the
evaluation sandbox image. Catalog entries identify models; provider accounts
and installed CLIs determine access. No agent defaults or saved model
selections are migrated.

## Model changes

| Adapter | Changes from the audit |
| --- | --- |
| Codex | No new selectable model IDs. Codex 0.160.0 through 0.164.0 ship the same bundled model set, which the picker already lists (including GPT-6 Astra, GPT-5.6 Terra, and GPT-5.6 Luna). OpenAI retired `gpt-5.5` (October 14, 2026) and `gpt-5.4` / `gpt-5.4-mini` (August 31, 2026) from Codex with ChatGPT sign-in. The API and API-key Codex sessions still serve them, so they stay in the picker. When the backend rejects one of them for a ChatGPT account, the environment Test (legacy CLI and Paperclip Runner) now names the retirement and the documented replacement instead of suggesting a stale CLI, a plan restriction, or generic account checks. |
| OpenCode | Add `anthropic/claude-haiku-5-5` and `google/gemini-4-argon` to the static fallback used by remote environments and the Paperclip Runner picker. Both IDs are in the OpenCode model registry (models.dev). |
| Claude Code (direct and Bedrock) | Claude Haiku 5.5 is covered by [#16708](https://github.com/paperclipai/paperclip/pull/16708); this audit does not duplicate it. Haiku 5.5 needs Claude Code 2.1.293 or later and supports all five effort levels. |
| Gemini CLI | Gemini 4 Argon (`gemini-4-argon`) is generally available on the Gemini API, but Gemini CLI 0.65.0 does not register it. Deferred. |
| Grok Build, Kimi Code, Cursor | No new verified model IDs. Grok 4.7 and Kimi K3 remain the newest documented models. |

## Harness changes

| Harness | Before | After |
| --- | --- | --- |
| Grok CLI (`@xai-official/grok`) | 1.0.46 | 1.0.70 |
| Gemini CLI | 0.62.0 | 0.65.0 |
| Kimi Code CLI | 2.1.1 | 2.3.3 |
| Cursor CLI (sandbox layer) | 2026.10.01-e373342 | 2026.10.22-27dcf5f |
| GitHub CLI | 2.102.0 | 2.103.3 |
| Codex CLI (shared provider pack) | 0.160.0 | Unchanged here; [#17245](https://github.com/paperclipai/paperclip/pull/17245) moves it to 0.163.0 |
| Claude Agent SDK / Claude Code | 0.3.286 / 2.1.286 | Unchanged; see "Deferred items" |
| OpenCode (shared provider pack) | 1.18.34 | Unchanged; see "Deferred items" |
| Hermes | 0.19.0 | 0.19.0 (newest on PyPI) |

These pins change only the evaluation image's sandbox layer. They must stay
aligned with the fleet sandbox image definition.

## Sources and verification

Research date: October 23, 2026. Harness pins rechecked October 26, 2026.

- [Codex models](https://learn.chatgpt.com/docs/models) states the GPT-5.5
  retirement ("Effective October 14, 2026 ... GPT-5.5 retires from Codex for
  users signed in with ChatGPT"), its replacements (GPT-6.1 Sol on paid plans,
  GPT-6 Luna on Free and Go), the GPT-5.4 retirement and its replacements
  (`gpt-6-sol`, `gpt-6-luna`), and that API-key sessions are not affected.
- The bundled `codex-rs/models-manager/models.json` is unchanged in model set
  from [rust-v0.160.0](https://github.com/openai/codex/releases/tag/rust-v0.160.0)
  to [rust-v0.164.0](https://github.com/openai/codex/releases/tag/rust-v0.164.0),
  the npm `latest` release on October 26, 2026.
- [Claude Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
  was released October 7, 2026. The
  [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
  entry for 2.1.293 adds `claude-haiku-5-5`.
- [models.dev](https://models.dev/api.json) lists `anthropic/claude-haiku-5-5`
  and `google/gemini-4-argon`. The OpenCode 1.18.34 executable's bundled
  snapshot predates both. Paperclip Runner binds the selected model into the
  OpenCode provider configuration, so the snapshot does not limit it.
- [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)
  is generally available since October 13, 2026. Gemini CLI 0.65.0
  (`packages/core/src/config/models.ts`) has no entry for it, and pull requests
  adding it to the CLI are still open.
- Grok CLI 1.0.70, Gemini CLI 0.65.0, and Kimi Code 2.3.3 are the npm `latest`
  tags on October 26, 2026. xAI publishes no Grok CLI changelog; `-m`,
  `--effort`, and `grok models` are unchanged in the
  [CLI reference](https://docs.x.ai/build/cli/reference.md) and in
  `grok --help` from 1.0.70.
  [Kimi Code 2.2.0 and 2.3.0](https://github.com/MoonshotAI/kimi-code/releases)
  remove the `kaos` MCP executor and require qualified plugin skill names;
  Paperclip uses neither. Kimi Code 2.3.2 stops the agent from launching
  swarms by itself, so `kimi -p` and ACP sessions no longer start swarms;
  2.3.1 and 2.3.3 are fixes and prompt changes. `-m`, `-p`,
  `--output-format`, and `acp` are unchanged in `kimi --help` from 2.3.3.
  Gemini CLI 0.65.0 makes workspace settings read-only in untrusted folders;
  Paperclip writes only home settings and sets `GEMINI_CLI_TRUST_WORKSPACE`
  for remote runs.
- Cursor CLI 2026.10.22-27dcf5f is the version `https://cursor.com/install`
  resolves. The archive SHA-256 was computed from the versioned Linux x64
  tarball, and the extracted executable reports that version.
- [GitHub CLI 2.103.3](https://github.com/cli/cli/releases/tag/v2.103.3): the
  pinned digest matches the release `checksums.txt`. 2.103.1 through 2.103.3
  are fixes on top of 2.103.0.
- [Hermes on PyPI](https://pypi.org/project/hermes-agent/) remains at 0.19.0.
  Newer Hermes releases (v0.22.4) are published only through GitHub, the
  installer, and Docker.

## Deferred items

- **Claude runtime 2.1.286 → 2.1.308.** Claude Code's `stable` channel is
  2.1.308 (`latest` is 2.1.309), with Agent SDK 0.3.308. The range changes
  headless defaults that Paperclip runs depend on: fork subagents are on by
  default in `-p` and the Agent SDK (2.1.302), sessions with no permission
  mode start in `default` mode on third-party providers (2.1.302), and MCP
  allow rules match whole server names (2.1.299). This needs a separate runner
  qualification together with the patched `claude-agent-acp` bridge. Until then,
  Haiku 5.5 on the CLI lane needs a 2.1.293+ CLI. Once #16708 records that
  minimum, sandbox runs on an older image prepare a private CLI at the model
  minimum before launch.
- **OpenCode 1.19.x and 2.x.** OpenCode 1.19.3 generates reasoning variants
  from model options instead of catalog variants, which affects the variants
  Paperclip Runner binds. OpenCode 2 changes the SDK, event, and plugin
  contracts. Both need qualification.
- **ACP bridges.** ACPX 0.20.0, `claude-agent-acp` 0.94.0 (ACP SDK 2.0), and
  `codex-acp` 2.2.2 (breaking tool-call contract in 2.0.0) need a
  qualification campaign rather than a pin bump.
- **GitHub Copilot CLI 1.0.103.** The qualified Copilot profile binds
  Copilot 1.0.88 by immutable identity; a new profile version needs its own
  qualification. Copilot discovers models from the ACP session, so new Copilot
  models need no catalog change.
- **Pi 1.4.0** and **Hermes 0.22.x** need runtime qualification; Hermes no
  longer publishes to PyPI.
- **Gemini 4 Argon** in the Gemini CLI and Cursor catalogs: the CLI does not
  register it yet, and Cursor documents display names only.
- **Codex default model.** Codex 0.161.0 makes `gpt-6.1-sol` its default.
  Paperclip keeps `gpt-5.6-sol` so saved agents and spending do not change.
- **Hidden Codex aliases** (`gpt-daybreak-*`) are restricted to eligible
  accounts.
- **Claude Sonnet 4.5** is deprecated and retires November 30, 2026. It stays
  in the picker until then.
- **Claude Mythos 5.1** remains restricted to verified organizations.

## Host-environment baseline failures

Recorded once for this audit on the unchanged base (`c5ca29d`), Node 25.9.0:

- `server/src/__tests__/agent-hire-ai-connections.test.ts` fails at import
  with `AI_InvalidArgumentError: baseURL must be a non-empty string.` because
  the host injects an empty AI provider URL. Unrelated to this change.
