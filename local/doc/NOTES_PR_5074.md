# PR #5074 — Honor custom labels from external adapter modules

**Status as of 2026-05-04:** open, awaiting review at https://github.com/paperclipai/paperclip/pull/5074

Branch: `feat/external-adapter-custom-labels` (commit `1b04bc60`, on fork remote `marcpbailey/paperclip`).
Local mod sitting on `master`: `ui/src/adapters/use-adapter-capabilities.ts` (1 line — `openai` entry in `KNOWN_DEFAULTS`).

## Why this exists

Threads an optional `label` field through the adapter stack so external adapters (e.g. our OpenRouter-flavored `@marcpbailey/paperclip-adapter-openai`) can present a custom display name. Also fixes the instruction-bundle UI not rendering for `openai`-typed external adapters.

The PR is **generic** (no OpenRouter-specific code) but **required** by our OpenRouter adapter.

## When the PR is accepted

```bash
git checkout master
git pull origin master                       # fast-forwards (or merges) the PR
git status                                   # use-adapter-capabilities.ts should now show clean
git branch -D feat/external-adapter-custom-labels       # use -D, not -d (squash merge rewrites SHAs)
git push fork --delete feat/external-adapter-custom-labels   # tidy the fork
rm NOTES_PR_5074.md                          # this file
```

Subtleties:

- If `git status` still shows `ui/src/adapters/use-adapter-capabilities.ts` as modified after pulling, the maintainer tweaked the line during merge. Run `git checkout -- ui/src/adapters/use-adapter-capabilities.ts` to reset to upstream.
- No bridge / compat shim to remove — OpenRouter adapter keeps working with no further glue on our side.

## If the PR is rejected

- `git checkout master && git push fork --delete feat/external-adapter-custom-labels` to drop the fork branch
- `git branch -D feat/external-adapter-custom-labels` to drop the local branch
- Decide whether to keep the `use-adapter-capabilities.ts` local mod (functional) or revert it (`git checkout -- ui/src/adapters/use-adapter-capabilities.ts`)

## Reviewer asks (already addressed in `1b04bc60`)

- Greptile P2 stale-memo in `AgentConfigForm.tsx` adapter list (memo deps didn't include the mutable adapter registry) — fixed by dropping the `labelFor` callback and relying on `listAdapterOptions`'s built-in `adapter.label ?? getAdapterLabel` resolution
- All required PR template sections (Thinking Path, What Changed, Verification, Risks, Model Used, Checklist) present
- Before/after screenshots attached
