# Paperclip Skills Quick Reference for Sprint-Co

**Your Current Setup:**
- Company: sprint-co (7 agents across 3 teams)
- All agents: claude-haiku-4-5
- Deployment: Cloudflare Workers/Pages
- Skill set: sprint-delivery, sprint-evaluator, sprint-generator, sprint-planner, sprint-protocol

---

## Available Skills from Paperclip Repo

### 🔴 **HIGHEST PRIORITY** (Immediate Integration)

#### 1. `release-changelog`
```
What: Auto-generate CHANGELOG from commits + issue links
Why: Delivery Engineer currently writes release notes manually (5-10 min per sprint)
How: Call from sprint-delivery skill, pass git repo + tag range
Cost Impact: ✅ Time savings 5-10 min/sprint
Where: https://github.com/paperclipai/paperclip/tree/master/.agents/skills/release-changelog
```

**Next Step:** Read `release-changelog/SKILL.md`, add 3-line invocation to `sprint-delivery/SKILL.md`

---

#### 2. `pr-report`
```
What: AI-powered PR summary + change risk analysis
Why: QA Engineer evaluates code for architectural flaws (currently manual review)
How: Feed PR diff to pr-report, use output to inform eval rubric scoring
Cost Impact: ✅ Deeper quality signals, more consistent scoring
Where: https://github.com/paperclipai/paperclip/tree/master/.agents/skills/pr-report
```

**Next Step:** Read `pr-report/SKILL.md`, mock PR eval workflow in sprint-evaluator

---

### 🟡 **MEDIUM PRIORITY** (Next 2 Weeks)

#### 3. `create-agent-adapter`
```
What: Scaffold custom adapters for non-OpenAI models (LLaMA, Codex, etc.)
Why: Test cheaper models in eval phase, reduce cost
How: Use skill to generate LLaMA-7B adapter, wire into Agent config
Cost Impact: 💰 Potential 40-60% cost savings on eval phase if LLaMA ≥ 95% quality
Where: https://github.com/paperclipai/paperclip/tree/master/.agents/skills/create-agent-adapter
```

**Next Step:** Study Hermes adapter (NousResearch) as reference, plan LLaMA variant

---

#### 4. `doc-maintenance`
```
What: Auto-sync AGENTS.md, COMPANY.md, TEAM.md from live configs
Why: Your docs can drift from reality; agents should always see latest spec
How: Let skill update docs post-sprint, verify in git diff before commit
Cost Impact: ✅ No more stale docs; source of truth is code, not markdown
Where: https://github.com/paperclipai/paperclip/tree/master/.agents/skills/doc-maintenance
```

**Next Step:** Study skill, create test run on docs/companies/sprint-co/

---

### 🟢 **LOWER PRIORITY** (Research Only This Month)

#### 5. `company-creator`
```
What: Scaffold new company packages from templates
Why: Rapid A/B testing of org structures (4-agent vs 7-agent, etc.)
How: Use to generate sprint-co-lite, run side-by-side variant sprint
Cost Impact: 🧪 Experimental; unlocks iteration velocity on org design
Where: https://github.com/paperclipai/paperclip/tree/master/.agents/skills/company-creator
```

**Next Step:** Read skill, identify 2-3 company variants to test

---

#### 6. `release`
```
What: Full release workflow (tag, note, deploy, notify)
Why: Delivery Engineer currently runs manual commands (git tag, etc.)
How: Invoke from sprint-delivery, hook into Paperclip's task/approval system
Cost Impact: 🎯 Depends on approval gate complexity; likely 2-3 min savings
Where: https://github.com/paperclipai/paperclip/tree/master/.agents/skills/release
```

**Next Step:** Read skill, understand if it conflicts with Cloudflare deploy flow

---

## Key Paperclip Patterns You Should Know

### Pattern 1: Heartbeat Cadence
**What your sprint-co does:**
- Sprint Orchestrator wakes every 15 min during active sprint
- All other agents wake only when assigned work

**What you could do:**
- Aggressive heartbeat during build phase (10 min) to catch blockers early
- Relaxed heartbeat during eval phase (20 min) to let QA finish long tests
- No heartbeat between sprints (cost savings)

