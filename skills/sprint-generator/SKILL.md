---
schema: agentcompanies/v1
kind: skill
name: sprint-generator
description: >
  Skill for Engineer Alpha and Engineer Beta. Covers one-feature-at-a-time protocol,
  self-evaluation checklist, refine-vs-pivot decision framework, and handoff artifact format.
---

# Sprint Generator Skill

## Overview

Engineer Alpha and Beta are the generators in Sprint Co's GAN-inspired architecture. This skill covers how to implement features efficiently, evaluate your own work honestly, and respond strategically to QA feedback.

---

## 1. One-Feature-at-a-Time Protocol

### The Core Rule
**Never start a new feature while the current one is incomplete.** A half-built feature fails QA and wastes evaluation cycles. Two completed features are infinitely better than three half-built ones.

### Feature Lifecycle
```
Pick task from task-breakdown.md
    ↓
Plan your approach (2–3 sentences)
    ↓
Implement
    ↓
Run locally — verify it works
    ↓
Self-evaluate (checklist)
    ↓
Fix critical issues (max 10 min)
    ↓
Write handoff artifact
    ↓
Signal QA
    ↓
Start next task (or respond to QA feedback)
```

### Picking Your Next Task
1. Read `task-breakdown.md`
2. Find the first incomplete V1 task assigned to you
3. Check if its dependencies are done
4. If blocked by a dependency, message Sprint Lead — don't wait silently

### Planning Before Coding
Before writing a single line, answer in 2–3 sentences:
- What am I building? (specific)
- How will I build it? (approach)
- How will I know it's done? (acceptance criteria)

This 2-minute exercise prevents "I built the wrong thing" failures.

---

## 2. Implementation Standards

### TypeScript
```typescript
// ❌ Bad — hides errors
const data: any = await fetchSomething()

// ✅ Good — explicit contract
interface TaskData {
  id: string
  title: string
  status: 'pending' | 'complete'
}
const data: TaskData = await fetchSomething()
```

### Error Handling
```typescript
// ❌ Bad — silent failure
try {
  await saveData(payload)
} catch (e) {
  console.error(e) // user sees nothing
}

// ✅ Good — user gets feedback
try {
  await saveData(payload)
  setStatus('saved')
} catch (e) {
  setError('Failed to save. Please try again.')
  console.error('[saveData]', e)
}
```

### Loading States
```typescript
// Every async operation needs a loading state
const [isLoading, setIsLoading] = useState(false)

const handleSubmit = async () => {
  setIsLoading(true)
  try {
    await doThing()
  } finally {
    setIsLoading(false)
  }
}
```

### Empty States
Every list/grid/table must handle zero items:
```tsx
{items.length === 0 ? (
  <EmptyState 
    message="No tasks yet" 
    action="Create your first task"
    onAction={() => setShowCreate(true)}
  />
) : (
  <TaskList items={items} />
)}
```

---

## 3. Self-Evaluation Checklist

Run this **before every handoff**. Be honest — QA will find what you hide.

### Functionality
```
[ ] The feature does exactly what the acceptance criteria say
[ ] The complete user flow works end-to-end (UI → API → DB → UI)
[ ] The happy path works without errors
[ ] Error cases are handled (what happens when things go wrong?)
[ ] Empty state is handled (what does the user see with no data?)
[ ] Loading state is handled (what does the user see while waiting?)
```

### Product Depth
```
[ ] Feature is at least at the level described in the task acceptance criteria
[ ] Edge cases are handled (loading errors, validation failures, race conditions)
[ ] API boundaries are clean (no leaking internal state)
[ ] User feedback is clear (errors, success states, what's happening)
```

### Visual Design
```
[ ] Renders correctly at 1280px wide (standard desktop)
[ ] Renders correctly at 768px wide (tablet minimum)
[ ] No text overflow or layout breaks
[ ] Interactive elements look interactive (cursor, hover state)
[ ] Color contrast is readable
```

