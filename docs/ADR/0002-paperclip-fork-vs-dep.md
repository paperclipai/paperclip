# ADR 0002 — Fork Paperclip rather than use as npm dep

**Date**: 2026-04-29
**Status**: Accepted

## Context

Paperclip supports customization via adapter plugins registered in `~/.paperclip/adapter-plugins.json`. Pure-npm-dep usage is *possible* but the community pattern is to fork-and-track-upstream when:

- You're adding multiple custom adapters
- You want to inspect / patch core behavior occasionally
- You need to host multi-tenant company configs alongside the framework code
- Your company configs include filesystem paths that should be version-controlled

We hit all four. Vardaan also explicitly asked to fork.

## Decision

Fork `paperclipai/paperclip` to `Koenig-Solutions-Private-Limited/koenig-ai-org`. Keep upstream as `upstream` remote. Weekly rebase via `scripts/upstream-rebase.sh`. Customizations live in our directories (`vault/`, `companies/`, `adapters/`, `shared-skills/`, `watchdog/`, `observability/`, `infra/`, `scripts/`, `docs/`). Don't modify upstream files unless we file an upstream PR.

## Consequences

✅ Pros:
- Customizations are first-class, not workarounds in `~/.paperclip`
- Easy to inspect / debug Paperclip core when something is weird
- Multi-product company configs version-controlled together
- `pnpm install` in repo root brings up everything we need

❌ Cons:
- Weekly rebase has occasional conflicts (mostly in `adapter-plugins.json`)
- We carry the entire 36 MB Paperclip repo (acceptable)

## Conflict policy

- **Upstream changes a file we never touch**: trivial fast-forward
- **Upstream changes `adapter-plugins.json`**: keep both upstream's new entries and ours
- **Upstream changes a file we DID modify**: investigate; usually our change should move into a new directory or upstream a PR

If upstream merge conflicts become routine, escalate to "fork divergence" — at that point reconsider running upstream as a git submodule instead of rebasing.
