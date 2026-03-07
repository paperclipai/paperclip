# Phase 5 PRD: Production Readiness

**Status:** In Planning  
**Duration:** Weeks 14-16  
**Dependencies:** Phase 4 Complete (webapp UI, backend modules)

---

## Executive Summary

Phase 5 brings AgentVault to production-ready state with three focus areas:

1. **Testing & Quality Assurance** - Comprehensive test coverage, CI/CD pipeline, load testing
2. **Documentation** - User guides, API docs, migration guides, examples
3. **Release Preparation** - npm packaging, CI builds, security review, public launch

The project has substantial architecture in place (webapp, backend modules, CLI), but lacks:
- Complete test coverage (~20% of modules tested)
- CI/CD pipeline (no GitHub Actions, no automated testing)
- Documentation beyond inline comments
- Production build configuration
- Security audit

Phase 5 bridges this gap for a public v1.0 release.

---

## Background

### What Phase 4 Completed

**Backend Modules** (this session):
- ✅ `src/archival/` - Arweave integration for permanent storage
- ✅ `src/inference/` - Bittensor client for external AI inference
- ✅ `src/security/multisig.ts` - Multi-sig approval workflows
- ✅ CLI commands: `archive`, `inference`, `approve`

**Webapp UI** (this session):
- ✅ Next.js 15 + React 19 + Tailwind scaffold
- ✅ 8 dashboard pages (agents, tasks, logs, wallets, networks, backups, settings, canisters)
- ✅ 18 API routes (GET/POST/DELETE)
- ✅ 21 components (agents/, tasks/, logs/, wallets/, common/)
- ✅ 6 custom hooks (useAgentList, useCanisterStatus, etc.)
- ✅ 2 providers (Theme, IC context)
- ✅ 4 lib utilities (api-client, utils, icp-connection, types)

**Previous Sessions** (per summaries):
- ✅ Agent execution layer (`src/packaging/`, `src/testing/`)
- ✅ Wallet system (`src/wallet/`, multi-chain support)
- ✅ ICP tools integration (`src/icp/`, `src/deployment/`)
- ✅ Monitoring & metrics (`src/monitoring/`, `src/metrics/`)
- ✅ Batching system (`src/icp/batch.ts`)

### What's Missing

**Testing**:
- Only 20 test files exist, many modules untested
- No integration tests for webapp
- No end-to-end tests
- No load testing
- Test files have pre-existing errors (wrong signatures)

**CI/CD**:
- No `.github/` directory or workflows
- No automated builds on push
- No automated testing
- No deployment automation
- No automated release generation

**Documentation**:
- Only internal PRDs and code comments
- No user guide
- No API documentation
- No migration guides
- No developer extension guide

**Configuration**:
- `dfx.json` minimal (no mainnet/staging)
- `icp.yaml` only has local environment
- No production deployment config

**Security**:
- No external audit
- Wallet module has TypeScript errors
- No vulnerability scanning

---

## Phase 5 Goals

### Primary Goals

1. **Achieve 80%+ test coverage** across all modules
2. **Establish CI/CD pipeline** with automated testing on every PR
3. **Write comprehensive documentation** for users and developers
4. **Prepare for npm v1.0.0 release** with proper packaging
5. **Conduct security review** (self-audit or external if budget allows)

### Secondary Goals

1. Add integration tests with real agent examples
2. Add load testing for 100+ concurrent agents
3. Create video tutorials or GIF walkthroughs
4. Set up automated changelog generation
5. Prepare announcement materials (blog post, GitHub release notes)

---

## Detailed Work Plan

### Week 14: Testing & Quality

#### 1.1 Expand Test Suite

**Unit Tests** (expand existing):
- `src/archival/*` - Add tests for ArweaveClient, ArchiveManager
- `src/inference/*` - Add tests for BittensorClient, InferenceManager
- `src/security/multisig.ts` - Add approval workflow tests
- `src/metrics/*` - Add metrics aggregation tests
- `src/backup/*` - Add backup/restore tests
- `src/icp/batch.ts` - Add topological sort and batch tests
- `src/deployment/*` - Expand deployer tests beyond stubs

