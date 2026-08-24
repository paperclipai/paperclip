---
title: Support KB — Environment Driver Value Corruption
summary: readEnum() returns null on corrupt driver values instead of throwing (PRA-577)
version: v0.3.1+
commit: 32ccc16229
---

# Support KB: Environment Driver Value Corruption — readEnum() Behavior Change

**Applies to:** Paperclip v0.3.1+
**Commit:** `32ccc16229` (PRA-577)
**Date:** 2026-08-15

---

## Summary

The `readEnum()` function in the Paperclip environments service now handles unexpected (corrupt) driver values gracefully instead of crashing.

## Old Behavior

When an environment had a corrupt `driver` value (e.g. `local_5cb37f67` instead of a valid enum like `local`, `production`), `readEnum()` **threw an Error**, which crashed the calling agent/task.

## New Behavior

`readEnum()` now:
1. Logs a **warning** via the Paperclip logger (visible in agent logs)
2. Returns **`null`** instead of throwing

Callers must handle `null` return values gracefully (most already do, since `null` is a valid return when the field is absent).

## How to Detect

If an agent is behaving unexpectedly when reading environment configuration, check the logs for:
```
Unexpected <fieldName> value: <value>; treating as null
```

## What This Means for Support

- **No more crashes** due to corrupt environment driver values — agents will continue running
- **Environment may be silently treated as absent** (null) if its driver value is corrupt
- **Check logs** first when debugging environment-related agent issues — the warning message tells you exactly which field has the corrupt value and what the allowed values are
- To fix a corrupt environment value, PATCH the environment record with a valid driver value via the DB or API

## Related

- PRA-577: allow environments with corrupt driver values to be read without crashing
- Environments with database-level corruption from earlier migration attempts (local_* prefix pattern)
