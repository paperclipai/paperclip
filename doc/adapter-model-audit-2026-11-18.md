# Adapter model and harness audit: November 18, 2026

This audit follows the [October 23, 2026 audit](adapter-model-audit-2026-10-23.md).
It covers model selection in the coding-agent adapters and the CLI pins in the
evaluation sandbox image. Catalog entries identify models; provider accounts
and installed CLIs determine access. No agent defaults or saved model
selections are migrated.

## Model changes

| Adapter | Changes from the audit |
| --- | --- |
| Claude Code (direct and Bedrock) | Add Claude Fable 5.2 (`claude-fable-5-2`; Bedrock `global.anthropic.claude-fable-5-2`) at the top of the picker. Fable 5.1 stays selectable after the current-generation models. Fable 5.2 supports all five effort levels and needs Claude Code 2.1.321 or later. The CLI-lane Test and launch report that minimum. Paperclip Runner (ACPX Claude) now rejects a model whose minimum is above the Claude Code that its Agent SDK bundles, with a named version error. |
| Codex | Add `gpt-6.2-sol` and `gpt-6.2-astra` with Fast mode and the `low` to `ultra` efforts. Both need Codex 0.169.1 or later. On an older CLI, native Codex runs fall back to `gpt-6.1-sol` or `gpt-6-astra` and show a message. ACPX Codex in Paperclip Runner rejects them before launch with a named version error. The default stays `gpt-6.1-sol`. |
| OpenCode | Add `openai/gpt-6.2-sol`, `openai/gpt-6.2-astra`, `anthropic/claude-fable-5-2`, `google/gemini-4-carbon`, and `google/gemini-4-hydrogen` to the static fallback. All five IDs are in the OpenCode model registry (models.dev). |
| Gemini CLI | No change. Gemini CLI 0.68.0 still registers no Gemini 4 model. Deferred. |
| Grok Build, Kimi Code, Cursor, Pi, Hermes | No new verified model IDs. |

## Harness changes

| Harness | Before | After |
| --- | --- | --- |
| Grok CLI (`@xai-official/grok`) | 1.0.70 | 1.0.89 |
| Gemini CLI | 0.65.0 | 0.68.0 |
| Cursor CLI (sandbox layer) | 2026.10.22-27dcf5f | 2026.11.17-f532c45 |
| GitHub CLI | 2.103.3 | 2.105.0 |
| Kimi Code CLI | 2.3.3 | Unchanged; see "Deferred items" |
| Codex CLI (shared provider pack) | 0.160.0 | Unchanged; see "Deferred items" |
| Claude Agent SDK / Claude Code | 0.3.286 / 2.1.286 | Unchanged; see "Deferred items" |
| OpenCode (shared provider pack) | 1.18.34 | Unchanged; see "Deferred items" |
| Hermes | 0.19.0 | 0.19.0 (newest on PyPI) |

These pins change only the evaluation image's sandbox layer. They must stay
aligned with the fleet sandbox image definition. Native Grok uses its separate
1.0.13 prerequisite and does not use the global Grok CLI.

Fable 5.2 and GPT-6.2 do not run on Paperclip Runner in managed sandboxes
until a Paperclip release with newer provider-pack harnesses is rolled out and
a sandbox image that carries it is promoted. On Paperclip Runner, Fable 5.2
fails before launch with the named Claude Code version error, and GPT-6.2
falls back as described above. The legacy Claude CLI lane already installs a
private Claude Code at the model minimum when the sandbox can reach the npm
registry.

## Sources and verification

Research date: November 18, 2026.

- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md),
  2.1.321: "Added Claude Fable 5.2 (`claude-fable-5-2`), now the default Fable
  model". npm `latest` is 2.1.327. `@anthropic-ai/claude-agent-sdk` 0.3.N
  declares `claudeCodeVersion` 2.1.N (checked for 0.3.286, 0.3.321, and 0.3.327).
- [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview):
  Fable 5.2's API ID is `claude-fable-5-2` and its Amazon Bedrock ID is
  `global.anthropic.claude-fable-5-2`. Claude Mythos 5.2 has limited availability.
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort):
  "Claude Fable 5.2 supports all five effort levels."
- The bundled `codex-rs/models-manager/models.json` lists `gpt-6.2-sol` and
  `gpt-6.2-astra` (visibility `list`, `minimal_client_version` 0.166.0,
  efforts `low` to `ultra`, `fast` tier) from
  [rust-v0.169.1](https://github.com/openai/codex/releases/tag/rust-v0.169.1).
  [rust-v0.169.0](https://github.com/openai/codex/releases/tag/rust-v0.169.0)
  does not list them. 0.170.0 is the npm `latest`. The catalog orders
  GPT-6.2 Sol before GPT-6.2 Astra.
- [models.dev](https://models.dev/api.json) lists `openai/gpt-6.2-sol`,
  `openai/gpt-6.2-astra`, `anthropic/claude-fable-5-2`,
  `google/gemini-4-carbon`, and `google/gemini-4-hydrogen`.
- Gemini CLI 0.68.0 `packages/core/src/config/models.ts` has no Gemini 4
  entry. The 0.66.0 to 0.68.0 release notes contain fixes only for the
  `-p`, `--model`, and settings paths that Paperclip uses.
- Grok CLI 1.0.89 and Gemini CLI 0.68.0 are the npm `latest` tags.
- Cursor CLI 2026.11.17-f532c45 is the version `https://cursor.com/install`
  resolves. The archive SHA-256 was computed from the versioned Linux x64 tarball.
- [GitHub CLI 2.105.0](https://github.com/cli/cli/releases/tag/v2.105.0): the
  pinned digest matches the release `checksums.txt`.
- [Hermes on PyPI](https://pypi.org/project/hermes-agent/) remains at 0.19.0.

## Deferred items

- **Provider-pack runtimes.** Resolved on 2026-11-19 by a follow-up pull request
  that pins Codex 0.170.0 and Agent SDK 0.3.328 (Claude Code 2.1.328) and moves the
  native remote Codex window to `>=0.149.0 <0.171.0`. That pull request records
  the Claude 2.1.286 → 2.1.328 headless-default review. OpenCode 1.19.x still
  needs its own qualification.
- **Kimi Code 2.6.3.** The native Kimi profile binds 2.3.3 with a patched
  distribution closure. A new version needs its own qualification.
- **GPT-6.1 Terra** is in the Codex catalog. [#18486](https://github.com/paperclipai/paperclip/pull/18486)
  adds it; this audit does not duplicate it.
- **Claude Haiku 5.5** in the Claude Code picker is covered by
  [#16708](https://github.com/paperclipai/paperclip/pull/16708).
- **Claude Mythos 5.2** has limited availability.
- **Gemini 4** (Argon, Carbon, Hydrogen) in the Gemini CLI and Cursor catalogs:
  the CLI does not register them, and Cursor documents display names only.
- **GPT-6.2 API pricing.** The reviewed Codex rate card has no GPT-6.2 entry,
  so direct-API receipts for it stay unpriced until the card is reviewed.

## Host-environment baseline failures

Recorded once for this audit, Node 25.9.0:

- Server tests that create an AI provider fail at import with
  `AI_InvalidArgumentError: baseURL must be a non-empty string.` because the
  host sets `ANTHROPIC_BASE_URL` to an empty value. They pass with it unset.
- Under full-package parallel runs, Claude and Codex adapter tests that use SSH
  and sandbox fixtures exceed the 5-second test timeout on this host. The
  failing set differs between runs. Each file passes when run alone or with
  `--testTimeout=60000`.
