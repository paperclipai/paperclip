---
schema: agentcompanies/v1
kind: skill
name: sprint-delivery
description: >
  Skill for the Delivery Engineer. Covers Cloudflare Workers/Pages deployment steps,
  smoke test checklist, git release tagging, and sprint report format.
---

# Sprint Delivery Skill

## Overview

The Delivery Engineer ships QA-passing sprint artifacts to production within 15 minutes. This skill covers the complete deployment protocol, smoke testing, release management, and reporting.

---

## 1. Pre-Deployment Checklist

Before deploying, verify:
```
[ ] All QA eval reports at ./sprints/[sprint-id]/eval-[TASK-ID].md show PASS
[ ] All 4 criteria scored ≥6
[ ] Build succeeds locally (npm run build)
[ ] Environment variables are set in Cloudflare dashboard
[ ] wrangler.toml or pages config exists in repo
```

If the build fails locally, **do not attempt deployment**. Report the build failure back to Sprint Lead immediately.

---

## 2. Cloudflare Pages Deployment (SPA / Static)

### When to use
- React + Vite apps without server-side rendering
- Static sites (marketing pages, tools with client-side logic)

### Steps
```bash
# 1. Build
cd frontend
npm run build
# Output: dist/

# 2. Check wrangler is installed
wrangler --version
# If not: npm install -g wrangler

# 3. Authenticate (first time only)
wrangler login

# 4. Deploy
wrangler pages deploy dist/ \
  --project-name sprint-[sprint-id] \
  --branch main

# 5. Note the URL from output
# Format: https://[branch].[project].pages.dev
```

### Pages Configuration (wrangler.toml)
```toml
name = "sprint-[sprint-id]"
compatibility_date = "YYYY-MM-DD" # Use today's date (e.g., 2026-03-31)

[site]
bucket = "./dist"
```

---

## 3. Cloudflare Workers Deployment (Full-Stack / SSR)

### When to use
- Full-stack apps where the backend must run at the edge
- SSR apps (Remix, Next.js on Workers)
- API-only backends

### Steps
```bash
# 1. Build
npm run build:worker
# or: npm run build (depending on project)

# 2. Verify wrangler.toml exists with correct worker config
cat wrangler.toml

# 3. Deploy
wrangler deploy

# 4. Note the URL from output
# Format: https://[worker-name].[account].workers.dev
```

### Worker Configuration (wrangler.toml)
```toml
name = "sprint-[sprint-id]"
main = "dist/worker.js"
compatibility_date = "YYYY-MM-DD" # Use today's date (e.g., 2026-03-31)
compatibility_flags = ["nodejs_compat"]

[vars]
NODE_ENV = "production"

# If using D1 (SQLite at edge):
[[d1_databases]]
binding = "DB"
database_name = "sprint-[sprint-id]-db"
database_id = "[get from Cloudflare dashboard after creation]"
```

---

## 4. Full-Stack Deployment (Frontend Pages + Backend Workers)

### Architecture
```
Frontend (Pages)  →  Backend (Workers)  →  Database (D1 or external)
https://app.pages.dev  →  https://api.workers.dev  →  SQLite D1
```

### Steps

#### 4a. Deploy Backend First
```bash
cd backend
wrangler deploy
# Note: https://[name].workers.dev
```

#### 4b. Set Backend URL in Frontend Build
```bash
cd frontend
VITE_API_URL=https://[name].workers.dev npm run build
```

#### 4c. Deploy Frontend
```bash
wrangler pages deploy dist/ \
  --project-name sprint-[sprint-id]-frontend
```

#### 4d. Set CORS on Backend
Ensure the backend Worker allows requests from the Pages domain:
```typescript
// In your Hono/Express app
app.use('*', cors({
  origin: ['https://sprint-[sprint-id]-frontend.pages.dev', 'http://localhost:5173']
}))
```

---

## 5. Smoke Tests

Run after every deployment. Do not skip.