**Integration Tests** (new):
- `tests/integration/` - End-to-end agent packaging workflow
- `tests/integration/` - End-to-end deployment to local ICP
- `tests/integration/` - Wallet-to-canister transaction flow
- `tests/integration/` - Webapp API route tests
- `tests/integration/` - Multi-sig approval flow

**Webapp Tests** (new):
- `webapp/tests/` - Component unit tests
- `webapp/tests/` - Hook tests
- `webapp/tests/` - API route tests
- `webapp/tests/` - E2E with Playwright

**Load Tests** (new):
- `tests/load/` - Simulate 100 agent packaging operations
- `tests/load/` - Simulate 50 concurrent deployments
- `tests/load/` - Simulate high-frequency metrics ingestion

#### 1.2 Fix Pre-existing Test Errors

From `npm run typecheck`:
- `tests/cli/commands/init.test.ts` - Fix incorrect function signature (line 105)
- `tests/deployment/icpClient.test.ts` - Remove/fix references to non-existent `createCanister`, `installCode`, `validateWasmPath`, `calculateWasmHash`
- `tests/packaging/compiler.test.ts.bak` - Remove or restore this backup file

#### 1.3 CI/CD Pipeline

**GitHub Actions** (create `.github/workflows/`):

1. `test.yml`:
   ```yaml
   name: Test
   on: [push, pull_request]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 20
         - run: npm ci
         - run: npm run typecheck
         - run: npm run lint
         - run: npm test
   ```

2. `test-webapp.yml`:
   ```yaml
   name: Test Webapp
   on: [push, pull_request]
   defaults:
     run:
       working-directory: ./webapp
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 20
         - run: pnpm install
         - run: pnpm build
         - run: pnpm test
   ```

3. `release.yml`:
   ```yaml
   name: Release
   on:
     push:
       tags: ['v*']
   jobs:
     release:
       runs-on: ubuntu-latest
       permissions:
         contents: write
         id-token: write
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
         - run: npm ci
         - run: npm run build
         - uses: JS-DevTools/npm-publish@v3
         - run: npm publish
   ```

#### 1.4 Coverage Reports

- Configure Vitest to generate HTML coverage reports
- Add coverage badge to README
- Set minimum coverage threshold (80%)

---

### Week 15: Documentation

#### 2.1 User Documentation

Create `docs/user/`:

1. `getting-started.md`:
   - Installation instructions (`npm install -g agentvault`)
   - Prerequisites (dfx, Node.js 18+)
   - First project: `agentvault init my-agent`
   - Local testing: `agentvault test`
   - Deployment: `agentvault deploy`

2. `deployment.md`:
   - Local deployment (`dfx` integration)
   - Production deployment (mainnet)
   - Configuration (`agent.yaml` options)
   - Environment variables
   - Troubleshooting common issues

3. `wallets.md`:
   - Creating/importing wallets
   - Multi-chain support (Polkadot, Solana, ICP)
   - Signing transactions
   - Transaction history
   - Backup/export

4. `backups.md`:
   - Creating backups
   - Restoring from backup
   - Arweave archival
   - Best practices

5. `webapp.md`:
   - Starting the dashboard (`npm run dev`)
   - Navigating the UI
   - Managing agents through the web interface
   - Viewing logs and metrics
   - Connecting wallets

6. `troubleshooting.md`:
   - Common errors and solutions
   - Debug mode (`agentvault --debug`)
   - Log locations
   - Getting help (GitHub issues, Discord/community)

#### 2.2 Developer Documentation

Create `docs/dev/`:

1. `architecture.md`:
   - Module organization
   - Data flow diagrams
   - ICP integration patterns
   - Wallet system design
   - Packaging pipeline

