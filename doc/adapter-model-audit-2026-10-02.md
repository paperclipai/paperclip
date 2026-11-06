# Adapter model and harness audit: October 2, 2026

This audit follows the [September 22, 2026 audit](adapter-model-audit-2026-09-22.md).
It covers model selection in the coding-agent adapters and the shared harness
pins in the runner, the provider pack, and the evaluation image. Catalog
entries identify models; provider accounts and installed CLIs determine access.
No agent defaults or saved model selections are migrated.

## Model changes

| Adapter | Changes from the audit |
| --- | --- |
| Codex and the Codex runner catalog | Add GPT-6.1 Sol (`gpt-6.1-sol`). Expose efforts through Ultra and Fast mode, as documented. Keep `gpt-5.6-sol` as the default. Follow-up (October 6, 2026): with ChatGPT sign-in the Codex backend accepts `gpt-6.1-sol` only from Codex CLI 0.159.0 or newer (0.156.1 and older are rejected with "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."), and `gpt-6-sol` / `gpt-6-luna` entered the bundled catalog in 0.157.0. The adapter now records these floors; the environment Test and the remote runner compare the installed `codex --version` against them, so a sandbox image baked before the pin moved reports the stale CLI instead of an account error. |
| Claude on Bedrock | Add Sonnet 5.5 (`us.anthropic.claude-sonnet-5-5`), using the catalog's existing US inference-profile convention. Sonnet 5.5 IDs (direct or Bedrock-qualified) get the documented `xhigh` and `max` efforts and require Claude Code 2.1.284 or later on the CLI lane. |
| OpenCode | Add `openai/gpt-6.1-sol` and `anthropic/claude-sonnet-5-5` to the static fallback used by remote environments. Both IDs are present in the OpenCode model registry. |
| Claude Code (direct) | No change in this audit. [#14993](https://github.com/paperclipai/paperclip/pull/14993) (merged October 5, 2026, superseding #14816) adds Sonnet 5.5 (`claude-sonnet-5-5`, Claude Code 2.1.284 or later) and refreshes the Claude runtime. |
| Grok Build, Gemini CLI, Kimi Code, Cursor | No new verified model IDs. Grok 4.7, Gemini 3.8 Flash, and Kimi K3 remain the newest documented models. |

## Harness changes

| Harness | Before | After |
| --- | --- | --- |
| Codex CLI (shared provider pack) | 0.156.0 | 0.160.0 |
| OpenCode (shared provider pack) | 1.18.32 | 1.18.34 |
| Grok CLI (`@xai-official/grok`) | 1.0.41 | 1.0.46 |
| Gemini CLI | 0.60.0 | 0.62.0 |
| Kimi Code CLI | 2.0.2 | 2.1.1 |
| Cursor CLI | 2026.09.18-9a7762b | 2026.10.01-e373342 |
| GitHub CLI | 2.101.0 | 2.102.0 |
| Claude Agent SDK / Claude Code | 0.3.280 / 2.1.280 | 0.3.286 / 2.1.286 via #14993 (merged); this branch keeps that pin |
| Hermes | 0.19.0 | 0.19.0 (current) |
| ACPX, `claude-agent-acp`, `codex-acp` bridges | 0.13.1 / 0.73.0 / 1.6.2 | Unchanged; separately qualified |
| Pi (`@earendil-works/pi-coding-agent`) | 0.87.1 (fleet image) | Unchanged; Pi 1.0 is qualified upstream in the Pi runner stack |

The remote Codex compatibility window moves to `>=0.149.0 <0.161.0`. The
minimum stays fixed. See
[paperclip-runner-compatibility.md](architecture/paperclip-runner-compatibility.md).

## Sources and verification

- [OpenAI's Codex model guide](https://learn.chatgpt.com/docs/models) lists
  GPT-6.1 Sol (`gpt-6.1-sol`) with reasoning efforts from Light to Ultra and
  Standard and Fast modes at launch. The bundled Codex 0.160.0 model metadata
  also contains `gpt-6.1-sol`. The same page records that `gpt-5.4` and
  `gpt-5.4-mini` retired from Codex with ChatGPT sign-in on August 31, 2026,
  and that `gpt-5.5` retires from Codex with ChatGPT sign-in on October 14,
  2026. Neither retirement applies to the OpenAI API, so the picker keeps
  those IDs for API-key users; see "Deferred items".
- [Codex CLI releases](https://github.com/openai/codex/releases) 0.157.0
  through 0.160.0 add GPT-6 Sol and Luna metadata, app-server pagination, and
  authoritative provider catalogs. The Linux x64 executable digest comes from
  the integrity-verified `@openai/codex@0.160.0-linux-x64` archive.
- [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
  documents the Bedrock ID `anthropic.claude-sonnet-5-5` and the September 28,
  2026 release. The [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
  entry for 2.1.284 adds `claude-sonnet-5-5`, so that version is the CLI minimum. [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
  lists `xhigh` and `max` effort support for the 5.5 generation.
- [OpenCode releases](https://github.com/anomalyco/opencode/releases)
  1.18.33 and 1.18.34 contain fixes only. The OpenCode model registry at
  models.dev lists both added provider-qualified IDs.
- Grok CLI 1.0.46 is the `latest` tag on npm. [xAI's model list](https://docs.x.ai/docs/models)
  still ends at Grok 4.7. Gemini CLI 0.62.0 and Kimi Code 2.1.1 are the
  `latest` tags on npm; [Google's model catalog](https://ai.google.dev/gemini-api/docs/models)
  and [Kimi's model page](https://www.kimi.com/code/docs/en/kimi-code/models.html)
  list no newer coding models.
- Cursor CLI 2026.10.01-e373342 is the version the official installer
  resolves; the pinned archive digest comes from the versioned tarball, and
  the extracted binary reports that version. [Cursor's catalog](https://cursor.com/docs/models-and-pricing)
  shows new Grok 4.7 500k and Kimi K3 rows without exact CLI IDs, so no
  fallback IDs were added.
- [GitHub CLI 2.102.0](https://github.com/cli/cli/releases/tag/v2.102.0)
  contains security fixes for download commands. The pinned digest matches the
  release `checksums.txt`.
- [Hermes on PyPI](https://pypi.org/project/hermes-agent/) remains at 0.19.0.

## Deferred items

- `gpt-5.4` and `gpt-5.4-mini` stay in the Codex picker because the OpenAI API
  still serves them. A later audit can remove them once API retirement is
  published or operators confirm no API-key agents depend on them. `gpt-5.5`
  needs the same review after October 14, 2026.
- The ACP bridges (ACPX 0.19.4, `claude-agent-acp` 0.85.1, `codex-acp` 2.1.1)
  are newer upstream. They carry reviewed patches and qualified executable
  digests, so they need a separate qualification campaign rather than a pin
  bump. ACPX 0.15.1 and 0.17.0 also change message limits and session
  journal records.
- Pi 1.0.0 is published, but the runner's Pi profile and the fleet image stay
  on the qualified 0.84.2 / 0.87.1 pins until the Pi 1.0 runner stack lands.
- The native Grok runtime (`native:grok` 1.0.13) is bound by a qualified
  profile digest and is not refreshed by this audit.
- Claude Mythos 5.1 remains invitation-only with no public selectable ID.
- Cursor's exact IDs for Grok 4.7 500k, Kimi K3, and GLM 5.3 are not shown
  in the documentation and the unauthenticated CLI returns no list.
