# Agent personas

Agents have a persisted visual identity independent of prompts and runtime
configuration: `{ schemaVersion: 1, characterVersion: "cap-v1", paletteId }`.
The cap-v1 library contains 17 permanent palettes and a presentation-only gray
Muted dream palette. New agents get one random assignment; existing rows are
backfilled with the same ID-based mapping used by legacy clients. Duplicating
an agent generates another assignment. Export/import preserves it.

## Rendering and URLs

`GET /api/agent-avatars/cap-v1/bubblegum-sky/rest.png?size=24&scale=2`

The endpoint is public preset artwork, contains no agent/company identifiers,
and works without the UI. `Agent.avatarUrl` is the 512px resting portrait URL.
Resolve relative URLs against the instance base URL for integrations.

Supported logical sizes: 16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512.
Density is 1 or 2. Poses: rest, idle, listening, thinking, working, success,
confused, sleepy, loading. Other inputs receive 400. Display size controls
face detail separately from raster dimensions: 24px at 2× remains eyes-only.

A cold request samples ClipLab's deterministic scene, exports SVG using the
same geometry and face code as the live renderer, and rasterizes it with sharp
in a worker thread. No Chromium, GPU, pre-rendering command, or per-agent asset
row is required. Two workers serve a bounded queue, coalesce identical requests
within the process, time out failed rendering, and stop after an idle interval.

The configured local-disk/S3 provider stores results in
`generated-agent-avatars/<version>/<palette>/<pose>-<size>-<scale>.png`.
This preset-only cache intentionally uses the storage provider directly;
company asset APIs retain their existing authorization boundary. Cache data
can be removed and regenerates on demand. Independent replicas can render the
same key safely; successful writes are complete objects. ETags hash PNG bytes.
A small `.png.json` sidecar stores the content digest and length; it is published
after the complete PNG. Warm requests stream stored PNG bytes without re-rendering
or buffering the image in the API process. Responses are immutable for one year.
Cold renders are limited per client IP (32 outstanding keys and 256 new keys
per minute per process); excess misses return 429 with Retry-After and no-store.
Warm cache hits and requests joining the same in-flight key bypass admission.
The route uses Express trust-proxy configuration, never an untrusted forwarded header. Render/storage failures return 503 with
Retry-After and no-store rather than caching a broken image.

cap-v1 is frozen: change the version when changing palette values, poses,
rendering, or dependencies in a way that changes pixels. Keep old versions
available. The SVG exporter approximates 3D gradients with a planar gradient;
front-facing identity portraits minimize the difference from WebGL.

## Components

- `AgentAvatar`: image only; pass the agent record or appearance and a semantic
  size. No per-agent queries, live-renderer imports, or circle cropping.
- `AgentIdentity`: agent avatar and name. Human identities keep `Identity`.
- `AgentCharacter`: lazy live hero with state and optional tracking-region
  props, plus an explicit `trackingScope="page"` for onboarding and agent headers. One live renderer per view; other instances keep their still image.
  Reduced motion, offscreen content, renderer failure, and static states do
  not run the animation loop. Pointer tracking defaults to its region and is off for touch.

Onboarding stores the eventual palette in its existing draft and presents gray
until verified connection/hiring succeeds. Reconnect never randomizes identity.
Names, explicit status badges, and status text remain authoritative.

## Development and verification

ClipLab provenance/licenses are under `packages/shared/src/cliplab/`.
Palette tokens originate in `ui/src/index.css`. After deliberately introducing
new versioned artwork, `node scripts/sync-agent-palette-tokens.mjs` synchronizes
the TS palette data; `--check` detects drift. This does not generate images.

Storybook: **Agents / Personas**. Run with
`PAPERCLIP_STORYBOOK_API_URL=http://localhost:<isolated-port> pnpm storybook`.
Static Storybook hosting must proxy `/api/agent-avatars` to an instance.

Focused checks:

```sh
pnpm exec vitest run packages/shared/src/agent-appearance.test.ts server/src/__tests__/agent-avatars.test.ts
node scripts/sync-agent-palette-tokens.mjs --check
pnpm check:token-gates
pnpm build-storybook
```

The 500-avatar story must create zero WebGL contexts and load no live runtime.
Use fixed poses/times for screenshots and Linux for authoritative visual
baselines. Verify cold and warm URLs, reduced motion, reconnect, and saved
appearance after refresh alongside normal typecheck/test/build checks.

Linux visual/performance checks (against the built Storybook with the API proxy):

```sh
pnpm exec playwright test --config tests/storybook-visual/agent-personas.config.ts
```