2. `extending-agents.md`:
   - Custom agent parser implementation
   - Agent metadata specification (`agent.yaml`)
   - Adding new runtime support
   - Example: creating a "Python agent" parser

3. `canister-development.md`:
   - Canister Candid interface design
   - `agent.mo` Motoko source guide
   - Extending canister functionality
   - Testing canisters locally

4. `api-reference.md`:
   - CLI command reference (all 36 commands)
   - TypeScript API (`src/index.ts` exports)
   - Webapp API routes documentation
   - Type definitions

5. `contributing.md`:
   - Development setup
   - Running tests
   - Code style guidelines
   - Pull request process
   - Release process

#### 2.3 Migration Guides

Create `docs/migration/`:

1. `from-v0.x.md` (when v2.x exists)
2. `examples/`:
   - Migrating from Clawdbot configuration
   - Migrating from Cline config
   - Migrating generic agents
   - Importing existing wallets

#### 2.4 README Updates

Expand `README.md` with:
- Feature highlights (with GIFs/screenshots)
- Installation quickstart
- Basic usage examples
- Links to full documentation
- Contributing section
- License information

#### 2.5 Inline Code Documentation

Add JSDoc comments to:
- All exported functions in `src/index.ts`
- CLI command functions
- Webapp components
- API route handlers

---

### Week 16: Release Preparation

#### 3.1 Package Configuration

Update `package.json`:
- Ensure all dependencies are semver-pinned
- Add `files` field to exclude unnecessary files
- Add `engines` strictness
- Update `repository`, `bugs`, `homepage` fields
- Add keywords for npm search

Example:
```json
{
  "files": [
    "dist/**/*",
    "cli/**/*",
    "bin",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "keywords": [
    "icp",
    "internet-computer",
    "ai-agents",
    "agent-framework",
    "canister",
    "motoko",
    "multi-chain",
    "wallet"
  ]
}
```

#### 3.2 Webapp Production Build

Update `webapp/next.config.ts`:
- Add environment variables for production
- Configure image optimization
- Set up ICP deployment config

Create `webapp/Dockerfile`:
```dockerfile
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable pnpm && pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
USER nextjs
EXPOSE 3000
ENV PORT 3000
ENV HOSTNAME "0.0.0.0"
CMD ["node", "server.js"]
```

#### 3.3 Security Review

**Self-Audit**:
- Review `src/wallet/` TypeScript errors and fix
- Review `src/security/vetkeys.ts` for cryptographic correctness
- Audit canister `agent.mo` for security vulnerabilities
- Check for hardcoded secrets or keys
- Review dependency tree for known vulnerabilities (`npm audit`)

**External Audit** (if budget allows):
- Engage with ICP security team
- Review VetKeys implementation
- Review canister code
- Review wallet cryptography

#### 3.4 Configuration for Production

Update `dfx.json`:
```json
{
  "canisters": {
    "agent_vault": {
      "main": "canister/agent.mo",
      "type": "motoko"
    }
  },
  "networks": {
    "local": {
      "bind": "127.0.0.1:8000",
      "type": "ephemeral"
    },
    "ic": {
      "providers": ["https://ic0.app", "https://icgateway.net"],
      "type": "persistent"
    }
  }
}
```

Update `icp.yaml`:
```yaml
environments:
  local:
    network:
      type: local
    replicaCount: 4
    cycles:
      initial: 100T

  production:
    network:
      type: ic
    replicaCount: 20
    cycles:
      initial: 500T
      refillThreshold: 100T

optimization:
  level: 3
  shrink: true
  removeDebug: true

security:
  vetKeys: true
  auditCanister: true
```

#### 3.5 Release Process

