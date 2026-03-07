# Release Process

This document describes the process for releasing AgentVault to npm and GitHub.

## Prerequisites

Before creating a release, ensure:

- [ ] All tests passing (`npm test`)
- [ ] TypeCheck clean (`npm run typecheck`)
- [ ] No linting errors (`npm run lint`)
- [ ] Documentation updated
- [ ] Version number updated in `package.json` and `src/index.ts`

## Version Management

AgentVault uses semantic versioning: `MAJOR.MINOR.PATCH`

Example: `1.0.0` → `1.1.0` → `2.0.0`

### When to bump versions

- **MAJOR**: Breaking changes, API changes
- **MINOR**: New features, backwards compatible
- **PATCH**: Bug fixes, backwards compatible

### Updating Version

1. Update `package.json`:
```bash
npm version patch    # 1.0.0 → 1.0.1
npm version minor    # 1.0.0 → 1.1.0
npm version major    # 1.0.0 → 2.0.0
```

2. Update `src/index.ts`:
```typescript
export const VERSION = '1.0.0'
```

3. Tag commit:
```bash
git tag -a v1.0.0 -m "Release v1.0.0"
```

## Pre-Release Checklist

### Code Quality
- [ ] All tests passing
- [ ] No TypeScript errors
- [ ] No ESLint warnings
- [ ] Code formatted (`npm run lint:fix`)
- [ ] No console errors

### Documentation
- [ ] README.md updated with changelog
- [ ] User docs complete
- [ ] API docs generated (if applicable)
- [ ] Migration guides updated

### Testing
- [ ] Tested on local network
- [ ] Tested on multiple Node.js versions (18, 20, latest)
- [ ] Integration tests passing
- [ ] Manual deployment verified

### Release Notes
- [ ] Prepare release notes in CHANGELOG.md
- [ ] Document breaking changes
- [ ] Document new features
- [ ] Document bug fixes
- [ ] Document migration steps

## Release Process

### Step 1: Create Release Branch

```bash
# Create release branch from main
git checkout -b release/v1.0.0 main

# Merge latest changes
git merge main
```

### Step 2: Update Version

```bash
# Bump version
npm version patch

# Commit version update
git add package.json src/index.ts
git commit -m "Bump version to v1.0.1"
```

### Step 3: Build Distribution

```bash
# Clean previous build
rm -rf dist

# Build distribution
npm run build

# Verify build output
ls -la dist/
```

### Step 4: Run Full Test Suite

```bash
# Type check
npm run typecheck

# Lint
npm run lint

# Unit tests
npm test

# Integration tests (if applicable)
npm run test:integration
```

### Step 5: Create Git Tag

```bash
# Create annotated tag
git tag -a v1.0.1 -m "Release v1.0.1

# Push tag to remote
git push origin v1.0.1
```

### Step 6: Create GitHub Release

```bash
# Create GitHub release
gh release create v1.0.1 \
  --title "AgentVault v1.0.1" \
  --notes "Release notes here..." \
  --target main
```

### Step 7: Publish to npm

```bash
# Publish package
npm publish

# Or use dry-run first
npm publish --dry-run
```

### Step 8: Merge Back to Main

```bash
# Switch to main
git checkout main

# Merge release branch
git merge release/v1.0.0

# Delete release branch
git branch -d release/v1.0.0
```

## Automated Release with CI

The GitHub Actions workflow `.github/workflows/release.yml` automates steps 4-8.

When you push a tag like `v1.0.0`:

1. CI runs tests automatically
2. Builds distribution
3. Publishes to npm
4. Creates GitHub release

## Post-Release Tasks

### Verification

```bash
# Verify npm package
npm view agentvault

# Test installation
npm install -g agentvault@latest
agentvault --version

# Verify downloads
npm dist-tag ls agentvault
```

### Announcements

- [ ] Publish blog post
- [ ] Post to social media (X, LinkedIn)
- [ ] Send email to community/mailing list
- [ ] Update Discord announcement
- [ ] Update documentation website

### Monitoring

- [ ] Monitor npm download stats
- [ ] Monitor GitHub issues
- [ ] Monitor crash reports
- [ ] Update roadmap based on feedback

## Hotfixes

For urgent bug fixes after release:

```bash
# Create hotfix branch
git checkout -b hotfix/critical-bug main

# Fix the bug
# ... make changes ...

# Bump patch version
npm version patch

# Tag and publish
git tag -a v1.0.2 -m "Hotfix for critical bug"
git push origin v1.0.2
npm publish

# Merge back to main
git checkout main
git merge hotfix/critical-bug
```

## Rollback Plan

If critical issues discovered post-release:

1. **Stop deployment** - Immediately issue `agentvault stop`
2. **Notify users** - Public announcement
3. **Investigate** - Root cause analysis
4. **Release fix** - New version with fix
5. **Migration guidance** - Help users upgrade

## Security Before Release

### Vulnerability Scan

```bash
# Run npm audit
npm audit

# Run Snyk (if configured)
npx snyk test

# Fix vulnerabilities
npm audit fix
```

### Dependency Lock

```bash
# Generate lockfile
npm shrinkwrap

# Verify lockfile
git add npm-shrinkwrap.json
git commit -m "Add shrinkwrap for dependency lock"
```

### Access Control

- [ ] Verify npm access tokens are secure
- [ ] Use `.npmrc` for sensitive config
- [ ] Review `package.json` for exposed secrets
- [ ] Ensure private keys not in repository

## Release Notes Template

```markdown
# AgentVault v1.0.0

## Features
- 🚀 Production-ready AI agent platform
- ✅ Multi-chain wallet support (ICP, Polkadot, Solana)
- ✅ Web dashboard for agent management
- ✅ Batched canister operations
- ✅ Arweave archival integration
- ✅ Multi-sig approval workflows
- ✅ Real-time monitoring and metrics

## Breaking Changes
None - Initial stable release

## New Features
- Agent packaging and deployment
- Real-time log streaming
- Automated backups with Arweave
- Bittensor inference integration
- Multi-canister orchestration

## Bug Fixes
- Fixed cycles management
- Improved error handling
- Memory optimization fixes

## Upgrading

No upgrade steps needed for first release.

## Known Issues
- Wallet module has some pre-existing TypeScript errors (tracking separately)
- Webapp is local-only in v1.0 (deployment to IC in v2.0)
```

## Recovery

If npm publish fails:

```bash
# Unpublish version (emergency only)
npm unpublish agentvault@1.0.0

# Force publish next version
npm publish --force

# Request npm support
npm owner add agentvault npm-team
npm owner ls agentvault
```

## Communication

Channels for release announcements:

- **GitHub Releases**: https://github.com/your-org/agentvault/releases
- **X/Twitter**: @agentvaultdev
- **Discord**: https://discord.gg/agentvault
- **ICP Forum**: https://forum.dfinity.org/t/agentvault
- **Documentation**: https://docs.agentvault.dev

## Next Steps

After release:
1. [ ] Monitor for 24-48 hours for critical issues
2. [ ] Collect user feedback
3. [ ] Plan v1.0.1 improvements
4. [ ] Start development on v2.0 features
5. [ ] Schedule security audit