Use the Playwright 1.62.1 Noble image for authoritative Linux baselines. The suite
covers both themes, palette and size grids, every expression, fixed-pose SVG/WebGL
pixel comparisons, repeated mounts, context loss, delayed/failed images, and the
500-avatar no-WebGL/no-live-download/no-frame-loop contract. Baselines follow the
existing Storybook visual artifact workflow; they are not application assets.

## Acceptance record — 2026-09-10

Implemented in `codex/agent-personas`, based on `5cb4f061d`, with the original
checkout left unchanged. Verification used disposable embedded-Postgres data,
a local MinIO container, and Playwright's Linux Noble image.

| Check | Result |
| --- | --- |
| Repository typecheck and build | Passed |
| Token gates and palette-token synchronization | Passed |
| Storybook production build | Passed |
| Linux visual/performance suite | 30 passed; exact snapshot comparison passed |
| Static/live agreement | Rest at 16/24/48/256 logical pixels, both densities; all eight animated expression snapshots at 128px/2× |
| Avatar endpoint | Cold/warm requests, concurrency, deletion, retry, ETags and invalid parameters passed |
| Real local-disk and S3-compatible storage | Passed; persisted warm cache reused by a fresh service instance |
| Compiled API-only smoke | Passed with TypeScript stripping disabled, no UI and a native worker |
| Persistence and contracts | Creation, saved draft, SQL backfill, approvals, duplication, portability and revision restoration passed |
| UI/runtime lifecycle | Reduced motion, one live owner, scoped pointers, hidden/offscreen suspension, failures and disposal passed |
| Hands-on app | Stable rename/reload, fresh duplicate assignment, paused static portrait, matching task/list/configuration identities passed |

The broad `pnpm test:run` verification was completed in its groups/shards after
resource-contention retries. General server (8,347 tests), UI (5,619), CLI (484),
DB (133), and adapter/plugin source suites (2,235) passed. Remaining route suites
and the added persona/contract tests passed after the OpenAPI coverage update.
The queued-comment suite exposed a pre-existing fixture-cleanup failure: run
claims created dependent runtime rows, so swallowed foreign-key errors left the
`QUE` company behind. Its isolated-database cleanup now truncates the company
fixture graph with cascade; all 17 tests pass together. No production queued-comment
behavior changed. Verification completed across the repository runner's groups
and shards, with targeted reruns after fixes, rather than another monolithic run.

Actual provider sign-in was not completed: the disposable instance had no managed
sandbox available for sign-in. Onboarding gray/loading/success transitions were
covered in Storybook and the onboarding tests. The app is usable in local-trusted
mode; this standalone worktree has no managed issue identity or login handoff.

The reviewed Linux candidate archive is generated at
`tests/storybook-visual/baseline-review/snapshots.tgz`. It remains a local review
artifact; the existing baseline manifest was not repointed to an unpublished URL.

## Placement and sharpness refinement — 2026-09-10

The overview/configuration header owns the live character beside the agent name
and follows the pointer across the whole page; there is no second hero in the
overview body. The new-agent dialog and setup page
use a larger, padded character frame with page-wide mouse tracking. Other
placements retain region-scoped tracking. Touch, reduced motion, hidden views,
and unmount cleanup still disable tracking and frame scheduling.

Live canvases render at twice the display density (capped at 4×), with a 1024px
face texture and padded framing for rotations and expression props. This affects
only the live renderer: existing versioned PNG URLs retain their original pixels.
The Snapshot Agreement story provides explicit 1×/2× controls and labels the
actual PNG and WebGL pixel dimensions for a fair comparison.

`Agents / Personas / Full pages` includes the actual application shell and route
components for all agents, agent overview, task detail, dashboard, the new-agent
dialog, and the connection page. Fixtures stay in Storybook; these examples do
not read or mutate the running company's data. Dashboard activity rows now use
the same agent avatars as its active-agent and task placements.

Refinement verification: 38 Linux Playwright checks passed, including exact
comparison with the reviewed snapshots for all six full-page stories and
corner-pointer clipping checks at 1×/2× display density. The 500-avatar view
still loads no live renderer or WebGL contexts. All 18 targeted appearance,
component/runtime, and avatar endpoint tests passed, as did shared/UI typechecks,
token gates, UI build, and Storybook build. Hands-on inspection confirmed the
single animated header at `/PER/agents/persona-tester-renamed/overview` and the
larger onboarding character in the real route components. The repository-wide
checks above were not repeated for this UI refinement.
