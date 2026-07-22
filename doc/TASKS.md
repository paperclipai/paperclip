# Task Management Data Model

Reference for how task tracking works in Paperclip. Describes the entities, their
relationships, and the rules governing task lifecycle. Written as a target model
-- some of this is already implemented, some is aspirational.

---

## Entity Hierarchy

```
Workspace
  Initiatives          (roadmap-level objectives, span quarters)
    Projects           (time-bound deliverables, can span teams)
      Milestones       (stages within a project)
        Issues         (units of work, the core entity)
          Sub-issues   (broken-down work under a parent issue)
```

Everything flows down. An initiative contains projects; a project contains
milestones and issues; an issue can have sub-issues. Each level adds
granularity.

---

## Issues (Core Entity)

An issue is the fundamental unit of work.

### Fields

| Field         | Type             | Required | Notes                                                             |
| ------------- | ---------------- | -------- | ----------------------------------------------------------------- |
| `id`          | uuid             | yes      | Primary key                                                       |
| `identifier`  | string           | computed | Human-readable, e.g. `ENG-123` (team key + auto-increment number) |
| `title`       | string           | yes      | Short summary                                                     |
| `description` | text/markdown    | no       | Full description, supports markdown                               |
| `status`      | WorkflowState FK | yes      | Defaults to team's default state                                  |
| `priority`    | enum (0-4)       | no       | Defaults to 0 (none). See Priority section.                       |
| `estimate`    | number           | no       | Complexity/size points                                            |
| `dueDate`     | date             | no       |                                                                   |
| `teamId`      | uuid FK          | yes      | Every issue belongs to exactly one team                           |
| `projectId`   | uuid FK          | no       | At most one project per issue                                     |
| `milestoneId` | uuid FK          | no       | At most one milestone per issue                                   |
| `assigneeId`  | uuid FK          | no       | **Single assignee.** See Assignees section.                       |
| `creatorId`   | uuid FK          | no       | Who created it                                                    |
| `parentId`    | uuid FK (self)   | no       | Parent issue, for sub-issue relationships                         |
| `goalId`      | uuid FK          | no       | Linked objective/goal                                             |
| `sortOrder`   | float            | no       | Ordering within views                                             |
| `createdAt`   | timestamp        | yes      |                                                                   |
| `updatedAt`   | timestamp        | yes      |                                                                   |
| `startedAt`   | timestamp        | computed | When issue entered a "started" state                              |
| `completedAt` | timestamp        | computed | When issue entered a "completed" state                            |
| `cancelledAt` | timestamp        | computed | When issue entered a "cancelled" state                            |
| `archivedAt`  | timestamp        | no       | Soft archive                                                      |

---

## Workflow States

Issue status is **not** a flat enum. It's a team-specific set of named states,
each belonging to one of these fixed **categories**:

| Category      | Purpose                      | Example States                  |
| ------------- | ---------------------------- | ------------------------------- |
| **Triage**    | Incoming, needs review       | Triage                          |
| **Backlog**   | Accepted, not ready for work | Backlog, Icebox                 |
| **Unstarted** | Ready but not begun          | Todo, Ready                     |
| **Started**   | Active work                  | In Progress, In Review, In QA   |
| **Completed** | Done                         | Done, Shipped                   |
| **Cancelled** | Rejected or abandoned        | Cancelled, Won't Fix, Duplicate |

### Rules

- Each team defines its own workflow states within these categories
- Teams must have at least one state per category (Triage is optional)
- Custom states can be added within any category (e.g. "In Review" under Started)
- Categories are fixed and ordered -- you can reorder states _within_ a category
  but not the categories themselves
- New issues default to the team's first Backlog state
- Moving an issue to a Started state auto-sets `startedAt`; Completed sets
  `completedAt`; Cancelled sets `cancelledAt`
- Marking an issue as a duplicate auto-moves it to a Cancelled state

### WorkflowState Fields

| Field         | Type    | Notes                                                                         |
| ------------- | ------- | ----------------------------------------------------------------------------- |
| `id`          | uuid    |                                                                               |
| `name`        | string  | Display name, e.g. "In Review"                                                |
| `type`        | enum    | One of: `triage`, `backlog`, `unstarted`, `started`, `completed`, `cancelled` |
| `color`       | string  | Hex color                                                                     |
| `description` | string  | Optional guidance text                                                        |
| `position`    | float   | Ordering within the category                                                  |
| `teamId`      | uuid FK | Each state belongs to one team                                                |

---

## Priority

A fixed, non-customizable numeric scale:

| Value | Label       | Notes                                  |
| ----- | ----------- | -------------------------------------- |
| 0     | No priority | Default. Sorts last in priority views. |
| 1     | Urgent      | Could trigger immediate notification   |
| 2     | High        |                                        |
| 3     | Medium      |                                        |
| 4     | Low         |                                        |

