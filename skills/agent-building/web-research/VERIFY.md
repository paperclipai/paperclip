# Verify: Web Research

## File Check
- [ ] `~/.claude/skills/web-research/SKILL.md` exists
- [ ] `~/.claude/skills/web-research/references/anti-hallucination-hooks.md` exists
- [ ] `~/.claude/skills/web-research/references/output-contracts.md` exists
- [ ] `~/.claude/skills/web-research/references/progressive-deepening.md` exists
- [ ] `~/.claude/skills/web-research/references/research-agent-pattern.md` exists
- [ ] `~/.claude/skills/web-research/references/research-loop.md` exists
- [ ] `~/.claude/skills/web-research/references/source-corroboration.md` exists

## Trigger Tests
Try these prompts — the skill should fire:
- [ ] "I need Claude Code to do web research on competitor pricing" → skill activates
- [ ] "Claude keeps making up sources when I ask it to research things" → skill activates
- [ ] "How do I set up a multi-source research workflow in Claude Code?" → skill activates
- [ ] "I want to build an autonomous research agent" → skill activates
- [ ] "Claude hallucinated a URL in my research report - how do I fix this?" → skill activates
- [ ] "Set up a WebFetch workflow with source verification" → skill activates
- [ ] "I need a research loop for autonomous information gathering" → skill activates
- [ ] "Claude is hallucinating facts in my research - how do I stop it?" → skill activates
- [ ] "Help me build a progressive deepening research approach" → skill activates
- [ ] "How do I verify information from multiple sources in Claude Code?" → skill activates
- [ ] "Set up web search automation for market research" → skill activates
- [ ] "I can't trust Claude's research - it invents sources" → skill activates

## No-Fire Tests
Try these prompts — the skill should NOT fire:
- [ ] (No no-fire tests found in test-cases.md)

## Quick Smoke Test
1. Open Claude Code
2. Type: "I need Claude Code to do web research on competitor pricing"
3. Verify the skill activates and provides relevant guidance
4. Confirm output references the correct primitives for the goal

## Troubleshooting
- **Skill doesn't trigger:** Check that SKILL.md is at `~/.claude/skills/web-research/SKILL.md`. Restart Claude Code.
- **Partial functionality:** Verify all reference files copied. Check for missing MCP servers.
- **Unexpected behavior:** Check `~/.claude/skill-customizations/web-research/` for overrides.
