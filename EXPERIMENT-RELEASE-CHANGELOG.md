# Hands-On Experiment: Integrate `release-changelog` into Sprint-Delivery

**Difficulty:** Medium  
**Time:** 30-60 min  
**Value:** Save 5-10 min per sprint on release notes generation  
**Risk:** Low (skill is read-only on git repo)

---

## Goal

Modify your `sprint-delivery` skill to use Paperclip's `release-changelog` skill to auto-generate release notes from commit history and issue links, instead of manual prose.

---

## Current Flow

Your `sprint-delivery/SKILL.md` currently has:

```markdown
## Post-Deployment: Sprint Report

Create a `sprint-report.md` in the repo root with:
- What was built
- QA eval results summary
- Known issues
- Next sprint suggestions
```

**Problem:** This is manual, inconsistent, and doesn't link to git history.

---

## Desired Flow

```
[Delivery Engineer receives QA-approved sprint artifacts]
  ↓
[Invokes release-changelog skill with git tag range]
  ↓
[Skill analyzes commits + issue links]
  ↓
[Outputs structured CHANGELOG entry]
  ↓
[Delivery Engineer wraps in sprint-report.md + deploys]
```

---

## Part 1: Research (10 min)

### Step 1: Clone Paperclip repo

```bash
cd /tmp
git clone https://github.com/paperclipai/paperclip.git paperclip-ref
cd paperclip-ref
```

### Step 2: Read the release-changelog skill

```bash
cat .agents/skills/release-changelog/SKILL.md
```

**What to look for:**
- Input parameters (git repo path, from-tag, to-tag, etc.)
- Output format (JSON? Markdown? Structured?)
- Required environment (git CLI? Node.js?)
- Dependencies on other skills

### Step 3: Read the actual skill implementation

```bash
cat .agents/skills/release-changelog/index.js  # or similar
```

**What to look for:**
- How it invokes git commands
- Issue link extraction logic
- Markdown generation template
- Error handling for missing commits/tags

### Step 4: Document findings

Create a file: `docs/sprint-co-research/release-changelog-analysis.md`

```markdown
# release-changelog Skill Analysis

## Input Parameters
- `repoPath`: local git repo path
- `fromTag`: git tag or commit hash
- `toTag`: git tag or "HEAD"
- `format`: "markdown" or "json" (default: markdown)

## Output Format
Returns markdown text suitable for CHANGELOG.md

## Git Command Used
\`\`\`bash
git log --oneline --decorate $fromTag..$toTag
\`\`\`

## Issue Linking
Extracts #123 patterns from commit messages and links to GitHub issue API

## Limitations Found
- [list any findings that might affect your use]

## Integration Approach
Call skill after QA approval, pipe output to sprint-report.md
```

---

## Part 2: Design Integration (10 min)

### Decision 1: When to Call release-changelog

**Option A: During Pre-Deploy Checklist**
```
✅ QA eval status is PASS
✅ Generate CHANGELOG entry
✅ Build succeeds locally
✅ Deploy to Cloudflare
```

**Option B: After Successful Deploy**
```
✅ Deployed successfully
✅ Smoke tests pass
✅ Generate CHANGELOG entry + report
```

**Recommendation:** Option B (after deploy succeeds, so you know what actually shipped)

---

### Decision 2: How to Call It

**Option A: Invoke as a Paperclip skill (if using Paperclip API)**
```python
# Pseudo-code in your sprint-delivery agent
response = await paperclip.invoke_skill("release-changelog", {
  "repoPath": cwd,
  "fromTag": last_sprint_tag,
  "toTag": "HEAD",
  "format": "markdown"
})
changelog_md = response.output
```

**Option B: Call as a command-line tool**
```bash
# In sprint-delivery skill bash execution
npx paperclip-skill release-changelog \
  --repo-path . \
  --from-tag sprint-001 \
  --to-tag sprint-002 \
  > CHANGELOG-sprint-002.md
```

**Option C: Call Paperclip's internal npm module**
```javascript
const ReleaseChangelog = require("@paperclipai/skill-release-changelog");
const changelog = await ReleaseChangelog.generate({
  repoPath: process.cwd(),
  fromTag: "sprint-001",
  toTag: "sprint-002",
  format: "markdown"
});
```

**Recommendation:** Option C (if npm module exists) → Option A (via skill invoke) → Option B (shell)

---

### Decision 3: Template for Sprint Report

Currently you probably have something like:

```markdown
# Sprint Report — Sprint 001

## Summary
[Manual prose]

## Deliverables
- [manual list]

## QA Results
[Copy from eval-report.md]

## Known Issues
[Manual list]
```

**Proposed New Template:**

```markdown
# Sprint Report — Sprint 001

**Generated:** 2026-03-31 15:45:00 UTC  
**By:** Delivery Engineer (Claude Haiku)  
**Status:** ✅ SHIPPED

## Automated Changelog

[OUTPUT FROM release-changelog SKILL]

## QA Evaluation

[Summary from eval-report.md]
- Criteria Score: 8.2/10
- Status: PASS

## Smoke Test Results

[Delivery Engineer's manual smoke test checklist]
- ✅ Homepage loads
- ✅ Auth flow works
- ✅ API responds <200ms

## Known Issues

[Honest list from QA report + engineer notes]

## Next Sprint Recommendations

[From Product Planner's feedback]
```

---

## Part 3: Mock Invocation (20 min)

### Step 1: Create a test repo with sprint tags

```bash
cd /Volumes/JS-DEV/paperclip

# Create test commits simulating a sprint
git tag -a sprint-001 -m "Start of sprint 001" HEAD~10

# Make some fake sprint work
echo "# Feature 1" >> README.md
git add README.md
git commit -m "feat: add feature 1 (fixes #123)"

echo "# Feature 2" >> README.md
git commit --amend --no-edit

git tag -a sprint-002 -m "End of sprint 002" HEAD
```

### Step 2: Test release-changelog skill locally

If you can run it directly:

```bash
cd /tmp/paperclip-ref
node .agents/skills/release-changelog/index.js \
  --repo-path /Volumes/JS-DEV/paperclip \
  --from-tag sprint-001 \
  --to-tag sprint-002 \
  --format markdown
```

**Expected output:**
```markdown
# Changelog

## [sprint-002] - 2026-03-31

### Added
- Feature 1 (#123)
- Feature 2 (related to #124)

### Fixed
- [any bug fixes]

### Changed
- [any refactors]
```

### Step 3: Save output as `CHANGELOG-sprint-002.md`

```bash
# Pipe the output to a file
node .agents/skills/release-changelog/index.js \
  --repo-path /Volumes/JS-DEV/paperclip \
  --from-tag sprint-001 \
  --to-tag sprint-002 \
  --format markdown > /Volumes/JS-DEV/paperclip/CHANGELOG-sprint-002.md
```

---

## Part 4: Modify Sprint-Delivery Skill (20 min)

### Current sprint-delivery/SKILL.md Section

Find the "Post-Deployment" section:

```markdown
## Post-Deployment: Sprint Report

Create a `sprint-report.md` in the repo root with:
- What was built
- QA eval results summary
- Known issues
- Next sprint suggestions
```

### Replace With

```markdown
## Post-Deployment: Release Notes Generation

After smoke tests pass, invoke the `release-changelog` skill to auto-generate changelog from commit history:

### Steps

1. **Determine tag range:**
   - Last sprint tag: stored in `.sprint-meta.json` → `lastSprintTag`
   - Current sprint tag: `sprint-{SPRINT_ID}`
   
2. **Invoke release-changelog skill:**
   ```bash
   npx @paperclipai/skill-release-changelog \
     --repo-path . \
     --from-tag $LAST_SPRINT_TAG \
     --to-tag $CURRENT_SPRINT_TAG \
     --format markdown \
     > CHANGELOG-new.md
   ```
   
3. **Append to CHANGELOG.md:**
   ```bash
   cat CHANGELOG-new.md >> CHANGELOG.md
   git add CHANGELOG.md
   git commit -m "chore: release changelog for sprint-$SPRINT_ID"
   ```

4. **Create sprint-report.md:**
   ```markdown
   # Sprint Report — Sprint $SPRINT_ID
   
   **Status:** ✅ SHIPPED to production
   **Deployed:** [timestamp]
   **Smoke Tests:** ✅ All passed
   
   ## Changelog
   
   [Include generated changelog here]
   
   ## QA Results
   
   [Include eval-report.md summary]
   
   ## Known Issues
   
   [From QA eval]
   
   ## Engineering Notes
   
   [Any blockers or tech debt encountered]
   ```

5. **Push and tag:**
   ```bash
   git tag -a sprint-$SPRINT_ID -m "Sprint $SPRINT_ID complete"
   git push origin main sprint-$SPRINT_ID
   ```

### Dependencies

- `release-changelog` skill must be installed
- Git repo must have prior sprint tags (e.g., `sprint-001`, `sprint-002`)
- CHANGELOG.md must exist (or skill creates it)

### Error Handling

If release-changelog fails:
- Report error to Sprint Orchestrator
- Generate manual changelog entry
- Document incident for process improvement

### Time Savings

- **Before:** 5-10 min manual changelog writing
- **After:** 1-2 min skill invocation + review
- **Net savings:** ~4-8 min per sprint
```

---

## Part 5: Test in Next Sprint (Optional This Week)

### Before Sprint 002 Starts

1. **Commit modified skill to your branch:**
   ```bash
   cd /Volumes/JS-DEV/paperclip
   git add skills/sprint-delivery/SKILL.md
   git commit -m "feat: integrate release-changelog skill into sprint-delivery"
   ```

2. **During next sprint, at Deploy phase:**
   - Let Delivery Engineer try the new release-changelog integration
   - Time the execution
   - Compare generated CHANGELOG with manual prose quality
   - Document any issues

3. **After sprint, review:**
   - Did it save time? How much?
   - Was the generated changelog useful or too technical?
   - Any issues with git tag parsing?
   - Keep or iterate?

---

## Success Criteria

✅ **This experiment is successful if:**

1. release-changelog skill runs without errors
2. Generated CHANGELOG is more complete than manual version
3. Time saved ≥ 3 minutes per sprint
4. Output is human-readable (not too verbose, not too sparse)
5. Can be integrated into full sprint-delivery skill

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `release-changelog` not found | Check Paperclip repo for correct import path |
| Git tags don't exist | Create dummy sprint tags with `git tag -a sprint-NNN -m "msg"` |
| Output format is JSON not Markdown | Use `--format markdown` flag or postprocess JSON to markdown |
| Issue links are broken | Verify your repo has issue numbers in commit messages (#123) |
| Module dependency errors | Check `package.json` in release-changelog skill directory |

---

## Next Experiment

Once release-changelog is integrated and working, move to:

**Experiment B: Integrate `pr-report` into sprint-evaluator**
- Use AI-powered change analysis to enhance QA eval rubric
- Detect architectural risks automatically
- See: `PAPERCLIP-SKILLS-QUICKREF.md`

---

## Resources

- Paperclip Skills Directory: https://github.com/paperclipai/paperclip/tree/master/.agents/skills
- Your local docs: `docs/sprint-co-research/paperclip-docs/`
- Your sprint-delivery skill: `skills/sprint-delivery/SKILL.md`