The scale is intentionally small and fixed. Use labels for additional
categorization rather than adding more priority levels.

---

## Teams

Teams are the primary organizational unit. Almost everything is scoped to a
team.

| Field         | Type   | Notes                                                          |
| ------------- | ------ | -------------------------------------------------------------- |
| `id`          | uuid   |                                                                |
| `name`        | string | e.g. "Engineering"                                             |
| `key`         | string | Short uppercase prefix, e.g. "ENG". Used in issue identifiers. |
| `description` | string |                                                                |

### Team Scoping

- Each issue belongs to exactly one team
- Workflow states are per-team
- Labels can be team-scoped or workspace-wide
- Projects can span multiple teams

In our context (AI company), teams map to functional areas. Each agent reports
to a team based on role.

---

## Projects

Projects group issues toward a specific, time-bound deliverable. They can span
multiple teams.

| Field         | Type      | Notes                                                         |
| ------------- | --------- | ------------------------------------------------------------- |
| `id`          | uuid      |                                                               |
| `name`        | string    |                                                               |
| `description` | text      |                                                               |
| `summary`     | string    | Short blurb                                                   |
| `status`      | enum      | `backlog`, `planned`, `in_progress`, `completed`, `cancelled` |
| `leadId`      | uuid FK   | Single owner for accountability                               |
| `startDate`   | date      |                                                               |
| `targetDate`  | date      |                                                               |
| `createdAt`   | timestamp |                                                               |
| `updatedAt`   | timestamp |                                                               |

### Rules

- An issue belongs to at most one project
- Project status is **manually** updated (not auto-derived from issue states)
- Projects can contain documents (specs, briefs) as linked entities

---

## Milestones

Milestones subdivide a project into meaningful stages.

| Field         | Type    | Notes                          |
| ------------- | ------- | ------------------------------ |
| `id`          | uuid    |                                |
| `name`        | string  |                                |
| `description` | text    |                                |
| `targetDate`  | date    |                                |
| `projectId`   | uuid FK | Belongs to exactly one project |
| `sortOrder`   | float   |                                |

Issues within a project can optionally be assigned to a milestone.

---

## Labels / Tags

Labels provide categorical tagging. They exist at two scopes:

- **Workspace labels** -- available across all teams
- **Team labels** -- restricted to a specific team

| Field         | Type           | Notes                           |
| ------------- | -------------- | ------------------------------- |
| `id`          | uuid           |                                 |
| `name`        | string         |                                 |
| `color`       | string         | Hex color                       |
| `description` | string         | Contextual guidance             |
| `teamId`      | uuid FK        | Null for workspace-level labels |
| `groupId`     | uuid FK (self) | Parent label for grouping       |

### Label Groups

Labels can be organized into one level of nesting (group -> labels):

- Labels within a group are **mutually exclusive** on an issue (only one can be
  applied from each group)
- Groups cannot contain other groups (single nesting level only)
- Example: group "Type" contains labels "Bug", "Feature", "Chore" -- an issue
  gets at most one

### Issue-Label Junction

Many-to-many via `issue_labels` join table:

| Field     | Type    |
| --------- | ------- |
| `issueId` | uuid FK |
| `labelId` | uuid FK |

---

## Issue Relations / Dependencies

Four relation types between issues:

| Type         | Meaning                          | Behavior                                      |
| ------------ | -------------------------------- | --------------------------------------------- |
| `related`    | General connection               | Informational link                            |
| `blocks`     | This issue blocks another        | Blocked issue shown with flag                 |
| `blocked_by` | This issue is blocked by another | Inverse of blocks                             |
| `duplicate`  | This issue duplicates another    | Auto-moves the duplicate to a Cancelled state |

### IssueRelation Fields

| Field            | Type    | Notes                                          |
| ---------------- | ------- | ---------------------------------------------- |
| `id`             | uuid    |                                                |
| `type`           | enum    | `related`, `blocks`, `blocked_by`, `duplicate` |
| `issueId`        | uuid FK | Source issue                                   |
| `relatedIssueId` | uuid FK | Target issue                                   |

### Rules

- When a blocking issue is resolved, the relation becomes informational (flag
  turns green)
- Duplicate is one-directional (you mark the duplicate, not the canonical)
- Blocking is **not transitive** at the system level (A blocks B, B blocks C
  does not auto-block A->C)

---

## Assignees

**Single-assignee model** by design.

- Each issue has at most one assignee at a time
- This is deliberate: clear ownership prevents diffusion of responsibility
- For collaborative work involving multiple people, use **sub-issues** with
  different assignees

In our context, agents are the assignees. The `assigneeId` FK on issues
points to the `agents` table.

