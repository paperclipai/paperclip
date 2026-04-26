# Test Infrastructure

## Test Categories

| Category | Runner | Location | When to run |
|----------|--------|----------|-------------|
| **Unit** | Vitest | `server/src/__tests__/`, `cli/src/__tests__/`, `ui/src/**/*.test.ts`, `packages/*/src/**/*.test.ts` | Every PR, every commit |
| **Integration** | Vitest | `server/src/__tests__/*-e2e.test.ts`, `server/src/__tests__/*-routes.test.ts` | Every PR |
| **E2E** | Playwright | `tests/e2e/` | Every PR, nightly |
| **Smoke** | Playwright | `tests/release-smoke/` | Nightly, pre-release |
| **Regression** | Vitest | Tests named `*-regression.test.ts` or tagged with `regression` | Every PR, nightly |

## Commands

```bash
# Run all unit/integration tests (watch mode)
pnpm test

# Run all tests once (CI)
pnpm test:run

# Run tests with coverage report
pnpm test:coverage

# Generate browsable HTML coverage report
pnpm test:coverage:report
# Then open: coverage/index.html

# Run only unit tests (specific projects)
pnpm test:unit

# Run E2E tests (requires build first)
pnpm build && pnpm test:e2e

# Run release smoke tests
pnpm build && pnpm test:release-smoke
```

## Coverage

Coverage is configured via `@vitest/coverage-v8` in the root `vitest.config.ts`.

**Reporters:** text, text-summary, lcov, html, json-summary

**Thresholds (enforced in CI):**
- Lines: 30%
- Functions: 25%
- Branches: 25%
- Statements: 30%

These are baseline thresholds. As coverage improves, ratchet them upward.

**Browsable report:** After running `pnpm test:coverage`, open `coverage/index.html`.

## CI Pipelines

| Workflow | Trigger | Tests run |
|----------|---------|-----------|
| `pr.yml` | Pull requests to `master` | Unit + integration (with coverage), E2E |
| `nightly.yml` | Daily at 03:00 UTC (or manual) | Full unit + coverage, E2E, smoke |
| `e2e.yml` | Manual dispatch | E2E (optional LLM assertions) |
| `release-smoke.yml` | Manual / release tags | Release smoke tests |

## Naming Conventions

When adding new tests, follow these conventions:

- **Unit tests:** `<module-name>.test.ts` — test a single module in isolation
- **Route tests:** `<resource>-routes.test.ts` — test HTTP route handlers with supertest
- **Service tests:** `<service-name>-service.test.ts` — test business logic services
- **Integration tests:** `<flow>-e2e.test.ts` — test cross-module flows (e.g. `routines-e2e.test.ts`)
- **Regression tests:** `<issue-id>-regression.test.ts` — test for specific bug fix
- **Adapter tests:** `<adapter>-adapter.test.ts`, `<adapter>-execute.test.ts`, `<adapter>-skill-*.test.ts`

## Main User Flows to Cover

These are the critical paths that must have test coverage:

1. **Heartbeat cycle:** Agent wakes → checks inbox → checks out task → does work → updates status
   - Key files: `server/src/services/heartbeat.ts`, `server/src/routes/issues-checkout-wakeup.ts`
   - Existing tests: `heartbeat-*.test.ts`, `issues-checkout-wakeup.test.ts`

2. **Task lifecycle:** Create issue → assign → checkout → in_progress → done/blocked
   - Key files: `server/src/services/issues.ts`, `server/src/routes/issues.ts`
   - Existing tests: `issues-service.test.ts`, `issues-*.test.ts`

3. **Agent checkout:** Agent checkout with conflict detection, wake-on-checkout
   - Key files: `server/src/routes/issues-checkout-wakeup.ts`
   - Existing tests: `issues-checkout-wakeup.test.ts`

4. **Adapter execution:** LLM adapter lifecycle (spawn, execute, collect output)
   - Key files: `server/src/adapters/`
   - Existing tests: `*-adapter.test.ts`, `*-execute.test.ts`
