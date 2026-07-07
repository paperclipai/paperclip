# Storybook Visual Baselines

The visual suite compares built Storybook stories against PNG snapshots stored
outside git. The checked-in manifest at `baseline-manifest.json` pins the
immutable archive URL, SHA-256, byte size, snapshot count, and capture
environment.

## Commands

```sh
pnpm storybook-visual:baseline download
pnpm storybook-visual:baseline verify
pnpm test:storybook-visual
pnpm test:storybook-visual:update
```

`download` fetches the archive, verifies its SHA-256 and byte size, unpacks it to
`tests/storybook-visual/.snapshots/`, and checks the PNG count. The same snapshot
directory can be overridden with `STORYBOOK_VISUAL_SNAPSHOT_DIR`.

## Updating Baselines

1. Run `pnpm test:storybook-visual:update` after reviewing intentional visual
   diffs.
2. Run `pnpm storybook-visual:baseline pack` to create
   `tests/storybook-visual/baseline-review/snapshots.tgz`.
3. Upload the archive from a trusted maintainer environment with
   `STORYBOOK_VISUAL_S3_URI=s3://bucket/baselines/storybook-visual/<sha>/snapshots.tgz pnpm storybook-visual:baseline upload`.
4. Copy the printed `snapshotCount` and `archive` fields into
   `baseline-manifest.json`.

Generated snapshots, review bundles, Playwright reports, and downloaded caches
are ignored by git.
