# Onboarding route duplicate-test audit — 2026-10-13

## Scope and keeper map

This change removes two duplicate tests from `ui/src/lib/onboarding-route.test.ts`. The production owner is `ui/src/lib/onboarding-route.ts`. No production code changes.

| Removed test | Retained keeper and preserved proof |
| --- | --- |
| `takes no mission input, so no goal state can route around the agent step` | `resolveRouteOnboardingOptions — the agent step > opens an existing company on the agent step` uses the same path, prefix, and company array. Its exact result includes `ONBOARDING_AGENT_STEP`; the removed negative mission-step assertion follows from this full equality. |
| `never opens on the mission step, whatever the company's goals say` | `onboardingStepForCompany > opens an existing company on the agent step` calls the same zero-argument function and asserts the exact returned step. The removed negative assertion was weaker. |

Neither removed test accepts a distinct input or protects an additional route branch. CompanyContext provider and resolver tests remain unchanged because they exercise a separate integration boundary.

## Savings

- Onboarding route declarations: **32 → 30**.
- Onboarding route file: **364 → 331 lines**, a net reduction of **33 test lines**, including the unused mission-step import and blank separators.
- The two focused files execute **52 → 50 cases**. No CI timing reduction is claimed.

## Validation

Baseline command, run from `ui/`:

```sh
pnpm exec vitest run src/lib/onboarding-route.test.ts src/context/CompanyContext.test.tsx
```

Baseline result: **2 files, 52 tests passed**, in 4.48 seconds.

Candidate command, run from `ui/`:

```sh
node_modules/.bin/vitest run src/lib/onboarding-route.test.ts src/context/CompanyContext.test.tsx
```

Candidate result: **2 files, 50 tests passed**, in 4.15 seconds. The modified onboarding route suite alone also passed **30/30**. `git diff --check` passed. No runtime savings are claimed.
