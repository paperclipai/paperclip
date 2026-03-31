# Paperclip Skills & Configuration Exploration Plan

**Date:** 2026-03-31  
**Goal:** Survey online Paperclip skills, configurations, and patterns, then integrate promising ones into sprint-co setup

---

## Part 1: Available Paperclip Skills to Explore

### Official Skills in Paperclip Repo (`.agents/skills/`)

Source: https://github.com/paperclipai/paperclip/tree/master/.agents/skills

#### 1. **company-creator** 
- **Purpose:** Scaffold new company packages from templates
- **Relevance:** High — can streamline creation of new agent companies
- **Sprint-co Integration:** Use to rapidly iterate on company variants (e.g., test team configs)
- **Experiment:** Create a variant company for A/B testing agent structures

#### 2. **create-agent-adapter**
- **Purpose:** Generate custom agent adapters (for Hermes, LLaMA, or other models)
- **Relevance:** Very High — sprint-co could test other models via adapters
- **Sprint-co Integration:** Build adapters for local models (ollama, vLLM) to reduce OpenAI cost
- **Experiment:** Create LLaMA-7B adapter using this skill, test quality on planning phase

#### 3. **doc-maintenance**
- **Purpose:** Auto-update documentation (README, CHANGELOG, AGENTS.md)
- **Relevance:** Medium-High — keep agent skills and company configs in sync
- **Sprint-co Integration:** Auto-generate AGENTS.md from live agent definitions
- **Experiment:** Let doc-maintenance auto-update sprint-co docs after each sprint

#### 4. **pr-report**
- **Purpose:** Generate pull request summaries and change analysis
- **Relevance:** Very High — QA Engineer could use this to auto-grade code changes
- **Sprint-co Integration:** Enhance QA eval loop with AI-powered diff analysis
- **Experiment:** Hook pr-report into QA eval to provide detailed change impact reports

#### 5. **release-changelog**
- **Purpose:** Generate CHANGELOG.md from commit history and issue links
- **Relevance:** High — Delivery Engineer needs this for release notes
- **Sprint-co Integration:** Auto-generate release notes at end of sprint
- **Experiment:** Use to produce human-readable sprint delivery reports

#### 6. **release**
- **Purpose:** Full release workflow (tagging, notes, deployment)
- **Relevance:** Very High — core to Delivery Engineer's workflow
- **Sprint-co Integration:** Replace manual release steps with orchestrated skill
- **Experiment:** Let release skill handle full 3-hour sprint deployment pipeline

---

## Part 2: Paperclip Core Concepts to Leverage

### Heartbeat Protocol
**Status:** Your sprint-co already implements this via `sprint-orchestrator`

**Enhancements to test:**
- Adjust heartbeat cadence (currently 15 min during sprint)
- Test variable cadence: aggressive during build phase, relaxed during eval
- Implement mid-sprint context resets for token budget

### Cost Control & Budgeting
**Status:** Not yet implemented in sprint-co

**Experiments:**
- Set per-agent monthly budgets
- Route expensive work (architecture decisions) to Haiku first, escalate if blocked
- Implement cost tracking dashboard within Paperclip

### Approval Workflows
**Status:** Not yet documented in sprint-co

**Experiments:**
- Require board-level approval for deploy-ready sprints
- Add PR review approval gate before Delivery Engineer deploys
- Implement auto-approval for under-$X cost sprints

### Goal Tracing
**Status:** Partially implemented (sprint-co has goals, not linked to Paperclip)

**Experiments:**
- Create formal Paperclip `GOAL.md` for sprint-co mission
- Link all agent work back to sprint goals
- Track cumulative impact across sprints

---

## Part 3: Online Configuration Examples to Inspect

### Hermes Adapter (NousResearch)
**Source:** https://github.com/NousResearch/hermes-paperclip-adapter

**Inspect for:**
- How to build custom adapters
- Model-specific prompt engineering
- Cost optimization patterns

**Experiment:** Create similar adapter for local LLaMA or Claude.ai models

### Paperclip Company Templates
**Source:** Paperclip ships with 16 pre-built templates (referenced in main docs)

