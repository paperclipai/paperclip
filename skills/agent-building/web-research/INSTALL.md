# Install: Web Research

## Phase 1: Prerequisites Check
- [ ] Claude Code installed and running

## Phase 2: Configuration
Set up the following hooks in `~/.claude/settings.json`:
```json
{
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "/abs/path/to/hook.sh" }] }]
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/abs/path/to/hook.sh" }] }]
    "Stop": [{ "hooks": [{ "type": "command", "command": "/abs/path/to/hook.sh" }] }]
  }
}
```

**Critical:** Use absolute paths in hook commands. Relative paths silently fail.

Choose your preferred defaults:
- Create `~/.claude/skill-customizations/web-research/PREFERENCES.md` with your choices (see Phase 4)

## Phase 3: Installation
Copy skill files to your Claude Code skills directory:

```bash
# Create skill directory
mkdir -p ~/.claude/skills/web-research/references

# Copy SKILL.md
cp SKILL.md ~/.claude/skills/web-research/SKILL.md

# Copy reference files
cp references/anti-hallucination-hooks.md ~/.claude/skills/web-research/references/anti-hallucination-hooks.md
cp references/output-contracts.md ~/.claude/skills/web-research/references/output-contracts.md
cp references/progressive-deepening.md ~/.claude/skills/web-research/references/progressive-deepening.md
cp references/research-agent-pattern.md ~/.claude/skills/web-research/references/research-agent-pattern.md
cp references/research-loop.md ~/.claude/skills/web-research/references/research-loop.md
cp references/source-corroboration.md ~/.claude/skills/web-research/references/source-corroboration.md
```

## Phase 4: Customization (Optional)
Create a customization file to override defaults:
```bash
mkdir -p ~/.claude/skill-customizations/web-research
cat > ~/.claude/skill-customizations/web-research/PREFERENCES.md << 'EOF'
# Skill Customization: web-research
# Add your preferences below
EOF
```

## Phase 5: Verify Installation
Run the verification checklist: see VERIFY.md
