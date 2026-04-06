# IronWorks Goal Management System - Comprehensive Research & Plan

**Date:** 2026-04-05
**Status:** Research Complete - Implementation Pending
**Author:** Research compilation for IronWorks productization

---

## Table of Contents

1. [Goal Framework Best Practices](#1-goal-framework-best-practices)
2. [Goal-to-Work Connection Architecture](#2-goal-to-work-connection-architecture)
3. [Timeline & Milestone Management](#3-timeline--milestone-management)
4. [Progress Tracking & Measurement](#4-progress-tracking--measurement)
5. [Goal Health & Risk Assessment](#5-goal-health--risk-assessment)
6. [Motivation & Engagement](#6-motivation--engagement)
7. [UI/UX Recommendations](#7-uiux-recommendations)
8. [Data Model](#8-data-model)
9. [Reporting & Analytics](#9-reporting--analytics)
10. [AI-Specific Considerations](#10-ai-specific-considerations)
11. [Current State Audit](#11-current-state-audit)
12. [Prioritized Implementation Table](#12-prioritized-implementation-table)

---

## 1. Goal Framework Best Practices

### OKR (Objectives and Key Results) - The Foundation

The OKR framework, popularized by Intel and Google, remains the gold standard for goal management in SaaS products. The structure:

- **Objective**: Qualitative, aspirational, directional. "What do we want to achieve?"
- **Key Results** (2-5 per objective): Quantitative, measurable outcomes. "How will we know we achieved it?"

**IronWorks already has this skeleton** via the `goals` + `goal_key_results` tables. What's missing is the operational rigor around it.

### SMART Goals Integration

SMART (Specific, Measurable, Achievable, Relevant, Time-bound) should not be a separate framework but a **validation layer** on goal creation. Each goal should be evaluated against SMART criteria during creation:

- **Specific**: Does the title + description clearly state what will be accomplished?
- **Measurable**: Are there key results with numeric targets?
- **Achievable**: Is the target realistic given team capacity and timeline?
- **Relevant**: Is the goal linked to a parent goal or company objective?
- **Time-bound**: Is there a target date set?

**Recommendation for IronWorks:** Add a "Goal Quality Score" (0-5 stars) that auto-calculates based on SMART criteria completion. Display it as a subtle indicator during goal creation to nudge users toward complete goals.

### Goal Cascading: Alignment over Waterfall

The industry consensus (Lattice, 15Five, Tability, Weekdone) has shifted away from strict top-down cascading toward **directional alignment**:

- **Strict cascading** (company KR becomes team objective) creates rigidity and breaks when any level changes.
- **Alignment** (team goals reference company goals but are independently defined) is more resilient and collaborative.

**IronWorks model:**
```
Company Goal (CEO owns)
  |-- Department Goal (Department Head owns)
  |     |-- Team/Agent Goal (Agent owns)
  |     |-- Team/Agent Goal
  |-- Department Goal
        |-- Team/Agent Goal
```

The existing `parentId` self-referencing FK on `goals` supports this. The `level` enum (`company`, `team`, `agent`, `task`) maps well. What's missing:

1. **Alignment links** (a goal can "support" a parent without being a strict child)
2. **Department grouping** (goals need a `departmentId` or tag concept)
3. **Visibility into how child goals contribute to parent progress**

### How Top SaaS Products Handle Goals

| Product | Structure | Key Differentiator |
|---------|-----------|-------------------|
| **Linear** | Initiatives > Projects > Issues | Progress auto-calculated from issue completion. Initiatives are the "goal" layer. Clean, minimal UI. |
| **Notion** | Database-based OKR trackers | Fully customizable but requires manual setup. No built-in progress automation. |
| **Asana** | Goals > Sub-goals, linked to Projects/Tasks | On Track/At Risk/Off Track status. Auto-progress from sub-goals. Weak at scale. |
| **Monday.com** | Boards with OKR templates | Formula columns for scoring. Dashboard aggregation. Very flexible, less opinionated. |
| **Lattice** | OKRs integrated with performance reviews | Cascading alignment. 1:1 meeting integration. Confidence scoring. Best for people-focused orgs. |
| **15Five** | Company > Department > Individual objectives | Weekly check-ins built in. Research-backed methodology. OKRs tied to performance cycles. |

### What Makes Goal Tracking Actually Useful vs. Checkbox Theater

The research consensus on what separates effective goal systems from theater:

1. **Work connection is automatic.** If progress requires manual updates, it will go stale. Goals must pull progress from actual work (issues completed, KRs updated, deliverables shipped).

2. **Check-ins are lightweight and regular.** Weekly 2-minute confidence updates beat quarterly reviews. 15Five and Lattice prove this.

3. **Goals are visible where work happens.** Showing the parent goal on every issue detail page reminds agents why they're doing the work.

4. **Overdue goals trigger action, not shame.** Auto-escalation to a manager/CEO agent when a goal goes off-track. Alert in Board Briefing.

5. **Fewer goals, better focus.** 3-5 objectives per level. Systems that allow unlimited goals produce checkbox theater.

6. **Stretch goals are separate from commitments.** Google's model: 70% achievement on a stretch goal is success. This needs to be configurable per goal (committed vs. aspirational).

---

## 2. Goal-to-Work Connection Architecture

This is the most critical section for IronWorks. Every feature in the platform should connect back to goals.

### Goals to Issues (Already Partially Built)

**Current state:** Issues have a `goalId` FK. Goal progress auto-calculates from issue completion counts.

**What's missing:**
- **Weighted issues.** Not all issues contribute equally. A "Deploy to production" issue matters more than "Update README". Add optional `weight` (1-5 or story points) to issues, and calculate weighted progress.
- **Issue-to-Key-Result mapping.** An issue should optionally link to a specific Key Result, not just the parent goal. When issue completes, the KR's `currentValue` should auto-increment.
- **Bidirectional visibility.** Issue detail should prominently show which goal it advances. Goal detail should show issue Kanban.

**Recommended schema addition:**
```sql
ALTER TABLE issues ADD COLUMN key_result_id UUID REFERENCES goal_key_results(id);
ALTER TABLE issues ADD COLUMN weight INTEGER DEFAULT 1 CHECK (weight BETWEEN 1 AND 5);
```

### Goals to Routines

**Current state:** Routines have a `goalId` FK.

**What's missing:**
- **Routine contribution tracking.** Each routine execution should log a "contribution event" to the goal. If a routine runs 5x/week and advances a goal, the goal should show "5 routine runs this week contributing to progress."
- **Routine health as goal health signal.** If a routine linked to a goal fails 3 times in a row, the goal should show an "at risk" signal.
- **Routine-to-KR mapping.** Similar to issues, routines should optionally link to a specific Key Result.

### Goals to Playbooks

**Current state:** `playbook_runs` has a `goalId` FK.

**What's missing:**
- **Playbook as milestone.** A playbook run should represent a milestone within a goal. When a playbook completes successfully, it should auto-create or auto-complete a milestone.
- **Playbook step progress.** Each step completion in a playbook run should increment goal progress (not just binary complete/incomplete).
- **Recommended playbooks per goal.** When a user creates a goal, the AI should suggest relevant playbooks that could help achieve it.

### Goals to Deliverables

**Current state:** No direct connection exists.

**Recommended connection:**
- Add `goalId` and `keyResultId` FKs to the deliverables table.
- Deliverables serve as **proof of completion** for Key Results. When a deliverable is marked "approved," the linked KR should auto-update.
- Goal detail page should have a "Deliverables" tab showing all artifacts produced in pursuit of the goal.

### Goals to Channels

**Current state:** No direct connection exists.

**Recommended connection:**
- Add a `goal_channels` junction table linking goals to discussion channels.
- When a goal is created, auto-create or auto-suggest a channel for alignment discussion.
- Channel messages mentioning a goal (via @goal-name or #goal-id) should appear in the goal's activity feed.
- Goal status changes should auto-post to linked channels.

### Goals to Costs

**Current state:** `cost_events` has a `goalId` FK.

**What's missing:**
- **Budget allocation per goal.** Goals should have an optional `budgetCents` field. Total cost_events for a goal should be aggregated and compared against budget.
- **Cost efficiency metrics.** Cost per percentage point of progress. Cost per completed issue under this goal.
- **Budget alerts.** When cost_events for a goal exceed 80% of budget, alert the goal owner and escalate to CFO agent.
- **Board Briefing integration.** Show top-5 goals by spend and their ROI (progress per dollar).

### Goals to Agent Performance

**Current state:** Issues track `assigneeAgentId`. Goal stats service already extracts distinct agents per goal.

**What's missing:**
- **Contribution scoring.** For each goal, calculate each agent's contribution as: `(weighted issues completed by agent) / (total weighted issues)`. Display as percentage.
- **Agent goal portfolio.** Each agent's detail page should show "Goals I'm contributing to" with progress bars.
- **Agent velocity per goal.** Track how fast each agent completes issues under a given goal. Compare against historical average.
- **Agent capacity allocation.** Show what percentage of each agent's work is allocated to which goals (based on issue assignments).

---

## 3. Timeline & Milestone Management

### Core Date Fields (Partially Built)

**Current state:** Goals have `createdAt` and `targetDate`. Issues have `createdAt` and `completedAt`.

**What's missing:**
- **`startDate`**: When work actively began (distinct from creation date). A goal might be created in January for Q2 work starting in April.
- **`actualCompletionDate`**: When the goal was actually achieved (distinct from `updatedAt` when status changed).
- **`cadence`**: quarterly, monthly, annual, custom. Determines the review cycle.

### Milestones Within Goals

Milestones are intermediate checkpoints between goal creation and completion. They are critical for long-running goals.

**Recommended `goal_milestones` table:**
```sql
CREATE TABLE goal_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  description TEXT,
  target_date TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  playbook_run_id UUID REFERENCES playbook_runs(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
```

Milestones should:
- Be ordered sequentially (sort_order)
- Optionally link to a playbook run (completing the playbook = completing the milestone)
- Display as a horizontal stepper/timeline on the goal detail page
- Auto-complete when all linked issues/KRs for that milestone are done

### Timeline Visualization

**Current state:** A basic Gantt view exists on the Goals list page.

**What's missing:**
- **Milestone markers on the Gantt bars.** Small diamond markers at milestone dates.
- **Dependency lines.** If Goal B depends on Goal A, show an arrow.
- **"Today" line with forecast.** The existing today marker is good; add a projected completion date marker.
- **Zoom levels.** Week/Month/Quarter views.
- **Drag-to-reschedule.** Allow dragging goal bars to adjust target dates.

### Deadline Forecasting Based on Velocity

**Current state:** A basic `forecastCompletion` function exists that calculates velocity from issue completion rate.

**Enhancements needed:**
- **Rolling window velocity.** Use last 14 days of velocity, not lifetime average. Recent velocity is more predictive.
- **Confidence intervals.** Instead of a single forecast date, show "Expected: Apr 15, Range: Apr 10-Apr 22" based on velocity variance.
- **Scope change detection.** If new issues keep being added, flag "scope creep" and re-forecast.
- **Comparison to target.** Show "Forecast says Apr 20, target is Apr 15 - 5 days late" prominently.

### Overdue Handling and Escalation

**Current state:** Overdue goals show a red date badge. The risk assessment system classifies goals.

**Enhancements needed:**
- **Graduated escalation:**
  1. **7 days before deadline:** Yellow warning to goal owner agent
  2. **At deadline (not complete):** Orange alert to goal owner + parent goal owner
  3. **7 days past deadline:** Red escalation to CEO agent + Board Briefing flag
  4. **14+ days past deadline:** Critical - auto-post to general channel, add to Board Briefing "Blocked Goals" section
- **Extension requests.** Allow goal owner to request a deadline extension with a reason. Track extension history.
- **Auto-adjust child timelines.** If a parent goal's deadline moves, offer to proportionally adjust child goal deadlines.

---

## 4. Progress Tracking & Measurement

### Automatic Progress Calculation (Partially Built)

**Current state:** Progress = `completedIssues / totalIssues * 100`. The `recalculateGoalProgress` function auto-updates goal status.

**Enhancements needed:**

1. **Multi-source progress aggregation.** Progress should combine:
   - Issue completion (weighted): 60% weight by default
   - Key Result progress: 30% weight by default
   - Milestone completion: 10% weight by default
   - Configurable weights per goal

2. **Rollup progress for parent goals.** A parent goal's progress should aggregate from child goals:
   ```
   parent_progress = avg(child_goal_1_progress, child_goal_2_progress, ...)
   ```
   Or weighted by child goal importance (optional weight field on child goals).

3. **Exclude cancelled items.** Currently, cancelled issues count toward total, deflating progress. The denominator should be `total - cancelled`.

### Manual Progress Updates (Check-ins)

The most critical missing feature. Every effective goal system (Lattice, 15Five, Asana, Quantive) includes regular check-ins.

**Recommended `goal_check_ins` table:**
```sql
CREATE TABLE goal_check_ins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  author_agent_id UUID REFERENCES agents(id),
  -- Progress snapshot at time of check-in
  progress_percent NUMERIC(5,2),
  -- Confidence the goal will be hit (0-100)
  confidence INTEGER CHECK (confidence BETWEEN 0 AND 100),
  -- Status assessment
  status TEXT NOT NULL DEFAULT 'on_track'
    CHECK (status IN ('on_track', 'at_risk', 'off_track', 'achieved', 'cancelled')),
  -- Freeform update
  note TEXT,
  -- What changed since last check-in
  blockers TEXT,
  next_steps TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
```

Check-in cadence: Weekly is ideal (15-30 minutes per the OKR research). For IronWorks, the CEO agent should auto-generate weekly check-ins for company-level goals based on:
- Issue velocity changes
- Blocked issue count
- Cost trajectory
- KR progress delta

### Key Result Types

**Current state:** Key Results have `targetValue`, `currentValue`, and `unit`. This is flexible but untyped.

**Recommended enhancement - add `krType` field:**

| Type | Example | Behavior |
|------|---------|----------|
| `percentage` | "Increase test coverage to 80%" | Progress = currentValue / targetValue |
| `number` | "Ship 5 features" | Progress = currentValue / targetValue |
| `currency` | "Generate $50,000 in revenue" | Progress = currentValue / targetValue, formatted as currency |
| `boolean` | "Launch mobile app" | 0% or 100%, toggle |
| `milestone` | "Complete security audit" | Linked to a milestone, auto-completes |

```sql
ALTER TABLE goal_key_results ADD COLUMN kr_type TEXT NOT NULL DEFAULT 'percentage'
  CHECK (kr_type IN ('percentage', 'number', 'currency', 'boolean', 'milestone'));
ALTER TABLE goal_key_results ADD COLUMN milestone_id UUID REFERENCES goal_milestones(id);
```

### Progress vs. Pace

**Current state:** The `computeGoalHealth` function compares progress% against time%. This is the right approach.

**Enhancement:** Make the pace calculation more visible:
- **Pace indicator on every goal card:** "+12% ahead of schedule" or "-8% behind schedule"
- **Pace trend:** Is the pace gap widening or narrowing? Show an up/down arrow.
- **Pace chart:** On goal detail, show a dual-line chart: progress% vs time% over time.

### Confidence Scoring

The most underrated feature in goal management. Research from OKR Quickstart and Quantive shows:

- Teams describe confidence on a scale of 0-100% (or 1-10)
- Confidence starts at 50% for a new goal (50/50 chance)
- Weekly, the goal owner updates confidence
- Declining confidence is an early warning signal - often 2-3 weeks before a goal actually goes off-track

**Implementation:**
- Add `confidence` field to goals table (0-100, default 50)
- Track confidence history via `goal_check_ins`
- Show confidence as a small gauge/number on goal cards
- Alert when confidence drops below 30% (two consecutive check-ins)

### Burndown/Burnup for Goal Progress

**Current state:** A burndown chart exists on GoalDetail page using SVG. It's functional but basic.

**Enhancements:**
- **Burnup chart option.** Shows scope additions (new issues added) as a separate line. More informative than burndown when scope changes.
- **Cumulative flow diagram.** Stacked area chart showing issues by status over time.
- **Rolling average line.** Smooth out daily noise with a 7-day rolling average.
- **Interactive tooltips.** Hover over any point to see the date, count, and what changed.

---

## 5. Goal Health & Risk Assessment

### Classification System (Partially Built)

**Current state:** Two overlapping systems exist:
1. `GoalHealth` in Goals.tsx: `on_track | at_risk | off_track | no_data` - based on progress vs. time
2. `GoalRiskAssessment` in GoalDetail.tsx: `low | medium | high | critical` - based on blocked issues and overdue count

**Recommendation:** Unify into a single system.

**Unified Health Model:**
```
Health = f(pace, confidence, blockers, activity_recency, scope_change)
```

| Factor | Weight | Calculation |
|--------|--------|-------------|
| Pace (progress vs. time) | 30% | pace_score = 100 if ahead, 50 if even, 0 if >30% behind |
| Confidence (from check-ins) | 25% | Latest confidence score |
| Blockers | 20% | 100 if no blocked issues, 0 if >30% blocked |
| Activity recency | 15% | 100 if updated in last 3 days, 50 if last 7, 0 if >14 days stale |
| Scope stability | 10% | 100 if no new issues in 7 days, 50 if <20% growth, 0 if >20% growth |

**Composite score:**
- 70-100: On Track (green)
- 40-69: At Risk (amber)
- 0-39: Off Track (red)

### Risk Factors and Early Warning Signals

| Signal | Threshold | Action |
|--------|-----------|--------|
| Blocked issues > 20% | Medium risk | Alert goal owner |
| No issue activity in 7+ days | Stale goal | Alert goal owner |
| 3+ consecutive confidence drops | Declining trajectory | Alert parent goal owner |
| Scope increased >25% without deadline extension | Scope creep | Alert CEO agent |
| Velocity declining for 2+ weeks | Slowdown | Suggest resource reallocation |
| Budget >80% consumed with <60% progress | Cost overrun risk | Alert CFO agent |
| All assigned agents have >5 goals | Overallocation | Suggest goal consolidation |

### Auto-Escalation Chain

```
Agent Owner -> Department Head Agent -> CEO Agent -> Board Briefing
```

Escalation triggers:
1. Health score drops below 40 (Off Track)
2. Health score stays below 60 for 2 consecutive weeks
3. Goal is 7+ days past deadline
4. Confidence below 20%

---

## 6. Motivation & Engagement

### Goal Ownership and Accountability

**Current state:** Goals have `ownerAgentId` (single owner).

**Enhancements:**
- **Co-owners.** Some goals are shared responsibilities. Add a `goal_owners` junction table.
- **RACI model.** Responsible (does the work), Accountable (owns the outcome), Consulted, Informed. Map agents to these roles per goal.
- **Accountability visible in Board Briefing.** "3 goals at risk - owners: CTO, CMO, VPofHR"

### Public vs. Private Goals

For a multi-tenant system like IronWorks:
- **Company-wide goals:** Visible to all agents in the company. Default for company-level and team-level goals.
- **Private goals:** Only visible to the goal owner and their manager agent. Useful for self-development goals.
- **Cross-company goals (future):** For client portal, goals shared between the provider and client company.

Add `visibility` field: `company` (default), `team`, `private`.

### Celebrations on Completion

When a goal reaches 100% / "achieved" status:
- Auto-post a celebration message to linked channels
- Show a brief animation/confetti on the goal detail page (configurable, not annoying)
- Add to the CEO agent's weekly summary: "Goals achieved this week: X, Y, Z"
- Track in analytics: "Goals Achieved This Quarter"

### Streak Tracking

Track consecutive periods (weeks/quarters) where goals are met:
- **Agent streak:** "CTO has hit 5 consecutive quarterly goals"
- **Company streak:** "All Q1 goals achieved - 3 quarter streak"
- Display streaks on agent profile and Board Briefing

### Team Alignment Visibility

The "missing link" that Asana research identified: showing how daily work connects to company goals.

**Implementation:**
- On every issue detail page: "This issue advances: [Goal Name] (42% complete)"
- On the Kanban board: Optional overlay showing goal colors on issue cards
- On the sidebar: Show active goals with mini progress bars
- On agent detail: "Currently working on 3 goals" with contribution breakdown

---

## 7. UI/UX Recommendations

### Goal List View (Exists - Enhance)

**Current state:** Filterable, sortable list with search, status filter, sort, and view mode toggle (list/tree/timeline).

**Enhancements:**
- **Group by level.** Collapse sections: Company Goals, Team Goals, Agent Goals.
- **Group by health.** Off Track first (red), then At Risk (amber), then On Track (green).
- **Bulk actions.** Select multiple goals to change status, reassign, or archive.
- **Quick filters as pills.** "My Goals" | "At Risk" | "Due This Week" | "Stale" as clickable pills above the list.
- **Keyboard shortcuts.** `c` to create, `f` to focus search, arrow keys to navigate, enter to open.

### Goal Tree/Cascade View (Exists - Enhance)

**Current state:** Expandable tree with issues nested under goals.

**Enhancements:**
- **Progress rollup visible at every level.** Parent node shows aggregated progress from all children.
- **Drag-and-drop reparenting.** Drag a goal to a new parent to reorganize the hierarchy.
- **Swimlane layout option.** Group by department/team in horizontal lanes, with goals as cards.
- **Color-coded health.** Left border color indicates health status.

### Goal Detail Page Layout (Exists - Enhance)

**Current state:** Good foundation with title, description, risk assessment, burndown, progress bar, and tabs (Issues, Key Results, Sub-Goals, Projects, Activity).

**Recommended layout restructure (two-column on desktop):**

```
+------------------------------------------------------------------+
| [Company] > Goals > [Goal Title]                                  |
+------------------------------------------------------------------+
| LEFT COLUMN (65%)              | RIGHT COLUMN (35%)              |
|                                |                                  |
| [Title - Inline Editable]      | PROPERTIES PANEL                |
| [Description - Rich Text]      | Status: [Active v]              |
|                                | Level: [Company v]              |
| [HEALTH SCORE CARD]            | Owner: [CEO v]                  |
| On Track | 78% confidence      | Start: [Apr 1]                 |
|                                | Target: [Jun 30]                |
| [PROGRESS BAR]                 | Cadence: [Quarterly]            |
| 42% | 8/19 issues | 2 blocked  | Confidence: [78%]               |
|                                | Budget: [$5,000 / $8,000]       |
| [MILESTONES STEPPER]           | Parent Goal: [Company OKR]      |
| [x] Phase 1  [ ] Phase 2      |                                  |
|                                | CONTRIBUTING AGENTS             |
| [TABS]                         | CTO: 45% contribution           |
| Issues | KRs | Sub-Goals |     | Engineer: 35%                   |
| Milestones | Deliverables |    | CMO: 20%                        |
| Activity | Check-ins           |                                  |
|                                | LINKED CHANNELS                 |
| [Tab Content Area]             | #goal-q2-revenue                |
|                                |                                  |
| [BURNDOWN CHART]               | COST SUMMARY                    |
| (below tabs, full width)       | Spent: $3,200 / $8,000          |
+------------------------------------------------------------------+
```

### Timeline/Gantt View (Exists - Enhance)

Already described in Timeline section. Key additions:
- Milestone diamonds
- Dependency arrows
- Zoom controls
- Drag-to-reschedule

### Dashboard Integration (War Room)

**Board Briefing should show:**
- "Goal Health Summary" card: pie chart of on-track/at-risk/off-track goals
- "Goals Needing Attention" card: top 3 off-track goals with health scores
- "Achievements This Week" card: recently completed goals
- "Upcoming Deadlines" card: goals due in next 14 days

**War Room (main dashboard) should show:**
- Goal progress ring chart (overall company goal completion)
- Cascading goal health heatmap
- "Active Goals" sidebar widget

### Where Goals Appear Throughout the App

| Location | What's Shown |
|----------|-------------|
| **Sidebar** | "Goals" nav item with badge count of at-risk goals |
| **Issue Detail** | "Advances goal: [Name]" with mini progress bar |
| **Issue Creation** | Goal selector dropdown (already exists) |
| **Agent Detail** | "Contributing to X goals" with list and progress |
| **Project Detail** | Linked goals with progress |
| **Board Briefing** | Goal health summary, off-track alerts |
| **Channel Header** | "Discussing goal: [Name]" if channel is linked |
| **Routine Detail** | "Supports goal: [Name]" |
| **Playbook Run** | "Running for goal: [Name]" with milestone link |
| **Cost Dashboard** | Spend per goal, budget vs. actual |
| **Activity Feed** | Goal status changes, check-ins, milestone completions |

### Progress Display Conventions

| Context | Display |
|---------|---------|
| **Goal cards (list view)** | Horizontal progress bar + percentage + fraction (8/19) |
| **Goal tree nodes** | Mini bar + percentage |
| **Sidebar badges** | Count of at-risk goals (number) |
| **Dashboard/Board Briefing** | Ring chart or donut for overall completion |
| **Issue detail** | Small inline bar with goal name |
| **Agent detail** | Stacked bars per goal |

### Color Coding

Consistent across the entire app:

| Status | Color | Usage |
|--------|-------|-------|
| On Track | `emerald-500` | Health badges, progress bars at >70% |
| At Risk | `amber-500` | Health badges, progress bars at 30-70% |
| Off Track | `red-500` | Health badges, progress bars at <30%, overdue dates |
| Achieved | `emerald-600` with check icon | Status badge |
| No Data | `muted` | When no issues or KRs are linked |

(Current codebase already uses this palette - maintain consistency.)

### Empty States and Onboarding

**First goal creation:** A guided flow:
1. "What's your company's top objective this quarter?" (creates company-level goal)
2. "Break it down: what measurable results would show success?" (creates KRs)
3. "Which agents should work on this?" (creates agent-level sub-goals)
4. "Ready to generate tasks?" (triggers AI goal breakdown to create issues)

**Empty goal detail:** "This goal has no linked work yet. Create issues, run a playbook, or set up a routine to start making progress."

**Empty goal list:** The existing empty state is good. Add a link to a "Goal Setting Guide" in the Knowledge Base.

---

## 8. Data Model

### Current Schema Summary

```
goals
  id, companyId, title, description, level, status, parentId, ownerAgentId, targetDate, createdAt, updatedAt

goal_key_results
  id, goalId, companyId, description, targetValue, currentValue, unit, createdAt, updatedAt

project_goals
  projectId, goalId, companyId, createdAt, updatedAt
```

### Recommended Schema Additions

#### 8.1 Enhanced Goals Table

```sql
-- New columns on existing goals table
ALTER TABLE goals ADD COLUMN start_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE goals ADD COLUMN actual_completion_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE goals ADD COLUMN cadence TEXT DEFAULT 'quarterly'
  CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'annual', 'custom'));
ALTER TABLE goals ADD COLUMN confidence INTEGER DEFAULT 50
  CHECK (confidence BETWEEN 0 AND 100);
ALTER TABLE goals ADD COLUMN budget_cents BIGINT;
ALTER TABLE goals ADD COLUMN visibility TEXT DEFAULT 'company'
  CHECK (visibility IN ('company', 'team', 'private'));
ALTER TABLE goals ADD COLUMN goal_type TEXT DEFAULT 'committed'
  CHECK (goal_type IN ('committed', 'aspirational'));
ALTER TABLE goals ADD COLUMN department TEXT; -- e.g., 'engineering', 'marketing'
ALTER TABLE goals ADD COLUMN health_score INTEGER; -- cached composite score 0-100
ALTER TABLE goals ADD COLUMN health_status TEXT
  CHECK (health_status IN ('on_track', 'at_risk', 'off_track', 'no_data'));
```

#### 8.2 Enhanced Key Results Table

```sql
ALTER TABLE goal_key_results ADD COLUMN kr_type TEXT DEFAULT 'percentage'
  CHECK (kr_type IN ('percentage', 'number', 'currency', 'boolean', 'milestone'));
ALTER TABLE goal_key_results ADD COLUMN milestone_id UUID REFERENCES goal_milestones(id);
ALTER TABLE goal_key_results ADD COLUMN sort_order INTEGER DEFAULT 0;
ALTER TABLE goal_key_results ADD COLUMN weight NUMERIC(3,2) DEFAULT 1.0;
```

#### 8.3 Goal Milestones (New)

```sql
CREATE TABLE goal_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  description TEXT,
  target_date TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  playbook_run_id UUID REFERENCES playbook_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX goal_milestones_goal_idx ON goal_milestones(goal_id);
```

#### 8.4 Goal Check-ins (New)

```sql
CREATE TABLE goal_check_ins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  author_agent_id UUID REFERENCES agents(id),
  progress_percent NUMERIC(5,2),
  confidence INTEGER CHECK (confidence BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'on_track'
    CHECK (status IN ('on_track', 'at_risk', 'off_track', 'achieved', 'cancelled')),
  note TEXT,
  blockers TEXT,
  next_steps TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX goal_check_ins_goal_idx ON goal_check_ins(goal_id);
CREATE INDEX goal_check_ins_created_idx ON goal_check_ins(created_at);
```

#### 8.5 Goal Channels (New Junction)

```sql
CREATE TABLE goal_channels (
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (goal_id, channel_id)
);
```

#### 8.6 Goal Owners (New Junction for Co-ownership)

```sql
CREATE TABLE goal_owners (
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'responsible'
    CHECK (role IN ('responsible', 'accountable', 'consulted', 'informed')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (goal_id, agent_id)
);
```

#### 8.7 Enhanced Issues Table

```sql
ALTER TABLE issues ADD COLUMN key_result_id UUID REFERENCES goal_key_results(id) ON DELETE SET NULL;
ALTER TABLE issues ADD COLUMN weight INTEGER DEFAULT 1 CHECK (weight BETWEEN 1 AND 5);
```

#### 8.8 Goal Snapshots (Historical Tracking)

```sql
CREATE TABLE goal_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  snapshot_date DATE NOT NULL,
  progress_percent NUMERIC(5,2),
  health_score INTEGER,
  confidence INTEGER,
  total_issues INTEGER,
  completed_issues INTEGER,
  blocked_issues INTEGER,
  budget_spent_cents BIGINT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX goal_snapshots_goal_date_idx ON goal_snapshots(goal_id, snapshot_date);
```

A nightly routine should snapshot every active goal. This enables:
- Historical trend lines
- Week-over-week comparison
- "This goal was 30% complete a month ago, now it's 45%"

### Entity Relationship Diagram (Text)

```
                    [companies]
                        |
         +--------------+----------------+
         |              |                |
      [goals]      [agents]        [channels]
         |              |                |
    +----+----+    +----+----+     +----+
    |    |    |    |         |     |
  [goal_ |  [goal_ |   [goal_  [goal_
   key_  |   check_ |    owners] channels]
   results] ins]    |
    |         [issues]---[goal_key_results]
    |              |
  [goal_      [cost_events]
   milestones]     |
    |          [playbook_runs]
  [goal_
   snapshots]
```

---

## 9. Reporting & Analytics

### Goal Completion Rate by Period

**Query:** For each quarter, what percentage of goals were achieved?

```
completion_rate = (goals_achieved / total_goals_due_in_period) * 100
```

Display as a bar chart on the analytics dashboard. Compare quarter-over-quarter.

### Average Time to Complete

**Query:** From start_date to actual_completion_date, how long do goals take?

Segment by:
- Goal level (company vs. team vs. agent)
- Department
- Goal type (committed vs. aspirational)

### Most Common Blockers

Aggregate from `goal_check_ins.blockers` field using text analysis. The CEO agent should synthesize common themes:
- "Resource constraints" (appears in 40% of check-ins)
- "Unclear requirements" (25%)
- "External dependencies" (20%)

### Department-Level Goal Health

**Dashboard view:**
| Department | Active Goals | On Track | At Risk | Off Track | Avg Confidence |
|-----------|-------------|---------|---------|----------|---------------|
| Engineering | 5 | 3 | 1 | 1 | 65% |
| Marketing | 3 | 2 | 1 | 0 | 72% |
| Operations | 4 | 4 | 0 | 0 | 85% |

### Historical Trends

Using `goal_snapshots`:
- Company-wide health score trend line (weekly snapshots)
- Individual goal progress curves
- Confidence trajectory charts
- Budget burn rate vs. progress

### Reports for Board Briefing

1. **Quarterly OKR Review:** All company-level goals with status, progress, confidence, and key learnings from check-ins.
2. **Goal Velocity Report:** Which goals are ahead/behind pace, by how much.
3. **Agent Contribution Report:** Which agents contributed most to goal completion.
4. **Cost Efficiency Report:** Cost per completed goal, cost per percentage point of progress.

---

## 10. AI-Specific Considerations

This is what makes IronWorks fundamentally different from Asana or Lattice. Goals are not just tracked - they are **autonomously pursued** by AI agents.

### How AI Agents Should Interact with Goals

1. **Goal awareness in every agent prompt.** When an agent receives a task (issue), the prompt should include context about the parent goal:
   ```
   "You are working on issue [TITLE]. This advances the goal [GOAL_TITLE]
   which is currently 42% complete with a target date of [DATE].
   The goal is currently [AT_RISK] because [REASON]."
   ```

2. **Autonomous prioritization.** Agents should prioritize issues based on goal health:
   - Issues under off-track goals get higher priority
   - Issues under on-track goals with high confidence can be deprioritized

3. **Self-initiated work.** When an agent has no assigned issues but owns a goal that's behind schedule, it should:
   - Analyze what's blocking progress
   - Create new issues for unaddressed work
   - Propose routine changes to accelerate the goal

4. **Progress reporting.** Agents should auto-generate check-in updates for goals they own, summarizing:
   - What they accomplished this week
   - What's blocked
   - Revised confidence assessment
   - Recommended next steps

### Agent-Assigned Goals vs. Human-Assigned Goals

| Type | Source | Behavior |
|------|--------|----------|
| **Human-assigned** | Created by user in UI | Agent executes but cannot modify goal parameters |
| **AI-generated** | CEO agent creates based on company strategy | Can be auto-adjusted by the owning agent with audit trail |
| **Self-development** | Agent identifies own improvement area | Private visibility, lower priority |

### CEO Agent Goal Monitoring

The CEO agent has a special role in the goal system:

1. **Weekly company goal review.** Every Monday (CT), the CEO agent should:
   - Review all company-level goals
   - Generate check-in updates
   - Identify goals needing intervention
   - Post summary to Board Briefing

2. **Goal creation from strategy.** When company strategy changes, the CEO agent should propose new goals or adjust existing ones.

3. **Escalation handler.** When goals escalate to CEO level, the CEO agent should:
   - Assess the situation
   - Communicate with the owning agent
   - Propose remediation (resource reallocation, scope reduction, deadline extension)
   - Post decision to relevant channel

4. **Quarterly OKR cycle management.** At quarter boundaries:
   - Close out previous quarter's goals (mark achieved/cancelled)
   - Draft next quarter's company-level goals
   - Trigger goal cascading to departments

### Department Head Goal Cascading

When a company-level goal is created/updated:
1. CEO agent notifies department head agents
2. Each department head proposes aligned department-level goals
3. Department heads create agent-level goals for their reports
4. The AI breakdown endpoint generates initial issues from each goal

This creates a fully automated OKR cascade: human sets company vision, AI agents do the rest.

### Automated Goal Suggestions

Based on company activity, the CEO agent should suggest goals:

| Signal | Suggested Goal |
|--------|---------------|
| High error rate in deployments | "Reduce deployment failures by 50%" |
| Customer support volume increasing | "Reduce support tickets by 30% through better docs" |
| Budget approaching limit | "Reduce operational costs by 15%" |
| No marketing content in 30 days | "Publish 4 blog posts this quarter" |
| Agent uptime below 95% | "Achieve 99% agent uptime" |

These suggestions appear in Board Briefing as "Recommended Goals" cards.

---

## 11. Current State Audit

### What Exists and Works Well

| Feature | Status | Quality |
|---------|--------|---------|
| Goal CRUD (create, read, update, delete) | Complete | Good |
| Goal hierarchy (parentId) | Complete | Good |
| Goal levels (company/team/agent/task) | Complete | Good |
| Goal statuses (planned/active/achieved/cancelled) | Complete | Good |
| Key Results (CRUD, progress tracking) | Complete | Good |
| Issue-to-Goal linking | Complete | Good |
| Progress calculation from issues | Complete | Good |
| Goal health scoring (pace-based) | Complete | Needs unification |
| Risk assessment (blocked/overdue) | Complete | Needs unification with health |
| Burndown chart | Complete | Basic but functional |
| Gantt/Timeline view | Complete | Basic, needs zoom/milestones |
| Tree view with issue nesting | Complete | Good |
| Goal list with filter/sort/search | Complete | Good |
| AI goal breakdown (issue generation) | Complete | Good |
| Target date with overdue indicators | Complete | Good |
| Goal badges on issues | Complete | Good |
| GoalDetail issues tab | Complete | Good |
| Goal progress batch API | Complete | Good |
| Forecast completion | Complete | Needs rolling window |
| Goal cloning | Complete | Good |
| Two-pane layout on GoalDetail | Complete | Good |
| Project-to-goal linking | Complete | Good |
| Cost events with goalId | Complete | Needs budget comparison |
| Routine-to-goal linking | Complete | Needs contribution tracking |
| Playbook run goalId | Complete | Needs milestone linking |

### What's Missing (Prioritized)

| Feature | Priority | Effort | Impact |
|---------|----------|--------|--------|
| Goal check-ins (manual updates) | **P0** | Medium | Critical for weekly rhythm |
| Confidence scoring | **P0** | Small | Early warning system |
| Goal milestones | **P1** | Medium | Structure for long goals |
| Unified health scoring | **P1** | Small | Remove dual system confusion |
| Multi-source progress aggregation | **P1** | Medium | More accurate progress |
| Goal snapshots (historical) | **P1** | Medium | Enables all analytics |
| Goal-channel linking | **P2** | Small | Alignment discussions |
| Budget tracking per goal | **P2** | Medium | Cost governance |
| KR types (boolean, currency, etc.) | **P2** | Small | Better KR modeling |
| Board Briefing integration | **P2** | Medium | Executive visibility |
| Agent contribution scoring | **P2** | Medium | Accountability |
| Deliverable-to-goal linking | **P2** | Small | Proof of completion |
| Issue-to-KR linking | **P2** | Small | Granular progress |
| Goal-aware agent prompts | **P3** | Medium | Autonomous pursuit |
| Automated CEO check-ins | **P3** | Large | Full automation |
| Goal suggestion engine | **P3** | Large | Proactive planning |
| Drag-to-reschedule on Gantt | **P3** | Medium | UX polish |
| Quarterly OKR cycle management | **P3** | Large | Full OKR lifecycle |
| Co-ownership (RACI) | **P3** | Small | Multi-agent goals |
| Goal quality score (SMART) | **P3** | Small | Better goal creation |
| Celebrations/streaks | **P4** | Small | Engagement |
| Public/private visibility | **P4** | Small | Privacy |
| Extension requests | **P4** | Small | Process management |

---

## 12. Prioritized Implementation Table

### Wave 1: Foundation (1-2 sprints)

These are the highest-impact additions that build on what already exists.

| # | Feature | Schema Change | API Change | UI Change | Estimate |
|---|---------|--------------|------------|-----------|----------|
| 1 | Confidence field on goals | ALTER TABLE goals | PATCH /goals/:id | Gauge on goal cards, slider on detail | 2h |
| 2 | Unified health scoring | ALTER TABLE goals (health_score, health_status) | Background recalc job | Replace dual system in Goals.tsx/GoalDetail.tsx | 4h |
| 3 | Goal check-ins table + API | CREATE TABLE goal_check_ins | POST/GET /goals/:id/check-ins | New "Check-ins" tab on GoalDetail | 6h |
| 4 | start_date + cadence fields | ALTER TABLE goals | PATCH /goals/:id | DatePicker + Select in GoalProperties | 2h |
| 5 | Goal snapshots + nightly job | CREATE TABLE goal_snapshots | GET /goals/:id/snapshots | Historical trend line on GoalDetail | 6h |

### Wave 2: Connections (2-3 sprints)

Deepen the connections between goals and other features.

| # | Feature | Schema Change | API Change | UI Change | Estimate |
|---|---------|--------------|------------|-----------|----------|
| 6 | Goal milestones | CREATE TABLE goal_milestones | CRUD /goals/:id/milestones | Milestone stepper on GoalDetail | 8h |
| 7 | KR types (boolean, currency, milestone) | ALTER TABLE goal_key_results | PATCH key result type handling | Type selector in KR form | 4h |
| 8 | Issue-to-KR linking | ALTER TABLE issues | Include in issue CRUD | KR selector on issue create/edit | 4h |
| 9 | Issue weighting | ALTER TABLE issues | Include in issue CRUD | Weight selector on issue create/edit | 3h |
| 10 | Goal-channel linking | CREATE TABLE goal_channels | CRUD /goals/:id/channels | Channel linking UI on GoalDetail | 4h |
| 11 | Budget field + cost aggregation | ALTER TABLE goals | GET /goals/:id/costs | Budget bar on GoalDetail + properties | 6h |
| 12 | Board Briefing integration | None | Goal health summary endpoint | New cards in Board Briefing | 6h |

### Wave 3: Intelligence (3-4 sprints)

AI-powered features that make IronWorks unique.

| # | Feature | Schema Change | API Change | UI Change | Estimate |
|---|---------|--------------|------------|-----------|----------|
| 13 | Agent contribution scoring | None (computed) | GET /goals/:id/contributions | Contribution breakdown on GoalDetail | 6h |
| 14 | Goal-aware agent prompts | None | Modify agent task context | None (backend only) | 8h |
| 15 | CEO auto check-ins | None | Routine/cron job | Auto-generated check-ins appear in tab | 10h |
| 16 | Goal suggestion engine | None | POST /companies/:id/ai/suggest-goals | Suggestion cards in Board Briefing | 12h |
| 17 | Automated escalation chain | None | Background job | Notification UI + channel posts | 8h |
| 18 | Quarterly OKR cycle | None | POST /companies/:id/goals/new-cycle | Guided flow UI | 12h |

### Wave 4: Polish (Ongoing)

| # | Feature | Estimate |
|---|---------|----------|
| 19 | Drag-to-reschedule on Gantt | 6h |
| 20 | Interactive burnup chart | 4h |
| 21 | Goal quality score (SMART) | 3h |
| 22 | Celebrations + streaks | 4h |
| 23 | Co-ownership (RACI) | 4h |
| 24 | Extension requests | 3h |
| 25 | Public/private visibility | 2h |
| 26 | Keyboard shortcuts | 3h |

---

## Sources

- [Linear Initiatives Documentation](https://linear.app/docs/initiatives)
- [Linear Continuous Planning](https://linear.app/now/continuous-planning-in-linear)
- [Asana OKR Guide](https://asana.com/resources/setting-okrs)
- [Asana Goals Features](https://asana.com/features/goals-reporting/goals)
- [Asana Weighted Goals](https://forum.asana.com/t/track-progress-towards-your-okrs-with-weighted-goals/796968)
- [Lattice OKR Software](https://lattice.com/platform/goals/okrs)
- [Lattice Better Goals Product](https://lattice.com/blog/a-better-goals-product-built-for-you-and-with-you)
- [15Five OKR Methodology](https://success.15five.com/hc/en-us/articles/360002682112-OKR-Methodology-How-to-Set-and-Track-Objectives-and-Key-Results-in-15Five)
- [15Five OKR Tool Features](https://www.15five.com/blog/5-must-have-features-to-look-for-in-an-okr-tool)
- [Monday.com OKR Management](https://support.monday.com/hc/en-us/articles/4402057681298-OKR-management-using-monday-com)
- [OKR Check-in Best Practices](https://okrquickstart.com/post/okr-tracking)
- [OKR Confidence Scoring](https://okrquickstart.com/okrtemplates/okr-confidence-scoring)
- [Quantive OKR Tracking](https://quantive.com/resources/articles/okr-tracking)
- [Cascading vs. Aligning OKRs](https://www.tability.io/okrs/cascading-vs-aligning-okrs)
- [Weekdone Hierarchical OKRs](https://blog.weekdone.com/how-to-set-and-align-team-goals-use-hierarchical-okrs/)
- [OKR Scoring Methods](https://mooncamp.com/blog/okr-scoring)
- [Goal-Driven Autonomous Agents](https://medium.com/@angadi.saa/goal-driven-autonomous-agents-the-ai-that-works-while-you-sleep-2c8212c5a695)
- [IBM Goal-Based Agents](https://www.ibm.com/think/topics/goal-based-agent)
- [Dust Goal-Based Agents](https://dust.tt/blog/goal-based-agent)
- [OKR Data Modeling](https://www.datensen.com/blog/data-modeling/data-modeling-objectives-key-results/)
