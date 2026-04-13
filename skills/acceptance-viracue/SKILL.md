---
name: acceptance-viracue
description: Use when authoring Playwright acceptance specs for Viracue.ai issues. Covers anonymous and authenticated (Clerk) contexts, build manifest awareness, and spec quality requirements. Frontend QA Agent uses this skill to write the spec that the verification worker will execute against the live target before any Viracue code issue can be closed.
---

# Viracue Acceptance Specs

## When to use

Use this skill when you are the Frontend QA Agent assigned to write an acceptance spec for a Viracue issue (`deliverable_type: url` or `deliverable_type: lib_frontend`). The spec you author is the contract the engineer must satisfy — and the one the verification worker will run against the live deployment.

## Where specs live

One spec file per issue at `skills/acceptance-viracue/tests/<ISSUE_IDENTIFIER>.<type>.spec.ts`:

- `tests/DLD-2793.url.spec.ts` — a URL/routing issue
- `tests/DLD-1234.url.spec.ts` — a UI interaction issue
- `tests/DLD-5678.lib.spec.ts` — a frontend package change with no URL surface

## Non-negotiable spec quality rules

Every spec MUST satisfy all of these, or it will be rejected by `spec_quality` gate (Phase 4):

1. **At least 3 `expect()` assertions.** Superficial "happy path" specs with one assertion get rejected. The three assertions should cover: what should be true (positive), what should NOT be true (negative, e.g. redirect detection), and at least one behavioral signal (text visible, click works, no console errors).

2. **Literal reference to the deliverable target.** Your spec file must contain the URL, component name, or string identifier from the issue's `verification_target` field. Grep-based check.

3. **No trivially-satisfied assertions.** `expect(true).toBe(true)`, `expect(1).toBeGreaterThan(0)`, or assertions on values you computed yourself earlier in the spec are rejected in cross-review.

4. **Runs in `anonymous` project by default.** Set to `authenticated` only if the feature genuinely requires login. Never write a spec that passes only because the test user happens to be logged in — that's the exact failure mode of DLD-2793.

## Auth contexts

| Project | Cookie state | When to use |
|---|---|---|
| `anonymous` | clean, empty | Default. All public pages, marketing, gated-but-test-for-redirect, etc. |
| `authenticated` | seeded Clerk user storageState (Phase 4) | Only for features that genuinely require login |

## The DLD-2793 reference pattern

The tiktok demo incident spec lives at `tests/DLD-2793.url.spec.ts`. It's the canonical example of a URL spec because it catches the exact failure mode that originally broke Paperclip's QA trust:

```typescript
import { test, expect } from "@playwright/test";

test.describe("DLD-2793: TikTok approval demo flow", () => {
  test("anonymous visitor reaches demo without being redirected to sign-in", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
    });

    await page.goto("https://viracue.ai/review/tiktok-demo");

    // Positive: we land where we expected
    await expect(page).toHaveURL(/\/review\/tiktok-demo$/);
    // Negative: we did NOT get bounced to sign-in
    await expect(page).not.toHaveURL(/sign-?in/);
    // Behavioral: the page rendered its own content
    await expect(page.getByText(/tap to connect|approve|review video/i)).toBeVisible({ timeout: 5000 });
    // No runtime explosions
    expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([]);
  });
});
```

Use this as your starting template. Adapt the URL, route regex, content matcher, and failure messages to the issue you're writing for.

## Build manifest awareness

You do not handle deploy timing in your spec — the verification worker confirms the deployed SHA matches the expected commit before running you. If the SHA doesn't match after the retry window, the worker returns `unavailable` and your spec is never executed. Write the spec as if it will always run against the correct commit.

## Running locally (for debugging)

```bash
cd skills/acceptance-viracue
npm install
npx playwright install chromium  # first-time only
npx playwright test tests/DLD-2793.url.spec.ts --project=anonymous
```

Never commit `.auth/`, `test-results/`, or `playwright-report/` — these are per-run artifacts.

## When you believe the spec is wrong

You wrote the spec. The engineer implemented. The verification worker still returns `failed`. Resist the urge to loosen the spec. Three legitimate paths:

1. **The spec is correct, the code is wrong.** Comment on the issue with the trace link and push back on the engineer.
2. **The spec is incorrect in a way that reflects your misunderstanding of the requirement.** Open a NEW issue to amend the spec. Do NOT edit the spec file in the in-review context — the impl-review phase mounts specs read-only (Phase 4 enforcement).
3. **The requirement itself is wrong.** Escalate to the issue creator (usually CEO or product owner) to amend the original issue's `verification_target` and description.

Silently weakening a spec to make a PR pass is the exact failure mode this system exists to prevent.
