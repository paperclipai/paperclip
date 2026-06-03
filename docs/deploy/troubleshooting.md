# Hosted deploy troubleshooting

Symptoms and fixes for ValAdrien OS on **Vercel + Supabase** (reference operator stack). Local dev issues belong in [doc/DEVELOPING.md](../../doc/DEVELOPING.md).

## Quick health checks

```sh
# Must return JSON — not HTML
curl -sS "https://YOUR_DOMAIN/api/health"

# Preview vs production: confirm which deployment Vercel serves on the custom domain
npx vercel ls
npx vercel env ls
```

| Symptom | Likely cause |
| ------- | ------------- |
| `Unexpected token '<'` in browser / API client | `/api/*` is serving SPA `index.html` instead of hitting the serverless handler, or API crashed and Vercel returned an error page |
| `FUNCTION_INVOCATION_FAILED` on Vercel | Uncaught exception during cold start (often DB connection) |
| `getaddrinfo ENOTFOUND db.xxxx.supabase.co` | Direct Supabase DB host used on **IPv4-only** Vercel |
| `500` on signup / auth | Wrong `BETTER_AUTH_*` / `VALADRIEN_OS_*_URL` vs browser origin |
| Migrations never apply | Missing `DATABASE_MIGRATION_URL` while `VALADRIEN_OS_MIGRATION_AUTO_APPLY=true` |
| Empty board after “success” | Connected to wrong/empty database or migrations failed silently — check Vercel function logs |

---

## ENOTFOUND on `db.[ref].supabase.co`

### Cause

Supabase **direct** connection strings use host `db.[PROJECT-REF].supabase.co`. On many projects that hostname resolves to **IPv6 only** (no IPv4 `A` record). **Vercel serverless functions use IPv4 only**, so DNS lookup fails with:

```text
getaddrinfo ENOTFOUND db.nzbwmlvxnzfhqaznyggw.supabase.co
```

The project is not deleted — the **connection mode** is wrong for Vercel.

### Fix

In Vercel → Project → Settings → Environment Variables, set pooler URLs from Supabase **Connect → ORMs / Drizzle** (Transaction + Session pooler):

```text
DATABASE_URL=postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres

DATABASE_MIGRATION_URL=postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

- Replace `[REGION]` with the project region (e.g. `us-west-2` for West US / Oregon).
- User must be `postgres.[PROJECT-REF]`, not bare `postgres`, on pooler hosts.
- Keep the same database password; only host, port, and username format change.

Redeploy (or trigger a new deployment) after saving env vars.

### Verify from your laptop

```sh
dig +short A db.[PROJECT-REF].supabase.co          # often empty on free tier
dig +short A aws-0-[REGION].pooler.supabase.com  # should return IPv4
```

---

## `Unexpected token '<'` / API returns HTML

### Cause

1. **Rewrite misconfiguration** — SPA fallback catches `/api/*` before the API route (see `vercel.json`: `/api/` must be excluded from the UI rewrite).
2. **Custom domain points at a broken deployment** — Production promotion without a working `DATABASE_URL` still serves static UI; `/api/health` may fail or return HTML error pages.
3. **Client calls wrong origin** — UI built with wrong `VALADRIEN_OS_API_URL` hits the static host only.

### Fix

1. Confirm `vercel.json` routes `/api/*` to the serverless entry (`api/index.mjs`).
2. `curl -i https://YOUR_DOMAIN/api/health` — `Content-Type` should be `application/json`.
3. Align `VALADRIEN_OS_API_URL` and `VALADRIEN_OS_AUTH_PUBLIC_BASE_URL` with the browser URL (including `https://`).
4. Fix underlying API crash (usually database — see above), then redeploy.

---

## `FUNCTION_INVOCATION_FAILED`

### Cause

The serverless function threw before returning a response. Common on first request after deploy:

- Invalid or unreachable `DATABASE_URL`
- Migration failure when `VALADRIEN_OS_MIGRATION_AUTO_APPLY=true`
- Missing required env in `authenticated` + `public` mode (see [environment-variables.md](./environment-variables.md))

### Fix

1. Vercel → Deployments → select deployment → **Functions** / **Runtime Logs**.
2. Fix env vars (pooler URLs, secrets, public URLs).
3. For migration errors, use `DATABASE_MIGRATION_URL` on port **5432** (session pooler), not port 6543.
4. Redeploy after env changes.

---

## Auth / signup failures on public URL

### Checklist

| Variable | Must match |
| -------- | ---------- |
| `VALADRIEN_OS_DEPLOYMENT_MODE` | `authenticated` |
| `VALADRIEN_OS_DEPLOYMENT_EXPOSURE` | `public` |
| `VALADRIEN_OS_API_URL` | Exact public origin (no trailing path) |
| `VALADRIEN_OS_AUTH_PUBLIC_BASE_URL` | Same as API URL |
| `BETTER_AUTH_SECRET` | Set (32+ bytes); never commit |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Includes production domain and preview URL if testing previews |

First human signup on an empty database becomes **instance admin** (“first user wins”).

---

## Wrong or empty database

### Cause

- `DATABASE_URL` still points at an **archived** Supabase project from a legacy fork.
- Preview and Production use **different** env var values.
- Migrations did not run (`VALADRIEN_OS_MIGRATION_AUTO_APPLY` false or migration URL missing).

### Fix

1. Confirm Supabase project ref in the connection string matches the active **valadrien-os** project.
2. Set `VALADRIEN_OS_MIGRATION_AUTO_APPLY=true` and `DATABASE_MIGRATION_URL` for fresh projects.
3. Inspect logs for migration errors on cold start.
4. See [doc/DATABASE.md](../../doc/DATABASE.md) for migration workflow.

---

## Preview works, production custom domain does not

### Cause

Custom domain may target **Production** while fixes were only deployed to **Preview**, or Production env vars differ from Preview.

### Fix

1. `npx vercel env ls` — compare Preview vs Production for `DATABASE_URL` and auth vars.
2. Promote a known-good preview deployment or merge to the production branch.
3. Re-test `curl https://os.valadrien.dev/api/health` after promotion.

---

## Related docs

- [Host walkthrough](../../doc/plans/2026-06-02-host-valadrien-vercel-supabase-walkthrough.md)
- [Database setup](./database.md)
- [Environment variables](./environment-variables.md)
- [Architecture — hosted topology](../../Architecture.md#14-hosted-reference-topology-vercel--supabase)
- [doc/DATABASE.md](../../doc/DATABASE.md)
