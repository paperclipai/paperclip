# Testing

Guide to running and writing tests for AgentVault.

## Test Framework

AgentVault uses [Vitest](https://vitest.dev/) for testing.

## Running Tests

### All Tests

```bash
npm run test
```

### Watch Mode

```bash
npm run test:watch
```

### Specific Test File

```bash
npm run test tests/unit/format.test.ts
```

### Filter Tests

```bash
# Run tests matching pattern
npm run test -- --grep "wallet"
```

### Coverage

```bash
npm run test -- --coverage
```

## Test Structure

```
tests/
├── unit/                    # Unit tests
│   ├── format.test.ts
│   └── validation.test.ts
├── cli/                     # CLI command tests
│   ├── init.test.ts
│   ├── deploy.test.ts
│   └── wallet.test.ts
├── deployment/              # Deployment tests
│   └── icpClient.test.ts
├── icp/                     # ICP integration tests
│   └── actor.test.ts
└── integration/             # Full integration tests
    └── workflow.test.ts
```

## Test Statistics

AgentVault v1.0 includes **508 tests** across **31 test files**.

| Category | Tests | Files |
|----------|-------|-------|
| Unit | ~150 | ~10 |
| CLI | ~200 | ~15 |
| Deployment | ~80 | ~3 |
| ICP | ~50 | ~2 |
| Integration | ~28 | ~1 |

## Writing Tests

### Basic Test

```typescript
import { describe, it, expect } from 'vitest';

describe('MyModule', () => {
  it('should do something', () => {
    expect(myFunction()).toBe('expected');
  });
});
```

### Async Test

```typescript
import { describe, it, expect } from 'vitest';

describe('AsyncModule', () => {
  it('should handle async operations', async () => {
    const result = await asyncFunction();
    expect(result).toBeDefined();
  });
});
```

### Mocking

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('MockedModule', () => {
  it('should use mocked function', () => {
    const mock = vi.fn().mockReturnValue('mocked');
    expect(mock()).toBe('mocked');
    expect(mock).toHaveBeenCalled();
  });
});
```

### Setup and Teardown

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('SetupModule', () => {
  let resource: Resource;

  beforeEach(() => {
    resource = createResource();
  });

  afterEach(() => {
    resource.cleanup();
  });

  it('should use resource', () => {
    expect(resource.isReady()).toBe(true);
  });
});
```

## CLI Command Tests

### Testing Commands

```typescript
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { initCommand } from '../../cli/commands/init';

describe('init command', () => {
  it('should have correct name', () => {
    expect(initCommand.name()).toBe('init');
  });

  it('should have required options', () => {
    const options = initCommand.options;
    expect(options.some(o => o.long === '--force')).toBe(true);
  });
});
```

## Integration Tests

### ICP Client Tests

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { ICPClient } from '../../src/deployment/icpClient';

describe('ICPClient', () => {
  let client: ICPClient;

  beforeAll(async () => {
    client = new ICPClient({ network: 'local' });
  });

  it('should connect to local network', async () => {
    const status = await client.getStatus();
    expect(status).toBeDefined();
  });
});
```

## Test Configuration

### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
```

## Best Practices

### Test Naming

```typescript
// Good: Descriptive names
it('should throw error for invalid canister ID format', () => {
  expect(() => validateCanisterId('invalid')).toThrow();
});

// Bad: Vague names
it('works', () => {
  expect(fn()).toBe(true);
});
```

### Arrange-Act-Assert

```typescript
it('should calculate correct balance', () => {
  // Arrange
  const amount = 1000000000n;
  const decimals = 9;

  // Act
  const result = formatBalance(amount, decimals);

  // Assert
  expect(result).toBe('1');
});
```

### One Assertion Per Test (Generally)

```typescript
// Good: Focused test
it('should return correct status', () => {
  const agent = createAgent();
  expect(agent.getStatus()).toBe('idle');
});

// Also acceptable: Related assertions
it('should initialize with default values', () => {
  const agent = createAgent();
  expect(agent.getStatus()).toBe('idle');
  expect(agent.getTasks()).toEqual([]);
});
```

### Avoid Magic Values

```typescript
// Good: Named constants
const CANISTER_ID = 'abcde-aaaab';
const EXPECTED_BALANCE = '1.0';

it('should query balance', async () => {
  const balance = await getBalance(CANISTER_ID);
  expect(balance).toBe(EXPECTED_BALANCE);
});
```

## Debugging Tests

### Debug Single Test

```bash
# Run with Node debugger
node --inspect-brk node_modules/.bin/vitest run --no-threads
```

### Console Output

```typescript
it('should debug', () => {
  console.log('Debug output:', result);
  expect(result).toBeDefined();
});
```

## Continuous Integration

Tests run automatically on:

- Pull requests
- Pushes to main branch

CI configuration:

```yaml
# .github/workflows/test.yml
- name: Run tests
  run: npm run test
```

## Adding New Tests

1. Create test file in appropriate `tests/` subdirectory
2. Follow naming convention: `*.test.ts`
3. Import from `vitest`
4. Run tests to verify

```bash
# Create new test file
touch tests/unit/newFeature.test.ts

# Run new test
npm run test tests/unit/newFeature.test.ts
```
