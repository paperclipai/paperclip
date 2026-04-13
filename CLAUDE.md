# Paperclip Repo — Development Conventions

## Branch-per-Issue Workflow

All changes to this repository must be made on a dedicated branch tied to a Paperclip issue.

### Rules

1. **One branch per issue.** Branch name format: `DAR-{number}/{short-description}`
   - Example: `DAR-121/branching-process`
2. **Branch from `master`.** Always start from an up-to-date master:
   ```bash
   git checkout master && git pull
   git checkout -b DAR-XXX/short-description
   ```
3. **Merge back to `master` when the issue ships.** Use `--no-ff` to preserve the merge commit:
   ```bash
   git checkout master
   git merge --no-ff DAR-XXX/short-description -m "Merge DAR-XXX/short-description: <title>"
   git branch -d DAR-XXX/short-description
   ```
4. **Commit messages include the issue ID.** Format: `type(DAR-XXX): description`
   - Example: `feat(DAR-106): add YouTube extraction page`
5. **Every commit must include the co-author line:**
   ```
   Co-Authored-By: Paperclip <noreply@paperclip.ing>
   ```

### Why

- `pnpm dev` serves the live repo — changes are visible immediately
- Branch names tie the running code back to the issue that produced it
- Merging to master after each issue keeps history linear and clean
- No "recursive branches" — each issue merges before the next one starts

### Quick Reference

```bash
# Start new issue branch
git checkout master
git checkout -b DAR-XXX/my-feature

# Work, commit...
git add <files>
git commit -m "feat(DAR-XXX): description

Co-Authored-By: Paperclip <noreply@paperclip.ing>"

# Ship when done
git checkout master
git merge --no-ff DAR-XXX/my-feature -m "Merge DAR-XXX/my-feature: <title>

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
git branch -d DAR-XXX/my-feature
```
