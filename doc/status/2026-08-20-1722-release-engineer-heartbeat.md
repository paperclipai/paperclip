# Release Engineer Heartbeat — 2026-08-20 ~17:22 UTC

## VOY-1495 (Async UX M1+M2) → ✅ DONE

### Accomplished
- **CTO go/no-go**: VOY-1524 GO ✅ (16:55 UTC)
- **Tests**: 31/31 targeted tests passed (background-jobs 14, research-search 12, escape-probe 5)
- **Deploy**: Server restarted (launchd com.praesyn.paperclip) to load full release code including post-review fixes
- **Migration fix**: 0144 made idempotent (IF NOT EXISTS + guarded constraints) to prevent crash loops on re-apply — committed as 335ca566c4, pushed to fork
- **UI rebuilt**: `pnpm --filter @paperclipai/ui build` — new components (BackgroundProcessTray, FreshnessCue, Skeleton, StatusCue, ActivitySearchPanel) now live
- **413 export cap**: Verified — oversized payloads → HTTP 413 (was missing before restart)
- **Worker verified**: background-job worker processes jobs to completion (7/7 succeeded)
- **Docs**: Support Engineer's release note at `docs/support/releases/voy-1474-async-ux.md` — confirmed in sync

### Routes verified post-deploy
- `POST /research/auto-assess` → 202 ✅
- `POST /research/activities` → 400 (validation, correct) ✅
- `POST /exports/pdf` (small) → 202 ✅
- `POST /exports/pdf` (>512KB) → **413** ✅ (post-review fix confirmed live)
- `GET /background-jobs` → 200 ✅
- Health endpoint → 200 ✅

### Remaining (delegated)
1. **VOY-1496** (QA verify) — child issue, blocker resolved by VOY-1495 completion, awaiting QA Engineer
2. **PR #58 merge** — blocked on GitHub (only repo collaborator is @PraeSynBH who cannot self-approve; CI billing failure also blocks automated checks). Founder Ben to resolve.
3. **CI billing** (GitHub Actions) — founder Ben to resolve account payments

### Blockers (unchanged)
- GitHub Actions billing failure — prevents automated CI/CD. Manual deploy workaround used.