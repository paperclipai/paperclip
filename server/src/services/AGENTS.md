# AGENTS.md — Paperclip Services Layer

**Generated:** 2026-03-29

## OVERVIEW

Express service layer (64 files, 34.5K LOC) implementing company-scoped business logic for the Paperclip agent control plane.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Agent lifecycle | `agents.ts`, `heartbeat.ts` | CRUD, heartbeat loop, runtime state |
| Task/Issue management | `issues.ts` | 1,825 lines - checkout, assignment, status |
| Company portability | `company-portability.ts` | 4,247 lines - export/import across companies |
| Skills management | `company-skills.ts` | 2,355 lines - skill sync, adapter utils |
| Budget enforcement | `budgets.ts` | 958 lines - hard-stop auto-pause |
| Plugin system | `plugin-*.ts` | Loader, lifecycle, job scheduler, worker manager, registry |
| Workspace runtime | `workspace-runtime.ts` | 1,564 lines - execution workspace management |
| Routines | `routines.ts` | 1,268 lines - scheduled/queued task workflows |

## CONVENTIONS

### Service layer patterns
- Use `accessService` for permission checks
- Return typed results; never expose raw DB rows
- Activity logging via `logActivity()` for all mutations
- Live events via `publishLiveEvent()` for real-time UI updates

### Error handling
- Use factory errors: `notFound()`, `conflict()`, `unprocessable()`
- Never throw—return `{ error: ... }` or throw typed `AppError`

### DB access
- Drizzle ORM only; imported from `@paperclipai/db`
- Schema entities imported from `@paperclipai/db`
- Write activity log entries for all mutating operations

## ANTI-PATTERNS

