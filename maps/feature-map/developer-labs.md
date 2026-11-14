---
navigation: {"section":"Contributor surfaces","sectionOrder":80,"order":10}
---

# Developer previews and diagnostic labs

Contributors can inspect design examples, interaction labs, and performance fixtures. These are development surfaces and do not count as production feature verification.

Feature ID: `developer-labs`.

Implementation: [route registration](../../ui/src/App.tsx), [design guide](../../ui/src/pages/DesignGuide.tsx), [long-thread fixture](../../ui/src/pages/IssueChatLongThreadPerf.tsx).

Agent access: [companion](../agent-access-map/developer-labs.md).

## Sub-features

- `design`: `developer-labs/design` — inspect shared components and layout examples in the design guide or Storybook.
- `interaction-labs`: `developer-labs/interaction-labs` — exercise synthetic bootstrap, task-chat, denial, and collaboration states.
- `performance`: `developer-labs/performance` — measure the provided long-thread fixture with known data and environment.
- `route-gates`: `developer-labs/route-gates` — distinguish dev-only, experimental, historical, and fallback surfaces.

## How to get to it (user POV)

### `preview-lab`

Use `/design-guide`, registered `/ux-lab/...` routes, or Storybook; consult `ui/src/App.tsx` for the current gated set.

### `performance-fixture`

Open `/tests/perf/long-thread` only in an appropriate development environment.

## Driving it with Playwright

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a development/test environment. Confirm the route is registered for the current build before claiming the page is available.

### `preview-lab`

Automated: [onboarding variant](../../ui/src/components/OnboardingWizardVariant.test.tsx) is an example component contract. There is no claim of full automated acceptance coverage for every lab page.

Manual: Open the specific fixture state, inspect controls and layout, then repeat the affected interaction in the actual product host. Report fixture results separately from persisted task/company results.

### `performance-fixture`

Automated: [task thread component](../../ui/src/components/IssueChatThread.test.tsx) does not establish a performance budget. Timing/scroll measurements need a dedicated browser run.

Manual: Record browser/build/data size, exercise scrolling and rendering in the
long-thread fixture, and retain timing or trace evidence. Its composer is
disabled; test composing separately in a real task. Confirm representative
real-task behavior before extrapolating fixture measurements.

## Gotchas

- An unmounted or obsolete lab file remains in the conservative page inventory but is not a shipped entry point.
- Intended developer use is not a universal runtime gate: Design Guide and
  global lab/performance routes are also registered in production builds.
- Screenshots of a lab do not prove live provider behavior, persistence, or authorization.

### Storybook verification

#### `performance`

Capability ID: `developer-labs/performance`.

Scope: browser
Storybook: A screenshot/story is optional context, not the required performance evidence.
Production: Use existing browser performance harnesses. Record build/browser/data size, timing/trace and scrolling. Long-thread fixture has a disabled composer; task-chat HTML harness uses a plain textarea and simulated updates.
Sources: Source: [IssueChatLongThreadPerf.tsx](../../ui/src/pages/IssueChatLongThreadPerf.tsx), [README.md](../../tests/perf/task-chat/README.md), [README.md](../../tests/perf/issue-detail/README.md). Tests: [scrollback.spec.ts](../../tests/perf/task-chat/scrollback.spec.ts), [issue-detail.perf.spec.ts](../../tests/perf/issue-detail/issue-detail.perf.spec.ts)

#### `route-gates`

Capability ID: `developer-labs/route-gates`.

Scope: browser
Storybook: No isolated story required to prove actual route registration, redirects or gates; isolated gated-control examples remain useful.
Production: Drive real routes under their actual development, experimental, production and fallback settings. Do not assume every lab is dev-only: global long-thread/lab/design routes also exist in production registration.
Sources: Source: [App.tsx](../../ui/src/App.tsx). Tests: No dedicated test asserted; use the feature recipe.

### Documentation scope: Developer labs and fallback pages

Developer and fallback surfaces are identified. Each synthetic fixture and performance budget is not a production journey and needs its own measurement.