Create `docs/dev/release-process.md`:
1. Update version in `package.json` and `src/index.ts` (VERSION constant)
2. Update CHANGELOG.md
3. Run full test suite (`npm test` + webapp tests)
4. Build all artifacts (`npm run build`, `cd webapp && pnpm build`)
5. Create git tag (`git tag -a v1.0.0 -m "v1.0.0 release"`)
6. Push tag (`git push origin v1.0.0`)
7. CI automatically publishes to npm
8. Create GitHub release from tag
9. Announce on X, Discord, Reddit, ICP community

#### 3.6 Announcement Materials

Create `docs/marketing/`:
- Blog post draft
- GitHub release notes
- Social media posts (Twitter/X, LinkedIn)
- Email newsletter draft (if applicable)
- Demo video (5-min walkthrough)

---

## Deliverables

### Week 14
- [ ] 30+ new test files (unit + integration + load)
- [ ] All pre-existing test errors fixed
- [ ] CI/CD pipeline active on GitHub Actions
- [ ] Coverage reports generated (80%+ threshold)
- [ ] Load test results document

### Week 15
- [ ] Complete user guide (6+ markdown files)
- [ ] Complete developer guide (5+ markdown files)
- [ ] Migration guides (3+ examples)
- [ ] Expanded README with screenshots/GIFs
- [ ] API reference documentation
- [ ] JSDoc comments on all exports

### Week 16
- [ ] Package configuration finalized
- [ ] Production `dfx.json` and `icp.yaml`
- [ ] Security self-audit completed (or external audit report)
- [ ] Dockerfile for webapp
- [ ] Release process documented
- [ ] Announcement materials ready
- [ ] `CHANGELOG.md` created

### Final Deliverable
- [ ] AgentVault v1.0.0 published to npm
- [ ] Public announcement on GitHub
- [ ] Documentation website live (or linked from README)
- [ ] Example agents updated and tested

---

## Success Criteria

Phase 5 is complete when:

1. **Test Coverage**: 80%+ across all modules (verified by Vitest reports)
2. **CI/CD**: Every push triggers automated tests and passes
3. **Documentation**: User can install and deploy without asking questions
4. **Package**: `npm install -g agentvault` works and all commands available
5. **Security**: No critical vulnerabilities, audit passed
6. **Announcement**: Public release with v1.0.0 tag

---

## Open Questions

1. **Budget**: Is external security audit funded? If not, focus on thorough self-audit
2. **Documentation Hosting**: Use GitHub Pages, Docusaurus, or just markdown in repo?
3. **Webapp Deployment**: Should webapp be deployed to ICP as a canister for v1.0?
4. **Example Agents**: Should we create additional example agents beyond the 4 existing?
5. **Testing Infrastructure**: Should load tests run on every PR or only on releases?

---

## Dependencies & Risks

### Dependencies
- All Phase 4 work must be merged
- Test infrastructure must be stable
- CI/CD pipeline must be tested before release

### Risks
- **Low**: Documentation gaps - can be filled post-release if needed
- **Medium**: Test coverage target - some complex modules may be hard to test
- **Medium**: CI/CD pipeline setup - may need iteration to get right
- **High**: Security vulnerabilities - could delay release if critical issues found

---

## Timeline

```
Week 14:
  Day 1-2:  Fix pre-existing test errors
  Day 3-4:  Add unit tests for new modules
  Day 5-7:  Add integration tests, setup CI/CD

Week 15:
  Day 1-3:  Write user documentation
  Day 4-5:  Write developer documentation
  Day 6-7:  Update README, add JSDoc, create migration guides

Week 16:
  Day 1-2:  Package configuration, production config files
  Day 3-4:  Security audit (self or external)
  Day 5-6:  Create release process, announcement materials
  Day 7:   Release v1.0.0
```

---

## Resources

- **Vitest**: https://vitest.dev
- **GitHub Actions**: https://docs.github.com/actions
- **Docusaurus**: https://docusaurus.io (for docs site, if needed)
- **ICP Security**: https://internetcomputer.org/docs/current/developer-docs/security/
- **npm Publishing**: https://docs.npmjs.com/cli/publish