---

## Sub-issues (Parent/Child)

Issues support parent/child nesting.

- Setting `parentId` on an issue makes it a sub-issue
- Sub-issues can themselves have sub-issues (multi-level nesting)
- Sub-issues inherit **project** from their parent at creation
  time (not retroactively), but NOT team, labels, or assignee

### Auto-close

- **Sub-issue auto-close**: when parent completes, remaining sub-issues
  auto-complete

### Conversions

- Existing issues can be reparented (add or remove `parentId`)
- A parent issue with many sub-issues can be "promoted" to a project

---

## Estimates

Point-based estimation, configured per-team.

### Available Scales

| Scale       | Values                   |
| ----------- | ------------------------ |
| Exponential | 1, 2, 4, 8, 16 (+32, 64) |

Unestimated issues default to 1 point for progress/velocity calculations.

---

## Comments

| Field        | Type           | Notes                      |
| ------------ | -------------- | -------------------------- |
| `id`         | uuid           |                            |
| `body`       | text/markdown  |                            |
| `issueId`    | uuid FK        |                            |
| `authorId`   | uuid FK        | Can be a user or agent     |
| `parentId`   | uuid FK (self) | For threaded replies       |
| `resolvedAt` | timestamp      | If the thread was resolved |
| `createdAt`  | timestamp      |                            |
| `updatedAt`  | timestamp      |                            |

---

## Initiatives

The highest-level planning construct. Groups projects toward a strategic
objective. Initiatives have strategic owners, and are typically measured by outcomes/OKRs, not “done/not done.”

| Field         | Type    | Notes                            |
| ------------- | ------- | -------------------------------- |
| `id`          | uuid    |                                  |
| `name`        | string  |                                  |
| `description` | text    |                                  |
| `ownerId`     | uuid FK | Single owner                     |
| `status`      | enum    | `planned`, `active`, `completed` |
| `targetDate`  | date    |                                  |

Initiatives contain projects (many-to-many) and provide a rollup view of
progress across all contained projects.

---

## Identifiers

Issues use human-readable identifiers: `{TEAM_KEY}-{NUMBER}`

- Team key: short uppercase string set per team (e.g. "ENG", "DES")
- Number: auto-incrementing integer per team
- Examples: `ENG-123`, `DES-45`, `OPS-7`
- If an issue moves between teams, it gets a new identifier and the old one is
  preserved in `previousIdentifiers`

This is far better for human communication than UUIDs. People say "grab ENG-42"
not "grab 7f3a...".

---

## Entity Relationships

```
Team (1) ----< (many) Issue
Team (1) ----< (many) WorkflowState
Team (1) ----< (many) Label (team-scoped)

Issue (many) >---- (1) WorkflowState
Issue (many) >---- (0..1) Assignee (Agent)
Issue (many) >---- (0..1) Project
Issue (many) >---- (0..1) Milestone
Issue (many) >---- (0..1) Parent Issue
Issue (1) ----< (many) Sub-issues
Issue (many) >---< (many) Labels         (via issue_labels)
Issue (many) >---< (many) Issue Relations (via issue_relations)
Issue (1) ----< (many) Comments

Project (many) >---- (0..1) Lead (Agent)
Project (1) ----< (many) Milestones
Project (1) ----< (many) Issues

Initiative (many) >---< (many) Projects  (via initiative_projects)
Initiative (many) >---- (1) Owner (Agent)
```

---

## Implementation Priority

Recommended build order, highest value first:

### High Value

1. **Teams** -- `teams` table + `teamId` FK on issues. Foundation for
   human-readable identifiers (`ENG-123`) and per-team workflow states. Most
   other features depend on team scoping, so build this first.
2. **Workflow states** -- `workflow_states` table + `stateId` FK on issues.
   Per-team custom workflows with category-based state transitions.
3. **Labels** -- `labels` + `issue_labels` tables. Categorization
   (bug/feature/chore, area tags, etc.) without polluting the status field.
4. **Issue Relations** -- `issue_relations` table. Blocking/blocked-by is
   essential for agent coordination (agent A can't start until agent B finishes).
5. **Sub-issues** -- `parentId` self-FK on `issues`. Lets agents break down
   large tasks.
6. **Comments** -- `comments` table. Agents need to communicate about issues
   without overwriting the description.

### Medium Value

7. **Transition timestamps** -- `startedAt`, `completedAt`, `cancelledAt` on
   issues, auto-set by workflow state changes. Enables velocity tracking and SLA
   measurement.

### Lower Priority (For Later)

8. **Milestones** -- Useful once projects get complex enough to need stages.
9. **Initiatives** -- Useful once we have multiple projects that serve a common
   strategic goal.
10. **Estimates** -- Useful once we want to measure throughput and predict
    capacity.
