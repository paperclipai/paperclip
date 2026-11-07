---
name: api-and-interface-design
description: >
  Defines REST and TypeScript interface contracts
  before implementation code lands.
---

# API and Interface Design Skill

Design stable, well-documented interfaces that are hard to misuse. Good interfaces make the right thing easy and the wrong thing hard. This applies to REST APIs, GraphQL schemas, module boundaries, component props, and any surface where one piece of code talks to another.

## When to Use

- Designing new API endpoints
- Defining module boundaries or contracts between teams
- Creating component prop interfaces
- Establishing database schema that informs API shape
- Changing existing public interfaces

## Prerequisites

No setup beyond the project's own build, test, and version-control commands.

## How to Run

Load this skill when the task matches When to Use, work through Procedure in order, then confirm against Verification.

## Quick Reference

- Core Principles
- Hyrum's Law
- The One-Version Rule
- 1. Contract First
- 2. Consistent Error Semantics
- 3. Validate at Boundaries
- 4. Prefer Addition Over Modification
- 5. Predictable Naming
- 6. Honouring an Idempotency Key

## Procedure

### Core Principles

Design interfaces that are stable and hard to misuse. Hyrum's Law states that with enough users, every observable behavior becomes a de facto contract — so be intentional about what you expose and don't leak implementation details.

### Hyrum's Law

> With a sufficient number of users of an API, all observable behaviors of your system will be depended on by somebody, regardless of what you promise in the contract.

This means every public behavior — including undocumented quirks, error message text, timing, and ordering — becomes a commitment once users depend on it. Plan for deprecation at design time. Tests alone are not enough; "safe" changes can break real users who depend on undocumented behavior.

### The One-Version Rule

Avoid forcing consumers to choose between multiple versions of the same dependency or API. Diamond dependency problems arise when different consumers need different versions of the same thing. Design for a world where only one version exists at a time — extend rather than fork.

### 1. Contract First

Define the interface before implementing it. The contract is the spec — implementation follows.

```typescript
interface TaskAPI {
  createTask(input: CreateTaskInput): Promise<Task>;
  listTasks(params: ListTasksParams): Promise<PaginatedResult<Task>>;
  getTask(id: string): Promise<Task>;
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>;
  deleteTask(id: string): Promise<void>;
}
```

### 2. Consistent Error Semantics

Pick one error strategy and use it everywhere:

```typescript
interface APIError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

Don't mix patterns. If some endpoints throw, others return null, and others return `{ error }` — the consumer can't predict behavior.

### 3. Validate at Boundaries

Trust internal code. Validate at system edges where external input enters: API route handlers, form submission handlers, external service response parsing, environment variable loading. Third-party API responses are untrusted data — validate their shape and content before using them.

Validation does NOT belong between internal functions that share type contracts, in utility functions called by already-validated code, or on data that just came from your own database.

### 4. Prefer Addition Over Modification

Extend interfaces without breaking existing consumers by adding optional fields rather than changing existing field types or removing fields.

### 5. Predictable Naming

| Pattern | Convention | Example |
|---------|-----------|---------|
| REST endpoints | Plural nouns, no verbs | `GET /api/tasks`, `POST /api/tasks` |
| Query params | camelCase | `?sortBy=createdAt&pageSize=20` |
| Response fields | camelCase | `{ createdAt, updatedAt, taskId }` |
| Boolean fields | is/has/can prefix | `isComplete`, `hasAttachments` |
| Enum values | UPPER_SNAKE | `"IN_PROGRESS"`, `"COMPLETED"` |

### 6. Honouring an Idempotency Key

Accepting an `Idempotency-Key` is the contract. Honouring it is the implementation. Derive the key from the intent, not the attempt — the client generates once and reuses on retry. Claim atomically using a unique constraint; never do a check-then-act which creates a TOCTOU race. Guard the payload — same key with a different body must fail loudly. Decide what an in-flight duplicate gets: reject (409), wait, or return pending (202). Every call has three outcomes: success, failure, and unknown.

## Pitfalls

- Endpoints that return different shapes depending on conditions
- Inconsistent error formats across endpoints
- Validation scattered throughout internal code instead of at boundaries
- Breaking changes to existing fields (type changes, removals)
- List endpoints without pagination
- Verbs in REST URLs (`/api/createTask`, `/api/getUsers`)
- Third-party API responses used without validation or sanitization
- An idempotency key derived from a UUID, timestamp, or anything regenerated per attempt
- A key retention window shorter than the longest path that can re-deliver the request

## Verification

- [ ] Every endpoint has typed input and output schemas
- [ ] Error responses follow a single consistent format
- [ ] Validation happens at system boundaries only
- [ ] List endpoints support pagination
- [ ] New fields are additive and optional (backward compatible)
- [ ] Naming follows consistent conventions across all endpoints
- [ ] API documentation or types are committed alongside the implementation
- [ ] State-changing endpoints honour an idempotency key or are documented as unsafe to retry
- [ ] The key is claimed in one atomic operation, guarded by a unique constraint
- [ ] A reused key with a different payload fails loudly rather than replaying the wrong response
- [ ] Key retention outlives the longest retry path, including dead-letter replay