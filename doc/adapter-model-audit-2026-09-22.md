# Adapter model audit: September 22, 2026

This audit covers model selection in the existing coding-agent adapters. Catalog
entries identify models; provider accounts and installed CLIs determine access.
No agent defaults or saved model selections are migrated.

| Adapter | Changes from the audit |
| --- | --- |
| Claude Code | Add Opus 5.5 and require CLI 2.1.280. Fable 5.1, Fable 5, Sonnet 5, and Mythos 5 were already listed. Expose the documented model-specific effort levels in creation and editing. |
| Claude on Bedrock | Add Opus 5.5, Opus 5, Sonnet 5, Opus 4.7, and Sonnet 4.6. Correct the obsolete `-v1` suffix on Opus 4.8 and Fable 5. Apply the Opus 5.5 version check to Bedrock IDs too. |
| Codex and the Codex runner catalog | Add GPT-6 Sol and Luna, including Fast mode. Astra was already listed. Expose efforts through Ultra for Astra, Sol, and GPT-5.6 Sol/Terra; cap both Luna generations at Max. |
| Grok Build | Add Grok 4.7, 4.6, and 4.5. Offer Extra High for 4.7/4.6. Save edited effort as `reasoningEffort`, which the runtime consumes. Keep `grok-build` as the sentinel that lets the CLI choose its default. |
| Gemini CLI | Add Flash 3.8, 3.7, 3.6, 3.5, Flash Lite 3.5/3.1, and 3 Flash Preview. Remove the retired Gemini 2.0 choices. Keep Auto and the existing 3.1 Pro and 2.5 choices. |
| Cursor | Add the current documented fallback IDs for Composer 2.5, Opus 5.5, Fable 5.1, Sonnet 5, GPT-5.6 Sol/Terra/Luna, Gemini 3.8 Flash, Muse Spark 1.3, and Grok 4.7/4.6/4.5. Runtime model discovery remains available. |
| OpenCode | Refresh the static fallback used by remote environments with GPT-6 and GPT-5.6 families, current Claude models, Gemini 3.8 Flash, and Grok 4.7. |
| Kimi Code | Add K3 256K. Relabel `kimi-for-coding` as K2.8 Preview, which replaced K2.7 under the same ID. Forward CLI effort for K2.8 Preview and both K3 variants. |

## Sources and verification

- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
  documents the Opus 5.5 CLI requirement and supported efforts.
  [Opus 5.5 specifications](https://platform.claude.com/docs/en/models/opus-5-5/overview)
  and [model ID conventions](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)
  supply direct and Bedrock IDs. Bedrock entries use the catalog's existing US
  inference-profile convention; regional availability remains account-dependent.
- [OpenAI's Codex model guide](https://learn.chatgpt.com/docs/models) lists GPT-6
  Sol and Luna. The installed Codex model metadata independently lists Astra,
  Sol, Luna, and all three GPT-5.6 variants with the effort sets used here.
  [GPT-6 Luna specifications](https://developers.openai.com/api/docs/models/gpt-6-luna)
  also document Fast pricing. Codex's Ultra setting is a CLI capability; it is
  not inferred from the API's effort enum.
- [Grok 4.7](https://docs.x.ai/developers/grok-4-7) and
  [Grok 4.6](https://docs.x.ai/developers/models/grok-4.6) document their IDs and
  four effort levels. The installed `grok models` command had no authenticated
  account and returned only its default sentinel. No inference was run.
- [Google's model catalog](https://ai.google.dev/gemini-api/docs/models) supplies
  the new Gemini IDs. [The retirement schedule](https://ai.google.dev/gemini-api/docs/deprecations)
  records Gemini 2.0 shutdown on June 1, 2026. Gemini 2.5 remains available to
  existing users. [Gemini CLI model selection](https://geminicli.com/docs/cli/model/)
  accepts an explicit model; login method and entitlement determine availability.
- [Cursor's catalog](https://cursor.com/docs/models-and-pricing) links each
  model's exact ID. `cursor-agent --list-models` returned no models for the local
  account, so the additions use documented IDs rather than guessed variant
  suffixes. Account-specific Fast/thinking variants remain discoverable.
- [Kimi's model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html)
  documents all four current IDs, K2.8's in-place alias upgrade, and effort
  support. Kimi effort remains limited to the existing explicit CLI engine;
  the default ACP engine's effort mapping is outside this catalog update.

## Other adapters and restricted models

OpenCode discovers local models, but remote environment routes use its static
fallback catalog. All twelve added provider-qualified IDs were also present in
the installed OpenCode registry. [OpenCode model configuration](https://opencode.ai/docs/models/)
documents its `provider/model` format and provider registry.

Pi already discovers models from its runtime or provider registry.
Hermes and OpenClaw accept provider configuration without a curated model list.
Cursor Cloud obtains its account's model list from Cursor. These paths do not
need a static entry per upstream release. Local OpenCode discovery returned
current models, including Muse Spark 1.3 and Nemotron 3.5 Lightning.

Anthropic describes Mythos 5.1 as invitation-only in the
[Fable 5.1 documentation](https://platform.claude.com/docs/en/models/fable-5-1/overview).
The public current-model catalog does not publish a selectable ID for it. Keep
account discovery and custom IDs available instead of inventing an ID. Grok
4.7 Fast is available in Grok Build and Cursor, but its exact account-specific
CLI variant ID was not exposed locally. It is not a public xAI API model.
Image, video, audio, and embedding models are outside these coding-agent pickers.

## Prior work checked

Fable 5.1 was already merged in [#12730](https://github.com/paperclipai/paperclip/pull/12730).
Astra was already merged in [#12851](https://github.com/paperclipai/paperclip/pull/12851).
The Grok 4.6/4.5 proposal [#11324](https://github.com/paperclipai/paperclip/pull/11324)
was closed and parked by its author. This update preserves the newer CLI-default
sentinel behavior from [#12062](https://github.com/paperclipai/paperclip/pull/12062).
Open model-discovery work such as [#13127](https://github.com/paperclipai/paperclip/pull/13127)
and [#13565](https://github.com/paperclipai/paperclip/pull/13565) is separate from
these catalog and effort corrections. No open PR covering the newly added IDs
was found before implementation.