### Code Quality
```
[ ] No unhandled Promise rejections
[ ] No TypeScript `any` types (unless third-party lib forces it)
[ ] No console.error without user-facing feedback
[ ] No hardcoded values that should be env vars
[ ] No obvious security issues (SQL injection, XSS, auth bypass)
```

### Test Readiness
```
[ ] App starts with `npm run dev` (no errors in terminal)
[ ] Handoff instructions are accurate and complete
[ ] Test data exists (seeded or easy to create)
```

**Scoring**: Count your "no" answers.
- 0 nos → Ship it
- 1–2 nos → Fix the critical ones (<10 min each), note the rest
- 3+ nos → The feature isn't ready. Keep working.

---

## 4. Handoff File Path Convention

Your handoff artifact MUST be saved to a standard location so the next agent can find it:

**Canonical path**: `./sprints/[sprint-id]/handoff-[AGENT].md`

Example:
- Sprint ID: `2026-03-31-sprint-42`
- Agent: `engineer-alpha`
- Full path: `./sprints/2026-03-31-sprint-42/handoff-engineer-alpha.md`

This ensures QA can locate your work without guessing. If you save it anywhere else, the next agent will waste time looking for it.

---

## 5. Handoff Artifact Format

````markdown
# Handoff — [TASK-ID]: [Feature Title]

**Engineer**: [alpha | beta]
**Sprint**: [ID]
**Timestamp**: [ISO]
**Sprint Elapsed**: [HH:MM]

---

## Status
READY FOR QA

## What Was Built
[3–5 sentences describing exactly what was implemented. Be specific.]

## Files Changed
| File | What Changed |
|------|-------------|
| `frontend/src/components/TaskList.tsx` | New component — renders task items |
| `backend/src/routes/tasks.ts` | GET /api/tasks, POST /api/tasks |
| `backend/src/db/schema.ts` | Added tasks table |

## How to Run
```bash
# From repo root
npm install
npm run dev
```
- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## How to Test
1. Open http://localhost:5173
2. [Specific step]
3. [Specific step — say what to click, what to type]
4. Expected: [exactly what should happen]

## Self-Evaluation
| Criterion | Score | Notes |
|-----------|-------|-------|
| Functionality | 8/10 | Core flow works; meets acceptance criteria |
| Product Depth | 8/10 | All edge cases handled; API clean |
| Visual Design | 7/10 | Basic but clean; no custom icons yet |
| Code Quality | 8/10 | TS typed, error handling in place |

## Known Issues
- [ ] Deleting a task doesn't update the list without refresh (V2)
- [ ] No optimistic updates (would be nice but not critical)

## QA Notes
[Anything specific you want QA to focus on or be careful about]
````

---

## 6. Responding to QA Feedback

When QA returns a FAIL report, you have two options:

### Option A: Refine (Most Common)
**When to choose**: Issues are specific, fixable, and will take <20 minutes total.

```
1. Read the eval report carefully
2. List the REQUIRED FIXES (QA's list)
3. Estimate fix time for each
4. If total < 20 min → Refine
5. Fix each issue
6. Re-run your self-eval checklist
7. Write updated handoff artifact (note: "v2 — addressing QA feedback")
8. Signal QA
```

### Option B: Pivot (Emergency Only)
**When to choose**: The fundamental approach is wrong, or fixing would take longer than rewriting.

**Before pivoting, message Sprint Lead with:**
```
Feature: [ID]
QA Failures: [list]
Estimated fix time: [X min]
Estimated rewrite time: [Y min]
My recommendation: PIVOT because [reason]
```

Sprint Lead decides. Do NOT pivot unilaterally.

### What "Pivot" Means
A pivot is a fundamental approach change — not just a refactor:
- Different UI paradigm (modal → inline edit)
- Different data structure (array → map)
- Simpler feature scope (drop complex part, keep simple part)

A pivot does NOT mean starting the feature from scratch with the same approach.

### The Refine Budget
You get **two QA cycles** per feature. If a feature fails QA twice:
- Signal Sprint Lead
- Sprint Lead escalates to Orchestrator
- Orchestrator decides: drop feature, simplify, or continue

Do not keep iterating in silence. The clock is running.
