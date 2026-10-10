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

## Known Limitation: Linux Baselines

Storybook visual baselines are platform-locked. The checked-in manifest records
the capture environment as `ubuntu-24.04`, and Playwright compares screenshots
with `maxDiffPixels: 0`. Pixel-exact results are only meaningful when local runs
use the same Linux/Ubuntu capture platform as the baseline.

macOS, Windows, and other non-matching local environments can produce
false-positive diffs from font rasterization and subpixel rendering differences.
Use the `Storybook Visual` GitHub Actions workflow on `ubuntu-latest` as the
source of truth for cross-platform review, or run the suite locally in a matching
Linux environment before accepting or updating baselines.

## CI and Review Artifacts

Storybook visual tests are opt-in while the suite stabilizes. Add the
`storybook-visual` label to a pull request, or run the `Storybook Visual`
workflow manually, to download the pinned baseline, build Storybook, and run the
Playwright visual suite on GitHub Actions.

The workflow uploads `tests/storybook-visual/playwright-report/` and
`tests/storybook-visual/test-results/` as a `storybook-visual-report-*` artifact
on every run. When screenshots differ, Playwright writes the actual, expected,
and diff PNGs into `test-results`, so reviewers can inspect the failure without
rerunning the suite locally.

Normal PR visual runs use repository read-only permissions and never upload or
modify baseline objects. To review intentional visual changes before updating
`baseline-manifest.json`, run the workflow manually with `update_snapshots`
enabled. That produces a `storybook-visual-baseline-review-*` artifact containing
the packed candidate snapshot archive for review. Publishing that bundle to the
baseline bucket still requires the explicit maintainer upload command below.

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
