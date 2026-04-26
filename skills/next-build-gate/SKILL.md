---
name: next-build-gate
description: Pre-push validation gate for a Bobby Tours Next.js site — runs tsc + eslint LOCALLY on the Paperclip VPS. Actual `next build` runs ONLY on Contabo (16GB/4vCPU Paperclip VPS cannot do next builds reliably). Use as part of PR review, pre-merge check, or devops deploy verification.
---

# Next Build Gate — Local Validation + Contabo Build

## ⚠ CRITICAL CONSTRAINT

**The Paperclip VPS (where agents run) is 16 GB, 4 vCPU.** `next build` on sites with 300-500+ pages consumes too much memory + CPU — agent runs hang or OOM. 

**NEVER run `next build` from an agent process on this VPS.**

Builds are owned by **Contabo** (31.220.88.124). Contabo has a systemd timer that:
1. Fires every 15 min
2. `git reset --hard origin/main` per site
3. Runs `next build`
4. rsyncs output to Cloudways
5. Logs success/failure

## What you (agents on Paperclip VPS) CAN do

1. **tsc --noEmit** — lightweight type check, ~15-30s per repo. Safe on Paperclip VPS.
2. **eslint .** — lightweight, ~10s. Safe.
3. **Fetch live production site via HTTPS** — validate what Contabo deployed.
4. **Check Contabo's build logs** — if SSH to Contabo is set up, tail `/var/log/bobby-tours-builder.log`.

## When to use this skill

- Every PR review (reviewer role) — local tsc + eslint gates before merging to staging
- Before promoting staging → main (devops role) — rerun tsc/eslint on staging HEAD
- After dependency upgrades

## Working directory

Use the repo's own cwd, set in your adapter config (`/srv/newpaperclip/bobby-tours/<repo>`). Run `pwd` first; if you're not there, STOP.

## Procedure (for PR review / staging promotion)

1. **Fetch latest + checkout target branch:**
   ```bash
   git fetch origin
   git checkout <branch>
   git log --oneline -3
   ```

2. **Clean install deps (only if package.json changed):**
   ```bash
   if git diff HEAD~1 --name-only | grep -q "package\(-lock\)\?\.json"; then
     npm ci
   fi
   ```

3. **TypeScript gate:**
   ```bash
   npx tsc --noEmit
   ```
   Must exit 0. If it fails, the Contabo build WILL fail too — block the promotion.

4. **ESLint no-regress:**
   ```bash
   CUR=$(npx eslint . 2>&1 | grep -c "warning")
   git stash -u 2>/dev/null
   git checkout main
   MAIN=$(npx eslint . 2>&1 | grep -c "warning")
   git checkout -
   git stash pop 2>/dev/null || true
   echo "current warnings: $CUR  main baseline: $MAIN"
   ```
   If `CUR > MAIN`, flag as "new eslint warnings added" in review — don't necessarily block, but note.

5. **DO NOT run `npx next build` locally.** Instead:
   - If you need to know "will this build?" — log the request. Contabo's next 15-min cycle will tell you.
   - If you need to validate a specific build: SSH to Contabo (`ssh root@31.220.88.124 -i ~/.ssh/id_ed25519_contabo_build`) and run build there.
   - For devops staging→main promotion routine: check Contabo's LAST build status (from tail of `/var/log/bobby-tours-builder.log`) to confirm main is buildable. If not, don't promote.

6. **Report format:**

   ```
   ## local validation — <branch> @ <short-sha>
   
   | Check | Result |
   |---|---|
   | tsc --noEmit | ✅ exit 0 |
   | eslint warnings | 47 (main: 47, no regression) ✅ |
   | next build | deferred to Contabo (cycle fires every 15 min) |
   
   Verdict: SAFE TO PROMOTE — Contabo will build within 15 min.
   ```

## Checking Contabo's last build

If you need confirmation a build succeeded on Contabo (e.g. after staging→main promotion):

```bash
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -i /root/.ssh/id_ed25519_contabo_build root@31.220.88.124 \
  "tail -20 /var/log/bobby-tours-builder.log | grep -E 'SUCCESS|FAIL|Build exit'"
```

If SSH key isn't set up to Contabo from the Paperclip VPS, flag this and request operator to set it up (or verify LIVE site via curl instead).

## Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| `tsc --noEmit` errors | TypeScript bug | Fix source; don't hide with `@ts-ignore` |
| `eslint` new warnings | New code doesn't follow style | Fix; ideally enforce zero-new-warning |
| Contabo build log shows failure | Build issue on prod-like env that didn't show locally | Read Contabo's log; might be env-specific |

## Pitfalls

- **Don't `--no-verify` the push** — hook v12 P15 scans for bypass env vars.
- `npm ci` is slow (~2 min). Skip if `package-lock.json` unchanged.
- **Don't rely on `next build` locally.** If your gate needs build output, it needs Contabo.

## Related skills

- `next-image-optimization`
- `core-web-vitals-audit`

## Budget

$0.05–0.20 per validation.