**Config Change Location:** `docs/companies/sprint-co/COMPANY.md` → Agent section → `heartbeat`

---

### Pattern 2: Cost Control & Escalation
**What your sprint-co does:**
- Haiku-only architecture; no escalation

**What Paperclip enables:**
- Per-agent monthly budgets (e.g., Engineer Alpha gets $50/month)
- Automatic pause when budget exceeded
- Smart routing: try cheap model first, escalate if confidence <X

**Where to implement:** Create `cost-config.yaml` or extend COMPANY.md with budget fields

---

### Pattern 3: Approval Gates
**What Paperclip supports:**
- Board-level approvals (pause execution until human sign-off)
- Automatic approval workflows (e.g., auto-approve if cost <$10)
- Comment-based approval (agent mentions `:approve` in comment)

**Why you might want this:**
- High-stakes sprints (client work, production changes)
- Cost control (auto-pause if >2x expected cost)
- Quality gates (QA must explicitly approve before deploy)

**Where to add:** `sprint-protocol/SKILL.md` → add approval step before phase transitions

---

### Pattern 4: Goal Tracing
**What your sprint-co has:**
- Sprint mission (e.g., "Build auth system")
- Agent job descriptions (e.g., Engineer Alpha = "full-stack generator")

**What Paperclip adds:**
- Explicit `GOAL.md` files linking to company mission
- Every task traces back to a goal
- Visibility: agents see why work matters
- Metrics: cost/quality per goal over time

**Example Sprint Goal:**
```yaml
slug: sprint-001-auth-build
name: Auth System Build Sprint
description: Implement OAuth2 + session management
linked-tasks: [TASK-1, TASK-2, TASK-3, ...]
budget: $25
deadline: 2026-04-01T15:00:00Z
```

---

## Integration Checklist

### This Week
- [ ] Skim all 6 skill SKILL.md files (30 min)
- [ ] Study `release-changelog` in detail (15 min)
- [ ] Study `pr-report` in detail (15 min)
- [ ] Sketch how to add release-changelog to sprint-delivery skill (10 min)
- [ ] Sketch how to add pr-report to sprint-evaluator skill (10 min)

### Next 2 Weeks
- [ ] Fork/clone Paperclip repo to understand skill structure
- [ ] Create draft modified sprint-delivery skill with release-changelog
- [ ] Create draft modified sprint-evaluator skill with pr-report
- [ ] Test both in a non-sprint context (manual invocation)
- [ ] Review Hermes adapter to understand custom adapter pattern

### Next Month
- [ ] Decide: implement approval gates or cost routing first?
- [ ] Run first full sprint with 1 integrated skill (release-changelog)
- [ ] Measure: time savings, cost impact
- [ ] Expand to 2nd skill (pr-report)
- [ ] Plan company variant (sprint-co-lite) experiment

---

## Key URLs

| Resource | URL |
|----------|-----|
| Paperclip Repo | https://github.com/paperclipai/paperclip |
| Skills Directory | https://github.com/paperclipai/paperclip/tree/master/.agents/skills |
| Main Docs | https://docs.paperclip.ing |
| Discord | https://discord.gg/m4HZY7xNG3 |
| Hermes Adapter Ref | https://github.com/NousResearch/hermes-paperclip-adapter |

---

## Your Local Reference Docs

You already have these locally (in `docs/sprint-co-research/paperclip-docs/`):
- `companies-spec.md` — company/team/agent package format
- `paperclip-skill.md` — how to write skills
- `heartbeat-protocol.md` — heartbeat lifecycle
- `how-agents-work.md` — agent concepts
- `task-workflow.md` — task/issue lifecycle
- `handling-approvals.md` — approval gate patterns
- `comments-and-communication.md` — comment conventions

---

## Questions for You

1. **Which skill excites you most?** (release-changelog, pr-report, custom adapter, or something else?)
2. **What's your tolerance for breaking existing sprint-co config?** (Safe to iterate, or need stability?)
3. **Cost concern?** (Trying to reduce spend, or focusing on quality first?)
4. **Timeline:** What's the deadline for next sprint? Can we integrate 1 skill by then?

