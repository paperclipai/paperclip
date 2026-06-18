# Changesets

Welcome! This folder contains **changeset files** — markdown documents that describe
what changed in a PR, so version bumps and changelogs are generated automatically.

## Workflow

1. When you make a change that should trigger a new release of any public package
   (e.g. `packages/skills-catalog`), run:

   ```bash
   pnpm changeset add
   ```

2. Answer the prompts about which packages changed and what kind of version bump
   (major / minor / patch). Write a short description of the change.

3. Commit the generated `.md` file alongside your code changes in the same PR.

4. During the release process (`./scripts/release.sh --with-changesets`), pending
   changesets are consumed:
   - `changeset version` bumps package versions and generates `CHANGELOG.md` entries
   - The calver release system then overwrites package.json versions with the
     single calendar version — changelog entries persist

## Scope

Changeset tracking applies to all packages listed in `scripts/release-package-manifest.json`
with `publishFromCi: true`. The CI check `scripts/check-changesets.mjs` enforces
that PRs touching these packages include a changeset.

## References

- [Changesets documentation](https://github.com/changesets/changesets)
- [Paperclip release process](../../scripts/release.sh)