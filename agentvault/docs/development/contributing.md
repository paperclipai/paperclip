# Contributing

How to contribute to AgentVault.

## Getting Started

### 1. Fork and Clone

```bash
# Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/agentvault.git
cd agentvault

# Add upstream remote
git remote add upstream https://github.com/johnnyclem/agentvault.git
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Build

```bash
npm run build
```

### 4. Run Tests

```bash
npm run test
```

## Development Workflow

### Create a Branch

```bash
# Update main
git checkout main
git pull upstream main

# Create feature branch
git checkout -b feature/my-feature
```

### Make Changes

Follow coding conventions:
- TypeScript with ES2022 target
- ESM modules
- 2-space indentation
- camelCase for variables/functions
- PascalCase for types/classes
- Prefix unused parameters with `_`

### Run Checks

```bash
# Type check
npm run typecheck

# Lint
npm run lint

# Fix lint issues
npm run lint:fix

# Run tests
npm run test

# Run tests in watch mode
npm run test:watch
```

### Commit Changes

Commit messages should be clear and descriptive:

```
Add support for new wallet chain

- Implement Polkadot wallet provider
- Add transaction signing
- Include unit tests
```

### Push and Create PR

```bash
# Push to fork
git push origin feature/my-feature

# Create PR via GitHub UI or CLI
gh pr create --title "Add support for new wallet chain" --body "..."
```

## Code Style

### TypeScript

```typescript
// Good: Explicit types
export function formatBalance(amount: bigint, decimals: number): string {
  return (amount / BigInt(10 ** decimals)).toString();
}

// Good: Unused parameter prefix
function handleEvent(_event: Event, data: unknown): void {
  console.log(data);
}

// Good: as const for literals
const CHAIN_TYPES = ['icp', 'ethereum', 'solana', 'polkadot'] as const;
```

### Imports

```typescript
// Good: Named imports
import { createActor } from './actor';
import type { ActorSubclass } from '@dfinity/agent';

// Good: External first, then internal
import { Command } from 'commander';
import { createActor } from './actor';
```

### Error Handling

```typescript
// Good: Descriptive errors
throw new Error(`Invalid canister ID format: ${canisterId}. Expected format: xxxxx-xxxxx`);

// Good: Catch with unused prefix
try {
  await deploy();
} catch (_error) {
  throw new Error('Deployment failed');
}
```

## Testing

### Test Structure

```
tests/
├── unit/           # Unit tests
├── cli/            # CLI tests
├── deployment/     # Deployment tests
├── icp/            # ICP integration tests
└── integration/    # Full integration tests
```

### Writing Tests

```typescript
import { describe, it, expect } from 'vitest';

describe('formatBalance', () => {
  it('should format balance with decimals', () => {
    const result = formatBalance(1000000000n, 9);
    expect(result).toBe('1');
  });

  it('should handle zero', () => {
    const result = formatBalance(0n, 18);
    expect(result).toBe('0');
  });
});
```

### Running Tests

```bash
# All tests
npm run test

# Specific file
npm run test tests/unit/format.test.ts

# Watch mode
npm run test:watch

# Coverage
npm run test -- --coverage
```

## Project Structure

```
agentvault/
├── src/              # Core library
│   ├── deployment/   # ICP client, deployer
│   ├── packaging/    # WASM compilation
│   ├── canister/     # Actor bindings
│   ├── wallet/       # Multi-chain wallets
│   ├── security/     # VetKeys, multisig
│   ├── monitoring/   # Health, metrics
│   ├── backup/       # Backup system
│   ├── archival/     # Arweave client
│   └── inference/    # Bittensor client
├── cli/              # CLI commands
│   ├── index.ts      # Entry point
│   └── commands/     # Command handlers
├── canister/         # Motoko canisters
├── webapp/           # Next.js dashboard
├── tests/            # Test suite
├── docs/             # Documentation
└── examples/         # Example agents
```

## Pull Request Guidelines

### Before Submitting

- [ ] Code compiles (`npm run build`)
- [ ] Tests pass (`npm run test`)
- [ ] Type check passes (`npm run typecheck`)
- [ ] Lint passes (`npm run lint`)
- [ ] PR has clear description
- [ ] Breaking changes documented

### PR Description Template

```markdown
## Summary
Brief description of changes

## Changes
- Item 1
- Item 2

## Testing
How to test these changes

## Breaking Changes
Any breaking changes (or "None")
```

## Release Process

Releases are handled by maintainers:

1. Update version in package.json
2. Update CHANGELOG.md
3. Create git tag
4. Build and publish to npm
5. Create GitHub release

## Getting Help

- Open a GitHub issue for bugs
- Start a discussion for features
- Check existing issues before creating new ones

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow
