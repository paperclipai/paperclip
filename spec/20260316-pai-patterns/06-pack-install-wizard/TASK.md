# Step 6: Pack/Install Wizard

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this task.

## Quick Reference
- **Branch:** `feat/pai-patterns-06-pack`
- **Complexity:** S
- **Dependencies:** Steps 1 (Workflows/), 2 (Customization layer)
- **Complexity:** S
- **Estimated files:** 3-4

## Objective
Auto-generate INSTALL.md and VERIFY.md files when publishing a skill, turning each skill into a self-installing package that any AI agent can follow. Upgrade publish-skill.ts to produce these files alongside the existing catalog publish.

## Context from Research
PAI's Packs have a 5-phase install wizard: System Analysis → User Questions → Backup → Installation → Verification. Each pack ships with INSTALL.md and VERIFY.md that an AI agent reads and executes step-by-step.

Our adaptation:
- INSTALL.md and VERIFY.md are **auto-generated** by publish-skill.ts (authors never write them)
- Generated from SKILL.md frontmatter, references/ listing, Workflows/ listing, and test-cases.md
- 5-phase wizard adapted to our stack (no voice server, no LaunchAgent, just file copy + hook setup)
- VERIFY.md pulls verification steps from test-cases.md automatically

**Why this matters:** Right now users install skills by... guessing? There's no guided process. An AI-readable INSTALL.md means "Install the autonomous-agent skill" just works.

## Prerequisites
- [ ] Step 1 complete (Workflows/ directory support in publish)
- [ ] Step 2 complete (Customization layer — install wizard can offer to set up PREFERENCES.md)

## Implementation

**Read these files first** (in parallel):
- `scripts/publish-skill.ts` — Current publish flow
- `skills/agent-building/autonomous-agent/SKILL.md` — Example skill to generate install for
- `skills/agent-building/autonomous-agent/references/test-cases.md` — Source for VERIFY.md

### 1. Design INSTALL.md Template

The generated INSTALL.md follows 5 phases:

```markdown
# Install: [Skill Name]

## Phase 1: Prerequisites Check
- [ ] Claude Code installed and running
- [ ] [Any MCP servers needed — extracted from SKILL.md content]
- [ ] [Any CLI tools needed — extracted from SKILL.md content]

## Phase 2: Configuration
[If skill references hooks] Set up the following hooks in ~/.claude/settings.json:
[Hook configurations extracted from SKILL.md]

[If skill has complex modes] Choose your preferred defaults:
- Default mode: [quick/standard/extensive]
- Create ~/.claude/skill-customizations/[skill-name]/PREFERENCES.md with your choices

## Phase 3: Installation
Copy skill files to your Claude Code skills directory:

```bash
# Create skill directory
mkdir -p ~/.claude/skills/[skill-name]/references
[If Workflows/ exist] mkdir -p ~/.claude/skills/[skill-name]/Workflows

# Copy SKILL.md
cp SKILL.md ~/.claude/skills/[skill-name]/SKILL.md

# Copy reference files
[For each reference file]
cp references/[file] ~/.claude/skills/[skill-name]/references/[file]

# Copy workflow files (if any)
[For each workflow file]
cp Workflows/[file] ~/.claude/skills/[skill-name]/Workflows/[file]
```

## Phase 4: Customization (Optional)
Create a customization file to override defaults:
```bash
mkdir -p ~/.claude/skill-customizations/[skill-name]
cat > ~/.claude/skill-customizations/[skill-name]/PREFERENCES.md << 'EOF'
# Skill Customization: [skill-name]
# Add your preferences below
EOF
```

## Phase 5: Verify Installation
Run the verification checklist: see VERIFY.md
```

### 2. Design VERIFY.md Template

Generated from test-cases.md:

```markdown
# Verify: [Skill Name]

## File Check
- [ ] ~/.claude/skills/[skill-name]/SKILL.md exists
- [ ] [For each reference] ~/.claude/skills/[skill-name]/references/[file] exists
- [ ] [For each workflow] ~/.claude/skills/[skill-name]/Workflows/[file] exists

## Trigger Tests
Try these prompts — the skill should fire:
[Extracted from test-cases.md trigger tests]
- [ ] "[trigger phrase 1]" → skill activates
- [ ] "[trigger phrase 2]" → skill activates

## No-Fire Tests
Try these prompts — the skill should NOT fire:
[Extracted from test-cases.md no-fire tests]
- [ ] "[no-fire phrase 1]" → skill does NOT activate

## Quick Smoke Test
[First output test case from test-cases.md as a guided walkthrough]

## Troubleshooting
- **Skill doesn't trigger:** Check that SKILL.md is at the correct path. Restart Claude Code.
- **Partial functionality:** Verify all reference files copied. Check for missing MCP servers.
- **Unexpected behavior:** Check ~/.claude/skill-customizations/[skill-name]/ for overrides.
```

### 3. Update publish-skill.ts

Add INSTALL.md and VERIFY.md generation to the publish flow:

```typescript
// After reading SKILL.md and references...

// Generate INSTALL.md
function generateInstallMd(name: string, slug: string, skillDir: string, refFiles: string[], wfFiles: string[]): string {
  // Build from template using extracted metadata
}

// Generate VERIFY.md
function generateVerifyMd(name: string, slug: string, skillDir: string, testCasesPath: string): string {
  // Parse test-cases.md, extract trigger/no-fire/output tests
  // Build verification checklist
}

// Write generated files to skill directory
const installContent = generateInstallMd(name, slug, skillDir, refFiles, wfFiles);
const verifyContent = generateVerifyMd(name, slug, skillDir, testCasesPath);

writeFileSync(join(skillDir, "INSTALL.md"), installContent);
writeFileSync(join(skillDir, "VERIFY.md"), verifyContent);

console.log(`Generated: INSTALL.md (${installContent.length} chars)`);
console.log(`Generated: VERIFY.md (${verifyContent.length} chars)`);
```

The generated files are written to the skill directory alongside SKILL.md. They get committed to git and published to the catalog.

### 4. Include in Catalog Payload

Update the publish payload to include install and verify content:

```typescript
const payload = {
  // ...existing fields...
  installGuide: installContent,
  verifyChecklist: verifyContent,
};
```

## Files to Create/Modify

### Modify:
- `scripts/publish-skill.ts` — Add INSTALL.md + VERIFY.md generation and catalog inclusion

### Auto-generated (by publish-skill.ts, not manually created):
- `skills/agent-building/[skill]/INSTALL.md` — Generated per skill on publish
- `skills/agent-building/[skill]/VERIFY.md` — Generated per skill on publish

## Verification

### Automated Checks
```bash
# Run publish on a test skill (dry-run or verify output)
bun run scripts/publish-skill.ts skills/agent-building/autonomous-agent/SKILL.md

# Verify INSTALL.md was generated
test -f skills/agent-building/autonomous-agent/INSTALL.md && echo "PASS" || echo "FAIL"

# Verify VERIFY.md was generated
test -f skills/agent-building/autonomous-agent/VERIFY.md && echo "PASS" || echo "FAIL"

# Verify INSTALL.md has all 5 phases
grep -c "## Phase" skills/agent-building/autonomous-agent/INSTALL.md  # Should be 5

# Verify VERIFY.md has trigger tests
grep -c "skill activates" skills/agent-building/autonomous-agent/VERIFY.md  # Should be > 0
```

### Manual Verification
- [ ] Generated INSTALL.md is readable and follows the 5-phase structure
- [ ] Generated VERIFY.md has file checks, trigger tests, and no-fire tests
- [ ] An AI agent could follow INSTALL.md without additional context
- [ ] VERIFY.md trigger tests match test-cases.md content
- [ ] publish-skill.ts still publishes to catalog correctly

## Success Criteria
- [ ] publish-skill.ts generates INSTALL.md and VERIFY.md on every publish
- [ ] INSTALL.md has 5 phases (Prerequisites, Configuration, Installation, Customization, Verify)
- [ ] VERIFY.md has file checks, trigger tests, no-fire tests, and smoke test
- [ ] Generated files reference Workflows/ if present (Step 1 integration)
- [ ] Generated files reference customization if applicable (Step 2 integration)
- [ ] Catalog payload includes install guide and verify checklist

## Scope Boundaries
**Do:** Auto-generate INSTALL.md and VERIFY.md, update publish script, include in catalog
**Don't:** Build an install CLI. Don't create a package manager. Don't add dependency resolution between skills.

## Escape Route Closure
- "We should build a `skill install [name]` CLI command" → Later. INSTALL.md is the interface. The AI reads it and executes. No CLI needed yet.
- "INSTALL.md should detect the user's environment automatically" → The AI agent does the detection. The INSTALL.md provides the checklist. Keep it simple.
- "We need dependency resolution between skills" → No. Skills are independent. If one skill references concepts from another, that's documentation, not a dependency.
