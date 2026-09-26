---
name: "backend-api-design"
description: "Design RPC-style APIs with layered architecture (Controller → Manager → Repository). Use when creating new API endpoints, designing API contracts, or reviewing API patterns."
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/backend-api-design"
recommendedForRoles:
  - "engineer"
  - "designer"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "backend"
  - "api"
  - "design"
defaultInstall: false
---
# Backend API Design — Quick Reference

## URL Patterns

```
GET  /api/v1/employees              # List (plural)
GET  /api/v1/employee               # Get one (?id=xxx)
POST /api/v1/employee               # Create
POST /api/v1/employee/update        # Update (?id=xxx)
POST /api/v1/employee/delete        # Soft delete (?id=xxx)
POST /api/v1/employee/restore       # Restore (?id=xxx)
POST /api/v1/sync/employees         # Action
```

## Hard Rules

- **NO path params** — always `@QueryValue`, never `@PathVariable`
- **Singular for single resource** — `/employee` not `/employees/{id}`
- **Plural for collections** — `/employees`
- **Verb sub-paths for actions** — `/delete`, `/restore`, `/sync`

## Layered Architecture

```
Controller  →  thin, just delegates
    ↓
Manager     →  business logic, transactions, Either returns
    ↓
Repository  →  data access only, no business logic
```

### Controller: Thin Wrapper
- Parse query params with defaults
- Delegate to manager
- Unwrap Either with `.throwOrValue()`
- NO business logic, NO repository access

### Manager: Business Logic
- Returns `Either<ClientException, T>`
- Wraps DB ops in `transaction(db.primary) { }`
- Orchestrates multiple repositories
- Validates business rules

### Repository: Data Access
- Returns entities or null
- `db.replica` for reads, `db.primary` for writes
- Always checks `deletedAt.isNull()`

## Quick Code Reference

The core controller delegation pattern:

```kotlin
@Get("/employee")
suspend fun getEmployee(@QueryValue id: UUID): EmployeeResponse {
  return employeeManager.findById(id).throwOrValue()
}
```

- **Response models** — `companion object { fun from(entity) }` in `module-client/response/{domain}/`
- **Pagination** — offset-based, manager returns `EmployeeListResponse` with `items`, `total`, `page`, `limit`, `hasMore`
- **Errors** — return `ClientError.NOT_FOUND.asException().left()` from managers, never throw
- **Factory beans** — `@Factory` class with `@Singleton` method, wire repos + db into manager

> See code-patterns.md for complete controller, response model, pagination, error handling, and factory bean templates.

## Gotchas

- **Multi-word `@QueryValue` params MUST have explicit snake_case names.** The frontend axios interceptor sends `project_id` but Micronaut matches the literal param name. Write `@QueryValue("project_id") projectId: UUID`, not bare `@QueryValue projectId: UUID`.
- **Don't use `@Put`, `@Delete`, or `@Patch`.** This is RPC-style — all mutations are `@Post`. The only `@Get` is for reads.
- **Controllers that inject repositories are a code smell.** If you see `private val fooRepository: FooRepository` in a controller, move it to the manager.
- **`andWhere {}` not second `.where {}`.** Calling `.where {}` twice replaces the first condition. Use `.andWhere {}` to chain.
- **Don't forget `@ExecuteOn(TaskExecutors.IO)`.** Without it, suspend functions may hang or run on the wrong thread pool. Every controller needs it.
