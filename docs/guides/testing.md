---
title: Testing Guide
summary: Overview of testing infrastructure, running tests, and environment-specific setup.
---

# Testing in Paperclip

Paperclip uses [Vitest](https://vitest.dev/) as its primary test runner for both server and UI packages.

## Running Tests

From the project root:

```bash
# Run all tests in the workspace
pnpm test

# Run tests for a specific package (e.g. ui)
pnpm test --filter @paperclipai/ui

# Run vitest in watch mode for a package
cd ui && npx vitest
```

## UI Testing (React 19)

The UI package is transitioning to React 19. This requires specific shims for the testing environment (JSDOM/Vitest).

### Test Setup

We use `ui/src/test-setup.ts` to provide compatibility shims:

- **React.act Shim**: Some versions of `@testing-library/react` expect `React.act` to be present. We provide a fallback if it's missing.
- **matchMedia Mock**: `window.matchMedia` is not implemented in JSDOM but is used by some UI components (e.g. from shadcn/ui).

### Configuration

The setup is integrated via `ui/vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    setupFiles: ["./src/test-setup.ts"],
    environment: "jsdom",
    // ...
  },
});
```

### Mocking Router and Providers

When testing components that depend on routing or context providers:

- **@/lib/router**: We provide a mock for `Link`, `NavLink`, `useLocation`, `useParams`, etc., in most tests.
- **QueryClient**: Components using `@tanstack/react-query` must be wrapped in a `QueryClientProvider` or have their hooks mocked.
- **CompanyContext**: Mock `useCompany` for components that need access to the current company state.

## Server Testing

Server tests use Vitest with a focus on API routes and registry logic.

### Troubleshooting Flaky Tests

If server tests fail during a full run but pass in isolation (e.g. `404` errors in `plugins-routes.test.ts`), it may be due to:

- **State Interference**: Ensure `vi.clearAllMocks()` or `vi.resetAllMocks()` is used in `beforeEach`.
- **Registry Mocking**: Some tests rely on global singleton registries. Ensure they are correctly reset or mocked per test file.

## Best Practices

1. **Unit vs. Integration**: Favor unit tests for complex logic (e.g. `JsonSchemaForm` helpers) and integration tests for component behavior.
2. **Empirical Reproduction**: Before fixing a bug, add a test case that reproduces it.
3. **Clean Up Mocks**: Always clear mocks between tests to avoid side effects.
4. **Environment Consistency**: Ensure `NODE_ENV=development` is set when installing dependencies to avoid missing `devDependencies` needed for testing.