### Automated Checks
```bash
# Check homepage returns 200
curl -s -o /dev/null -w "%{http_code}" https://[production-url]
# Expected: 200

# Check API health (if backend)
curl -o /dev/null -w "%{http_code}" https://[api-url]/health
# Expected: 200
```

### Manual Checks (via browser)
```
[ ] Homepage loads without JS errors (check console)
[ ] Primary CTA button is visible and clickable
[ ] Complete primary user flow once (e.g., create one item, verify it appears)
[ ] No CORS errors in console
[ ] SSL certificate is valid (padlock shows)
[ ] Page loads in < 3 seconds
```

### Smoke Test Fail Protocol
If any smoke test fails:

1. **Try re-deploying** (once only)
2. If still failing, check Cloudflare dashboard for error logs
3. Common fixes:
   - Environment variables not set → Set them in Cloudflare dashboard → Redeploy
   - CORS error → Update allowed origins → Redeploy
   - 500 from Worker → Check Worker logs in Cloudflare dashboard
4. If not fixable in 5 minutes, report to Orchestrator with error details

---

## 6. Git Release Tagging

After successful deployment:

```bash
# Stage all sprint artifacts
git add -A

# Commit
git commit -m "feat: Sprint [ID] — [brief summary]

Deployed: [production-url]
Features shipped:
- [feature 1]
- [feature 2]

QA: PASS ([scores])
Sprint time: [elapsed]"

# Tag the release
git tag -a "sprint-[ID]-v1.0" -m "Sprint [ID] Release

## What shipped
- [feature 1]: [brief description]
- [feature 2]: [brief description]

## Dropped (V2)
- [feature]: [reason]

## Production
URL: [production-url]
Deploy time: [ISO timestamp]"

# Push
git push origin main
git push origin --tags
```

---

## 7. Sprint Report Format

After successful deployment, produce `sprint-report.md` and send summary to Sprint Orchestrator:

```markdown
# Sprint Report — Sprint [ID]
**Date**: [date]
**Status**: SHIPPED ✅ / PARTIAL ⚠️ / FAILED ❌

---

## Production
**URL**: [https://...]
**Type**: [Pages | Workers | Full-Stack]
**Deploy Time**: [HH:MM:SS]

---

## Features Shipped
| Feature | QA Score | Notes |
|---------|----------|-------|
| [TASK-001] [title] | [X/40] | [any notes] |
| [TASK-002] [title] | [X/40] | |

---

## Features Dropped
| Feature | V-Label | Reason |
|---------|---------|--------|
| [title] | V2 | Time — dropped at T+2:00 |
| [title] | V1 | QA failed twice — dropped by Orchestrator |

---

## Sprint Timeline
| Milestone | Time | Delta |
|-----------|------|-------|
| Brief received | 0:00 | — |
| sprint-plan.md | 0:18 | +18 min |
| task-breakdown.md | 0:35 | +17 min |
| Feature 1 → QA | 1:10 | +35 min |
| Feature 1 PASS | 1:25 | +15 min |
| Feature 2 → QA | 2:05 | +40 min |
| Feature 2 PASS | 2:20 | +15 min |
| Production live | 2:35 | +15 min |
| **Total** | **2:35** | **25 min under budget** |

---

## Git Release
**Tag**: `sprint-[ID]-v1.0`
**Commit**: `[hash]`
**Repo**: [url]

---

## Recommendations for Jeremy
[Anything notable: suggested V2 features, tech debt to revisit, things that went particularly well or poorly]
```

---

## 8. Fallback Deployment Options

If Cloudflare is unavailable or fails repeatedly:

| Option | Command | Notes |
|--------|---------|-------|
| Vercel | `npx vercel --prod` | Free tier, instant deploy |
| Railway | `railway up` | Good for full-stack |
| Render | Web UI deploy | Manual but reliable |
| GitHub Pages | `npm run deploy` | Static only, needs gh-pages package |

Always get something live. The order above is the preference order.

When using a fallback, note it in the sprint report: "Deployed to Vercel (Cloudflare fallback)" so Jeremy knows.
