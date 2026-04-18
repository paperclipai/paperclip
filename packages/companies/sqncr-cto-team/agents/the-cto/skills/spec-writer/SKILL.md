---
name: spec-writer
description: Generate implementation specs with API shapes, component lists, and design system references. Specs that teams can ship from on the first try.
---

# Spec Writer

Transforms requirements into implementation-ready specifications. A good spec eliminates rework at integration time by defining every contract before code is written.

## When To Use

- Before any build that involves 2+ files or 2+ people
- When requirements are verbal/vague and need structure
- Before delegating implementation to a sub-agent or specialist
- When a feature touches multiple layers (frontend + backend + database)

## The Spec Process

### Phase 1: Scope Lock

Before writing anything, answer these questions:

1. **What is the user trying to do?** (Not "what are we building" but "what job does this solve?")
2. **What already exists?** (Read the current code. Never spec against an imagined codebase.)
3. **What changes?** (Schema? API? UI? All three?)
4. **What does NOT change?** (Explicitly list what's out of scope to prevent scope creep during implementation.)

Write a single sentence: "This spec covers [scope]. It does not cover [anti-scope]."

### Phase 2: Schema Changes

If the feature touches the database:

```
## Schema Changes

### New Tables
table_name:
  - column_name: type | constraints | default | purpose

### Modified Tables
table_name:
  - ADD column_name: type | constraints | default | purpose
  - MODIFY column_name: old_type -> new_type | migration notes

### Migrations
1. [migration description]
2. [migration description]

### Rollback Plan
If this migration fails mid-way:
1. [recovery steps]
```

### Phase 3: API Contracts

Define every endpoint the feature needs. No assumed shapes.

```
## API Contracts

### POST /api/resource
Purpose: [what this does]
Auth: [required | optional | none]
Rate limit: [if applicable]

Request:
{
  field: string     // [description, constraints]
  field: number     // [description, range]
}

Response (200):
{
  id: string
  created_at: string  // ISO 8601
}

Response (400):
{
  error: string       // "VALIDATION_ERROR"
  message: string
  fields: Record<string, string>  // field-level errors
}

Response (500):
{
  error: string       // "INTERNAL_ERROR"
  requestId: string   // for debugging
}

Side effects:
- [sends email]
- [updates cache]
- [emits event]
```

### Phase 4: Component List

For frontend work, list every component with its props and states:

```
## Components

### ComponentName
Purpose: [what it does]
Location: [file path]
Props:
  - propName: type - [description]
States:
  - default: [what it looks like]
  - loading: [skeleton/spinner/disabled]
  - empty: [no data message]
  - error: [error state + retry option]
  - [domain-specific states]
Dependencies:
  - [other components, hooks, APIs]
```

### Phase 5: Design System References

Connect the spec to existing design patterns:

```
## Design System

Colors: [which tokens/variables]
Typography: [which scale]
Spacing: [which grid]
Components: [which existing components to reuse vs. build new]
Responsive: [breakpoints and behavior at each]
Dark mode: [how this feature handles dark mode]
```

### Phase 6: Implementation Order

Define the build sequence. Each step should be independently testable:

```
## Implementation Order

1. [Schema migration] - testable by: running migration, checking table exists
2. [API endpoint] - testable by: curl/Postman request returns expected shape
3. [Core component] - testable by: renders with mock data in all states
4. [Integration] - testable by: full user flow works end-to-end
5. [Edge cases] - testable by: error states render, empty states handle, auth redirects
```

### Phase 7: Acceptance Criteria

Binary pass/fail checks. No ambiguity.

```
## Acceptance Criteria

- [ ] User can [action] and sees [result]
- [ ] Error state shows [specific message] when [condition]
- [ ] Loading state appears within [X]ms of user action
- [ ] Mobile layout works at 375px width
- [ ] Dark mode renders correctly
- [ ] No TypeScript errors (`npm run build` passes)
- [ ] [Domain-specific criteria]
```

## Quality Gate

Before delivering the spec:
- [ ] Scope sentence exists and is specific
- [ ] Every API endpoint has request AND response shapes (including errors)
- [ ] Every component has all states defined (not just happy path)
- [ ] Implementation order is sequenced so each step is testable
- [ ] Acceptance criteria are binary (pass/fail, not subjective)
- [ ] Anti-scope is listed (what this does NOT cover)
- [ ] Existing code was read (spec builds on reality, not assumptions)
