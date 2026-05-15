# Backlog Management Policy

> **Version:** 1.0
> **Owner:** CEO
> **Custodian:** Penny — Product & Briefing Quality Lead

---

## 1. Purpose

This document defines the formal process for managing the company backlog — including the **Daily Backlog Review** and the **Backlog Rationale Requirement** — to ensure the backlog remains a strategic, actionable, and well-governed queue of work.

---

## 2. Daily Backlog Review Process

### 2.1 Cadence

The CEO (or a designated delegate) reviews the backlog **daily**. The review is a lightweight, time-boxed scan (15–30 minutes) focused on surfacing items ready for active work.

### 2.2 Scope

The review covers all issues in the **Backlog** status (within scope of this company). Items already in **To Do** or **In Progress** are not re-reviewed unless explicitly flagged.

### 2.3 Promotion Criteria

An item may be promoted from **Backlog → To Do** when it satisfies **at least one** of the following criteria:

| Criterion | Description |
|-----------|-------------|
| **Strategic Importance** | Directly advances a stated quarterly OKR or board-level priority. |
| **Business Impact** | High ROI — significant value relative to effort. |
| **Engineering Capacity** | There is idle or underutilized engineering capacity, and this item is the best available use of it. |
| **Dependency Unblocked** | A previously blocked item now has its dependencies resolved. |
| **Quick Win** | Can be completed in ≤1 engineer-day and delivers clear value. |
| **CEO Priority Signal** | Explicitly flagged by the CEO as time-sensitive. |

At most **1-2 items** should be promoted per review unless a specific initiative requires parallel startup.

### 2.4 Daily Review Checklist

Each daily review follows this checklist:

```
[ ] Open Backlog view, sorted by priority (high → low)
[ ] Scan the top 10 items
[ ] For each item meeting a promotion criterion:
    - Confirm rationale is present (see §3)
    - Move from Backlog → To Do
    - Tag with the applicable criterion label
[ ] Check for items with approaching deadlines or stale dates
[ ] Flag items with no recent activity (>14 days) for re-triaging
[ ] Note any blockers or decisions needed in daily notes
```

### 2.5 Escalation

If an item has been in Backlog for **>30 days** without being promoted or updated, it is flagged for **quarterly purge review** — the CEO and Penny assess whether to keep, defer further, or archive it.

---

## 3. Backlog Rationale Requirement

### 3.1 Rule

Every issue entering the **Backlog** status MUST include a **deferral rationale** — a brief explanation of why this work is deferred rather than started immediately. This ensures no item sits in the backlog by neglect.

### 3.2 Format

Include the rationale in the issue description or as the first comment. Use the following format:

```
**Backlog Rationale**
- Reason deferred: <one of: capacity, dependency, lower priority, waiting on decision, seasonal/timing>
- Expected review window: <e.g., "next sprint", "when dependency X is done", "Q3 planning">
- Trigger to promote: <what condition would move this to To Do>
```

### 3.3 Examples

| Scenario | Example Rationale |
|----------|-------------------|
| Low priority feature | **Reason deferred:** lower priority. **Expected review window:** next quarterly planning. **Trigger to promote:** higher-priority items clear. |
| Blocked by dependency | **Reason deferred:** dependency. **Expected review window:** when API v2 ships. **Trigger to promote:** API v2 is available in staging. |
| Waiting on decision | **Reason deferred:** waiting on decision. **Expected review window:** CEO/UX review in 2 weeks. **Trigger to promote:** design direction is confirmed. |
| Seasonal timing | **Reason deferred:** seasonal/timing. **Expected review window:** Q4. **Trigger to promote:** November 1 (seasonal window opens). |
| No current capacity | **Reason deferred:** capacity. **Expected review window:** next sprint planning. **Trigger to promote:** a team has free capacity and this is the highest-value item available. |

### 3.4 Enforcement

- Issues submitted to Backlog **without** a rationale may be returned to the submitter by Penny or the CEO.
- The daily backlog review checks that the rationale is present before promoting.
- A missing rationale is itself a valid reason to keep the item deferred.

---

## 4. RACI Matrix

| Activity | CEO | Penny | Engineering (Hunter) | All Contributors |
|----------|-----|-------|---------------------|------------------|
| Perform daily backlog review | **R** | A | I | I |
| Add deferral rationale to new backlog items | A | C | C | **R** |
| Promote items from Backlog → To Do | **R** | C | I | - |
| Flag stale items (>30 days) | A | **R** | I | - |
| Quarterly purge review | **R** | **R** | C | I |
| Enforce rationale requirement | A | **R** | - | - |

**R** = Responsible (doer), **A** = Accountable (approver), **C** = Consulted, **I** = Informed

---

## 5. Related Documents

- Company OKRs & Quarterly Priorities
- Issue Lifecycle & Status Definitions
- Engineering Work-in-Progress (WIP) Limits
