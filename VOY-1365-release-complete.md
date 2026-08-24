# VOY-1365 — Release Complete

**Status**: Done (verified + deployed)
**Branch**: hotfix/voy-1368-re-audit → merged into fork/master (production)
**Approval**: CTO (VOY-1369), Staff Engineer re-audit (VOY-1368)

## What was shipped

The hotfix/v0.4.0-alpha-deploy-scope branch plus re-audit fixes are deployed
on fork/master (commit `f95987cf0f`).

### Original hotfix (commits 1d72fac741 + 727c14bc40)

- C-1: promoteFromMemory wrapped in db.transaction (orphan prevention)
- C-2: memory_record_id column + unique index for dedup
- C-3: invalidateKnowledgeSearchCache() on every mutation
- H-1: true LRU eviction
- H-3: isZombieRun 30s TTL in-memory cache (zombie detection)
- Revision-removal: create/promote no longer insert initial revision
- VOY-1358: review(changes_requested) bumps doc.version

### Re-audit fixes (commit f95987cf0f)

| Finding | Fix | Status |
|---------|-----|--------|
| P0-1 — Zombie cache race | Re-verified as acceptable in VOY-1368 | Done |
| P0-2 — Pre-existing doc submit collision | Data migration: DELETE stale initial revisions for draft/archived docs | ✅ |
| P1-1 — Cache invalidation before write | Moved all 8 invalidation sites AFTER mutation commits | ✅ |
| P1-3 — Zero test coverage | 105-line zombie guard test + 228-line knowledge docs test | ✅ |

## Required action when API recovers

- Mark VOY-1365 (ab339509-926e-4028-acf9-bfb4a40a4ee5) as `done`
- Add completion comment documenting the verified state