**Templates to research:**
- "Startup Studio" — multi-project rapid delivery
- "SaaS Ops" — ongoing maintenance + features
- "Research Lab" — hypothesis-driven evaluation
- "Content Factory" — bulk generation + curation

**Experiment:** Adapt "Startup Studio" template for sprint-co, compare outcomes

---

## Part 4: Suggested Integration Roadmap

### Phase 1: Quick Wins (This Week)

**Experiment 1: Auto-Generated Release Notes**
- Use `release-changelog` skill to auto-generate sprint report
- Hook into Delivery Engineer's post-deploy workflow
- Goal: 5-min time savings per sprint report

**Experiment 2: PR-Report Enhancement**
- Integrate `pr-report` skill into QA Engineer's eval loop
- Use AI analysis to flag risky changes
- Goal: Catch architectural issues earlier

**Steps:**
1. Clone Paperclip repo locally
2. Study `release-changelog` and `pr-report` SKILL.md files
3. Add skill invocation to sprint-delivery and sprint-evaluator skills
4. Test on next sprint

---

### Phase 2: Medium-Complexity (Next 2 Weeks)

**Experiment 3: Custom LLM Adapter**
- Use `create-agent-adapter` to build LLaMA/local model adapter
- Run beta agents on local models (cheaper eval loop)
- Goal: 50% cost reduction for evaluation phase

**Experiment 4: Doc Auto-Sync**
- Let `doc-maintenance` keep agent definitions in sync
- Auto-update AGENTS.md when agent configs change
- Goal: No stale documentation, always deployable

**Steps:**
1. Study `create-agent-adapter` skill implementation
2. Identify cheapest model for QA/eval role
3. Build adapter, test on eval phase only
4. Measure cost + quality tradeoff

---

### Phase 3: Deep Integration (Next Month)

**Experiment 5: Cost-Driven Agent Routing**
- Implement budget caps per agent role
- Automatically route work based on cost/quality profile
- Goal: Stay under sprint budget while maintaining quality

**Experiment 6: Approval Workflows**
- Add board-level approval for high-value sprints
- Implement PR review approval before deployment
- Goal: Governance + confidence in delivered code

**Experiment 7: Full Skill Orchestration**
- Chain all 6 Paperclip skills into sprint workflow
- Replace manual steps with skill calls
- Goal: Fully automated, repeatable sprint pipeline

**Steps:**
1. Design cost routing matrix (model ↔ task type)
2. Implement in sprint-orchestrator
3. Add approval endpoints to sprint-protocol
4. Create skill call wrappers for each phase

---

## Part 5: Concrete Experiments to Start NOW

### Experiment A: Evaluate Paperclip's doc-maintenance Skill

**Goal:** Understand how doc auto-sync works, then decide if we adopt it.

**Steps:**
```bash
# 1. Go to Paperclip repo
cd /tmp
git clone https://github.com/paperclipai/paperclip.git
cd paperclip

# 2. Read the doc-maintenance skill
cat .agents/skills/doc-maintenance/SKILL.md

# 3. Read the release-changelog skill
cat .agents/skills/release-changelog/SKILL.md

# 4. Understand skill invocation from skill.md or Paperclip code
grep -r "doc-maintenance\|release-changelog" . | head -20
```

**Outcome:** Document findings in `sprint-co-research/doc-maintenance-analysis.md`

---

### Experiment B: Map Paperclip API to Sprint-Co Workflow

**Goal:** Identify which Paperclip API endpoints sprint-co agents could use.

**Status Codes to Map:**
- Heartbeat protocol → Sprint Orchestrator's 15-min wake
- Issue checkout → Engineer Alpha/Beta task assignment
- Comment mentions → QA eval updates
- Approval flows → Deployment gates

**Implementation:**
1. Read `/docs/sprint-co-research/paperclip-docs/paperclip-skill.md`
2. Create matrix: sprint-co agent ↔ Paperclip API calls
3. Implement 2-3 key API calls in next sprint test

**Document:** `docs/sprint-co-config/paperclip-api-integration.md`

---

### Experiment C: Create Variant Agent Company via company-creator

