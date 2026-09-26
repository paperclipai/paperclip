---
name: "kotlin-best-practices"
description: "Kotlin coding standards including null safety, Either error handling, coroutines, and Exposed ORM patterns. Use when writing Kotlin code, reviewing code quality, or learning project patterns."
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/kotlin-best-practices"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "kotlin"
  - "best"
  - "practices"
defaultInstall: false
---
# Kotlin Best Practices — Quick Reference

## Null Safety

`!!` is banned. Use `?.`, `?:`, or null check for smart cast.

> See code-patterns.md for all null safety examples.

## Either Error Handling

Managers return `Either<ClientException, T>` -- never throw. Controllers unwrap with `.throwOrValue()`.

> See code-patterns.md for manager + controller examples.

## Enum Usage

Never hardcode strings when an enum exists. Use `EnumName.VALUE.value` everywhere.

> See code-patterns.md for enum definition and usage patterns.

## Exposed ORM Patterns

Extend `UUIDTable`, use `text()` not `varchar()`. Always filter `deletedAt.isNull()`. Soft delete via timestamp update, never hard delete.

> See code-patterns.md for table, query, and soft delete examples.

## Transaction Rules

Reads use `db.replica`, writes use `db.primary`. Multi-table writes go in one transaction block -- all succeed or all rollback.

> See code-patterns.md for transaction examples.

## Conversion Pattern

Put `companion object { fun from(entity) }` inside Response DTOs. Never create separate mapper files.

> See code-patterns.md for the full pattern.

## What to Avoid

- `!!` -- always use `?.`, `?:`, or null check
- `@Suppress` -- fix the root cause
- Throwing exceptions -- return `Either.left()` instead
- `VARCHAR` in SQL -- use `TEXT`
- Hardcoded strings for enum values
- `Table` base class -- use `UUIDTable`
- Field injection -- use constructor injection
