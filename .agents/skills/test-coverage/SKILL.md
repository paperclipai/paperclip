---
name: test-coverage
description: >
  Ensure new or changed functionality has matching test coverage. Analyzes
  code changes, identifies untested paths, writes tests following project
  conventions, and validates they pass. Use when adding features, fixing bugs,
  responding to "missing tests" review comments, or auditing test coverage.
  Trigger phrases: "write tests", "add test coverage", "missing tests",
  "ensure tests match functionality", "test this change".
---

# Test Coverage Skill

Write and validate tests for new or changed code, following project conventions.

## When to Use

- After implementing a new feature or bug fix
- When a PR reviewer flags missing test coverage
- When asked to "write tests for this" or "ensure test coverage"
- Before submitting a PR (pre-flight coverage check)

## Principles

1. **Test behavior, not implementation** — tests verify what the code does,
   not how it does it
2. **Follow existing patterns** — match the test style already in the codebase
3. **Cover the contract** — test public API, edge cases, and error paths
4. **Keep tests fast** — mock external dependencies, avoid real I/O
5. **Name tests descriptively** — test name should read as a specification

## Workflow

### Step 1 — Identify What Needs Tests

1. Determine which files were changed or added
2. For each changed file, identify:
   - New exported functions or methods
   - Changed behavior in existing functions
   - New error handling paths
   - New configuration options or parameters

```bash
# Find changed files relative to base branch
git diff --name-only origin/main...HEAD -- '*.ts' '*.tsx'
```

### Step 2 — Find Existing Test Patterns

1. Locate existing test files for the same module or nearby modules
2. Study the patterns used:
   - Test framework (vitest for this project)
   - Mocking approach (vi.mock, vi.fn, vi.spyOn)
   - File naming convention (`__tests__/*.test.ts` or `*.test.ts`)
   - Describe/it nesting structure
   - Setup/teardown patterns (beforeEach, afterEach, afterAll)

```bash
# Find related test files
find . -name "*.test.ts" -path "*/<module-area>/*"
```

### Step 3 — Design Test Cases

For each function or behavior, create test cases covering:

| Category | What to Test | Example |
|----------|-------------|---------|
| **Happy path** | Normal inputs produce expected output | `fetchModels("http://...") → model list` |
| **Edge cases** | Boundary values, empty inputs, single items | `fetchModels with empty response → []` |
| **Error paths** | Invalid inputs, network failures, missing config | `fetchModels with unreachable server → null` |
| **Caching** | If caching exists, test fresh/stale/reset | `listModels returns cached within TTL` |
| **Deduplication** | If dedup exists, test unique/duplicate/mixed | `dedupeModels removes duplicate IDs` |

### Step 4 — Write Tests

Follow these conventions for this project:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ESM mocking pattern — vi.mock() at top level with factory
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';

describe('moduleName', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    // Clean up any module-level state (caches, timers)
  });

  describe('functionName', () => {
    it('should do X when given Y', async () => {
      // Arrange
      vi.mocked(readFile).mockResolvedValue('...');

      // Act
      const result = await functionName();

      // Assert
      expect(result).toEqual(expected);
    });
  });
});
```

**ESM Mocking Rules** (critical for this project):

- Use `vi.mock('module', () => ({ ... }))` factory pattern at the top level
- Import the mocked module AFTER the `vi.mock()` call
- Use `vi.mocked(fn)` to access mock methods on imported functions
- For time-dependent tests, use `vi.useFakeTimers()` and `vi.useRealTimers()`
- Always call `vi.resetAllMocks()` in `beforeEach`
- Export cache reset functions from modules for test cleanup

### Step 5 — Run and Validate

```bash
# Run specific test file
pnpm vitest run <path/to/test.test.ts>

# Run all tests
pnpm test:run

# Run with coverage
pnpm vitest run --coverage <path/to/test.test.ts>

# Typecheck
pnpm -r typecheck
```

All tests must:
- Pass on first run (no flaky tests)
- Pass in isolation (no dependency on test order)
- Complete in under 5 seconds per test file

### Step 6 — Commit

Commit test files with message format:
```
test: add tests for <module/feature>

Covers: <brief list of what's tested>
```

## Test Quality Checklist

- [ ] Every new exported function has at least one test
- [ ] Error/failure paths are tested (not just happy path)
- [ ] Mocks are properly reset between tests
- [ ] No hardcoded ports, paths, or URLs that could cause CI failures
- [ ] Test names describe behavior, not implementation
- [ ] No `console.log` left in test files
- [ ] Tests pass in CI environment (no local-only dependencies)

## Common Patterns in This Codebase

### Mocking fetch (global)
```typescript
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
// In afterAll: vi.unstubAllGlobals();
```

### Mocking file system
```typescript
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  access: vi.fn(),
}));
```

### Testing cache behavior
```typescript
// Use fake timers to control cache TTL
vi.useFakeTimers();
// ... first call populates cache ...
vi.advanceTimersByTime(CACHE_TTL_MS + 1);
// ... next call should refetch ...
vi.useRealTimers();
```

### Testing with module-level state
```typescript
// Module should export a reset function:
// export function resetCacheForTests() { cache = null; }
afterEach(() => {
  resetCacheForTests();
});
```
