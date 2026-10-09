# Developer previews and diagnostic labs

Contributors can inspect design examples, interaction labs, and performance fixtures. These are development surfaces and do not count as production feature verification.

Implementation: [route registration](../ui/src/App.tsx), [design guide](../ui/src/pages/DesignGuide.tsx), [long-thread fixture](../ui/src/pages/IssueChatLongThreadPerf.tsx).

## Sub-features

- `design`: inspect shared components and layout examples in the design guide or Storybook.
- `interaction-labs`: exercise synthetic bootstrap, task-chat, denial, and collaboration states.
- `performance`: measure the provided long-thread fixture with known data and environment.
- `route-gates`: distinguish dev-only, experimental, historical, and fallback surfaces.

## How to get to it (user POV)

### `preview-lab`

Use `/design-guide`, registered `/ux-lab/...` routes, or Storybook; consult `ui/src/App.tsx` for the current gated set.

### `performance-fixture`

Open `/tests/perf/long-thread` only in an appropriate development environment.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a development/test environment. Confirm the route is registered for the current build before claiming the page is available.

### `preview-lab`

Automated: [onboarding variant](../ui/src/components/OnboardingWizardVariant.test.tsx) is an example component contract. There is no claim of full automated acceptance coverage for every lab page.

Manual: Open the specific fixture state, inspect controls and layout, then repeat the affected interaction in the actual product host. Report fixture results separately from persisted task/company results.

### `performance-fixture`

Automated: [task thread component](../ui/src/components/IssueChatThread.test.tsx) does not establish a performance budget. Timing/scroll measurements need a dedicated browser run.

Manual: Record browser/build/data size, exercise scrolling and composing in the fixture, and retain timing or trace evidence. Confirm a representative real task does not regress before extrapolating fixture measurements.

## Gotchas

- An unmounted or obsolete lab file remains in the conservative page inventory but is not a shipped entry point.
- Screenshots of a lab do not prove live provider behavior, persistence, or authorization.
