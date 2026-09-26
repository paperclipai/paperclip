---
name: "source-command-spartan-commit-message-with-codex"
description: "Create a commit message and PR description, push/open the PR, then chain into Codex PR review."
key: "paperclipai/optional/agency-agents/source-command-spartan-commit-message-with-codex"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "source"
  - "command"
  - "spartan"
  - "commit"
  - "message"
  - "with"
  - "codex"
defaultInstall: false
---
# source-command-spartan-commit-message-with-codex

Use this skill when the user asks to run the migrated source command `spartan-commit-message-with-codex`.

## Command Template

## Run these commands first:

```bash
git status
git diff --staged
git log --oneline -5
git branch --show-current
```

## Your task:

Analyze the staged git changes, create a commit message with PR description, push/open the PR, then run `/spartan:ship-pr-codex`.

### Step 1: Extract ticket from branch name
The branch name follows pattern: `lbf-XXXX-description` or `feature/lbf-XXXX-description`
Extract the ticket number (e.g., LBF-1647) to use as prefix. Convert to uppercase (LBF-XXXX).

### Step 2: Determine if this is the first commit on the branch
- Fetch origin, then resolve the base branch name from `origin/HEAD`; fall back to `master`, then `main`, then `dev`.
- Use `origin/<base>` when it exists for commit comparison, while keeping the short branch name for `gh pr create --base`.
- Run `git log <base-ref>..HEAD --oneline` to see existing commits on this branch vs the base branch.
- If no commits exist (empty output): Use FULL PR template in commit body
- If commits exist: Use SHORT format (just the change summary)

### Commit types with emojis:

- ✨ `feat:` - New feature
- 🐛 `fix:` - Bug fix
- 🔨 `refactor:` - Refactoring code
- 📝 `docs:` - Documentation
- 🎨 `style:` - Styling/formatting
- ✅ `test:` - Tests
- ⚡ `perf:` - Performance
- 🔒 `security:` - Security fix
- 📗 `deps:` - Dependency update

## Commit message format:

### First commit on branch (FULL format):
```
[TICKET-ID] <emoji> <type>: <concise_description>

## Summary

### Why
<Clearly define the issue or problem that your changes address.>

### What
<High-level overview of what has been modified, added, or removed.>

### Solution
<Architectural or design decisions made while implementing.>

## Impact Area
<Impacted features - helps QA and Release Manager.>

## Types of Changes
- [ ] ❌ Breaking change
- [ ] 🚀 New feature
- [ ] 🕷 Bug fix
- [ ] 👏 Performance optimization
- [ ] 🛠 Refactor
- [ ] 📗 Library update
- [ ] 📝 Documentation
- [ ] ✅ Test
- [ ] 🔒 Security awareness

## Test Plan
<Steps to test this PR.>

## Checklist:
- [ ] I have performed a self-review of my own code
- [ ] I have tested that the feature or bug fix works as expected
- [ ] I have included helpful comments, particularly in hard-to-understand areas
- [ ] I have added tests that prove my changes are functioning
- [ ] New and existing unit tests pass locally with my changes

## Related Issues
<Reference tickets and conversations.>
```

### Subsequent commits (SHORT format):
```
[TICKET-ID] <emoji> <type>: <concise_description>

<Brief summary of changes in 2-3 lines>
```

**Do NOT add `Co-Authored-By` lines or any AI/bot attribution (Codex, Anthropic, "Generated with", etc.) in either format. Commit metadata is for the human author only.**

## Workflow:

1. Run `git add .` to stage all changes
2. Show summary of staged changes (files modified, lines added/removed)
3. Propose the commit message based on whether it's first or subsequent commit
4. **WAIT for user confirmation** - DO NOT auto-commit
5. If user confirms, run `git commit` with the message using HEREDOC format:
   ```bash
   git commit -m "$(cat <<'EOF'
   <commit message here>
   EOF
   )"
   ```
6. Then run `git push -u origin <branch-name>`
7. **Detect whether the branch needs a new PR**:
   - Run `gh pr view --json number,url 2>&1`
   - If exit code is non-zero (no PR exists for this branch), continue to step 8.
   - If a PR already exists, skip step 8 and go to step 9.
8. **Create the PR** via:
   ```bash
   git fetch origin --quiet
   DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
   if [ -z "$DEFAULT_BRANCH" ]; then
     if git show-ref --quiet refs/remotes/origin/master; then
       DEFAULT_BRANCH=master
     elif git show-ref --quiet refs/remotes/origin/main; then
       DEFAULT_BRANCH=main
     elif git show-ref --quiet refs/remotes/origin/dev; then
       DEFAULT_BRANCH=dev
     else
       DEFAULT_BRANCH=master
     fi
   fi
   gh pr create --fill --base "$DEFAULT_BRANCH" --draft=false
   ```
   - `--fill` reuses the commit's title and body, so the FULL PR template
     written into the commit message becomes the PR description.
9. **Chain into `/spartan:ship-pr-codex` automatically** to run Codex review
   and push clearly-valid fixes back to this PR:
   - Default to `--rounds 2`.
   - If the user passed `--rounds N` to `/spartan:commit-message-with-codex`,
     forward that value.
   - If `/spartan:ship-pr-codex` is not installed in this project, skip this
     step and report the PR URL directly.

**CRITICAL: Always wait for explicit user approval before committing and pushing in step 4.** Once they confirm, the rest of the chain (push → PR → Codex PR review) runs without further prompts.