**Goal:** Test rapid company iteration using company-creator skill.

**Steps:**
1. Use `company-creator` to scaffold a "sprint-co-lite" variant
2. Include only 4 agents (less overhead):
   - Sprint Planner (combined planning + architecture)
   - Engineer (combined alpha + beta)
   - QA (evaluator only)
   - Delivery
3. Run side-by-side sprint with original sprint-co
4. Compare velocity, cost, quality

**Metrics to Track:**
- Time-to-deploy
- Cost per sprint
- Eval pass rate
- Handoff artifact quality

**Document:** `docs/sprint-co-research/agent-variant-experiment.md`

---

### Experiment D: Cost Optimization via Adapter Routing

**Goal:** Test Haiku-first + escalation strategy with alternative adapters.

**Current Setup:** All agents use Haiku by default

**Proposed Variant:**
- Phase 1 (Planning): Haiku for Product Planner + Sprint Lead
- Phase 2 (Implementation): Haiku for engineers
- Phase 3 (Eval): **Try local LLaMA-7B first via custom adapter**, escalate to Haiku if confidence <0.6
- Phase 4 (Deploy): Haiku (deterministic, less risky)

**Implementation:**
1. Create LLaMA adapter using `create-agent-adapter` skill
2. Benchmark LLaMA vs Haiku on eval rubric
3. Configure adapter routing in sprint-co COMPANY.md
4. Run experiment on 2–3 sprints

**Document:** `docs/sprint-co-research/cost-routing-experiment.md`

---

## Part 6: Paperclip Features to Monitor

### Upcoming / Research
- Multi-company budgeting (cost pooling across companies)
- Agent marketplace (sharing specialized agents across companies)
- Workflow DAGs (vs. linear heartbeat)
- Real-time agent dashboards

### Keep Eyes On
- Paperclip Discord for tips
- GitHub releases for new skills
- Docs site (https://docs.paperclip.ing) for API updates

---

## Part 7: Success Criteria for Experiments

After running each experiment, ask:

1. **Time Saved:** Did this save >5% per sprint cycle?
2. **Cost Reduced:** Did this reduce agent cost by >10%?
3. **Quality Maintained:** Did QA pass rate stay ≥95%?
4. **Maintainability:** Can we document and repeat this easily?
5. **Risk:** Did we introduce new failure modes?

If 3+ criteria pass → **Keep and iterate**  
If <3 criteria pass → **Document learnings and shelve**

---

## Timeline

```
Week 1 (Now)
├─ Exp A: Read doc-maintenance, release-changelog, analyze
├─ Exp B: Map Paperclip API to sprint-co workflow
└─ Exp D: Benchmark LLaMA for eval role

Week 2–3
├─ Exp C: Create sprint-co-lite variant via company-creator
├─ Hook release-changelog into sprint-delivery skill
└─ Hook pr-report into sprint-evaluator skill

Week 4+
├─ Deploy Haiku-first + escalation strategy
├─ Activate cost tracking dashboard
└─ Run approval workflow gate on next high-value sprint
```

---

## Resources

**Official:**
- Paperclip Docs: https://docs.paperclip.ing
- GitHub: https://github.com/paperclipai/paperclip
- Discord: https://discord.gg/m4HZY7xNG3

**Adapters & Examples:**
- Hermes Adapter: https://github.com/NousResearch/hermes-paperclip-adapter

**Your Local Docs:**
- Company Spec: `docs/sprint-co-research/paperclip-docs/companies-spec.md`
- Skill Spec: `docs/sprint-co-research/paperclip-docs/paperclip-skill.md`
- Heartbeat Protocol: `docs/sprint-co-research/paperclip-docs/heartbeat-protocol.md`

---

## Decisions Needed (Ask Jeremy)

1. **Priority:** Which experiment should we tackle first? (Recommend: Exp A → B → D)
2. **Risk tolerance:** Can we do side-by-side variants (Exp C) or must we iterate linearly?
3. **Cost budget:** What's the tolerance for experimenting with models/adapters?
4. **Timeline:** How many weeks before we expect to stabilize on a configuration?

