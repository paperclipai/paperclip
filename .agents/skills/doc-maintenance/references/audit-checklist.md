# Doc Maintenance Audit Checklist

Use this checklist when auditing each target document. For each item, compare
against the change summary from git history.

## README.md

### Features table
- [ ] Each feature card reflects a shipped capability
- [ ] No feature cards for things that don't exist yet
- [ ] No major shipped features missing from the table

### Roadmap
- [ ] Nothing listed as "planned" or "coming soon" that already shipped
- [ ] No removed/cancelled items still listed
- [ ] Items reflect current priorities (cross-check with recent PRs)

### Quickstart
- [ ] `npx paperclipai onboard` command is correct
- [ ] Manual install steps are accurate (clone URL, commands)
- [ ] Prerequisites (Node version, pnpm version) are current
- [ ] Server URL and port are correct

### "What is Paperclip" section
- [ ] High-level description is accurate
- [ ] Step table (Define goal / Hire team / Approve and run) is correct

### "Works with" table
- [ ] All supported adapters/runtimes are listed
- [ ] No removed adapters still listed
- [ ] Logos and labels match current adapter names

### "Paperclip is right for you if"
- [ ] Use cases are still accurate
- [ ] No claims about capabilities that don't exist

### "Why Paperclip is special"
- [ ] Technical claims are accurate (atomic execution, governance, etc.)
- [ ] No features listed that were removed or significantly changed

### FAQ
- [ ] Answers are still correct
- [ ] No references to removed features or outdated behavior

### Development section
- [ ] Commands are accurate (`pnpm dev`, `pnpm build`, etc.)
- [ ] Link to DEVELOPING.md is correct

## doc/SPEC.md

### Company Model
- [ ] Fields match current schema
- [ ] Governance model description is accurate

### Agent Model
- [ ] Adapter types match what's actually supported
- [ ] Agent configuration description is accurate
- [ ] No features described as "not supported" or "not V1" that shipped

### Task Model
- [ ] Task hierarchy description is accurate
- [ ] Status values match current implementation

### Extensions / Plugins
- [ ] If plugins are shipped, no "not in V1" or "future" language
- [ ] Plugin model description matches implementation

### Open Questions
- [ ] Resolved questions removed or updated
- [ ] No "TBD" items that have been decided

## doc/PRODUCT.md

### Core Concepts
- [ ] Company, Employees, Task Management descriptions accurate
- [ ] Agent Execution modes described correctly
- [ ] No missing major concepts

### Principles
- [ ] Principles haven't been contradicted by shipped features
- [ ] No principles referencing removed capabilities

### User Flow
- [ ] Dream scenario still reflects actual onboarding
- [ ] Steps are achievable with current features
