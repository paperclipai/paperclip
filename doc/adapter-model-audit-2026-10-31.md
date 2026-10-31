# Adapter model audit: October 31, 2026

This audit follows the [October 23, 2026 audit](adapter-model-audit-2026-10-23.md).
It is scoped to one gap: Codex accounts with ChatGPT sign-in can select GPT-6.1
Terra, and Paperclip's Codex picker did not list it.

## What users saw

An operator signed in to Codex with a ChatGPT account reports a model that
Paperclip's model dropdown does not offer. The ID the Codex CLI and ChatGPT app
show for it is `gpt-6.1-terra` (display name "GPT-6.1 Terra"). Paperclip's
Codex catalog stopped at `gpt-6.1-sol`, so the picker had no entry to show.

## Change

| Adapter | Change |
| --- | --- |
| Codex | Add `gpt-6.1-terra` to the model list, the Fast mode list, and the Ultra effort set. Record the CLI floor. Update the adapter documentation text. |
| Everything else | No change. OpenCode uses its own `openai/`-qualified catalog, and the other adapters' providers had no verified new IDs. |

Ordering follows the rule used at runtime (`#14878`/`#14918`): newest model
version first, then decreasing capability inside a version. GPT-6.1 Terra sits
directly behind GPT-6.1 Sol, which is where GPT-5.6 Terra already sits behind
GPT-5.6 Sol. The bundled Codex catalog lists it with a lower priority than
GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, and GPT-5.6 Sol, so it is not
promoted ahead of them.

Reasoning efforts and Fast mode come from the bundled metadata: the same six
levels as GPT-6.1 Sol (`low` through `ultra`) and a `priority` service tier
("Fast", 1.5x speed).

## Codex CLI floor

GPT-6.1 Terra entered the model catalogs in Codex `0.165.0` (backported in
`0.165.0-alpha.1.2`). Codex `0.164.0` and older have no bundled metadata for it,
so with ChatGPT sign-in the backend rejects every turn with "The
'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT
account." The adapter therefore records `0.165.0` in
`CODEX_LOCAL_MODEL_MINIMUM_CLI_VERSIONS`, which makes the environment Test name
the stale CLI and makes the remote runner replace the model instead of failing
mid-run.

That floor is above the current pins, and the current remote acceptance window:

- the shared provider pack and sandbox images still pin Codex `0.160.0`;
- `REMOTE_CODEX_MAXIMUM_VERSION_EXCLUSIVE` is still `0.161.0`.

So on the Paperclip Runner lane today, a `gpt-6.1-terra` selection falls back to
`gpt-5.6-terra` (newest older Terra) rather than running. On the direct
`codex_local` lane it works with whatever Codex CLI the operator has installed,
which is `0.166.0` for the reporter. Making Terra runnable on the runner lane
needs the pin and the compatibility window moved in a separate refresh with
executable digests and qualification evidence, which this audit does not claim.

## Deferred items

- **Codex pin `0.160.0` → `0.166.0`.** Needs the provider-pack pins, the Linux
  x64 executable digest, the Docker image probe, `pnpm-lock.yaml` (regenerated
  by the refresh bot), and the remote window upper bound, plus runner
  qualification. Not done here.
- **Direct-API pricing for `gpt-6.1-terra`.** `server/src/services/codex-pricing.ts`
  is a reviewed, versioned rate card; adding a model to it should come with a
  pricing-page citation and a card version bump, not an aggregator snapshot.
  models.dev lists `1 / 0.05 / 1.25 / 5` USD per million tokens (input, cached
  input, cache write, output), which is half of `gpt-6.1-sol`'s card; until a
  reviewed entry lands, API receipts for Terra stay intentionally unpriced
  rather than estimated from an out-of-band source.
- **OpenCode `openai/gpt-6.1-terra`.** models.dev lists the ID, but the pinned
  OpenCode `1.18.34` snapshot is older and no OpenCode qualification covered
  Terra. Left for the next OpenCode refresh.
- **`gpt-6-pro`.** The Codex `0.166.0` binary mentions it only inside an
  instruction string ("do not invent a separate `gpt-6-pro` model slug"); there
  is no catalog entry, so it is not selectable in Paperclip either.
- **Hidden aliases.** `gpt-daybreak-blue-latest` and `gpt-daybreak-red-latest`
  remain restricted to eligible accounts and stay out of the picker.
- **Default model.** The Paperclip default stays `gpt-5.6-sol`. Codex `0.165.0`
  also makes `gpt-6.1-sol` its own default; changing Paperclip's default would
  change saved agents and spending, so it is a separate decision.

## Sources and verification

Research date: October 31, 2026.

- [Codex CLI 0.165.0](https://github.com/openai/codex/releases/tag/rust-v0.165.0):
  "Added GPT-6.1 Terra to the model catalogs", with the
  `0.165.0-alpha.1.2` backport entry.
- [Codex CLI 0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0):
  the npm `latest` release on October 29, 2026; also adds Terra to the Vertex AI
  and Amazon Bedrock catalogs.
- The installed macOS ARM64 `0.166.0` binary's bundled model catalog lists
  `gpt-6.1-terra` with display name "GPT-6.1 Terra", the same six reasoning
  efforts as `gpt-6.1-sol`, a `priority` service tier, and a 1,050,000-token
  context window. `gpt-6.1-sol` and `gpt-6-astra` remain above it in priority.
- [models.dev](https://models.dev/api.json) lists `openai/gpt-6.1-terra`
  (released 2026-10-26) and its token prices.

Verification run on macOS ARM64, Node 22, after `pnpm install
--frozen-lockfile --ignore-scripts`:

- `vitest run src/index.test.ts src/server/codex-args.test.ts
  src/ui/build-config.test.ts` in `packages/adapters/codex-local`: 138 passed.
- `vitest run src/server/acp.test.ts src/server/acp.cli-version.test.ts
  src/server/test.remote.test.ts` in `packages/adapters/codex-local`: 62 passed.
- `vitest run src/__tests__/adapter-models.test.ts
  src/services/native-runtime/codex-model-fallback.test.ts` in `server`: 52
  passed.
- `vitest run src/lib/codex-reasoning-effort.test.ts` in `ui`: 9 passed.

Not run: the runner package, Rust crates, the full `pnpm -r typecheck` /
`pnpm test:run` / `pnpm build` set, and every browser suite. This change touches
one adapter catalog and its tests.
