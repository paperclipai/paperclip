# Walkthrough: Put ValAdrien OS on the web with Railway (step by step)

**Who this is for:** You want a real URL in the browser so your Mac is not running the database and dev server. You already have a **Railway** account. You do **not** need to know how to code to follow this; you only click in websites, copy text, and paste into boxes.

**What you will have at the end:** A link like `https://something.up.railway.app` where you can log in and use ValAdrien OS. Your data lives on Railway’s servers (Postgres + app), not on your laptop’s disk for day‑to‑day use.

**Important:** These steps use **only** Railway + GitHub in the browser. Anything that must happen *inside* your company account (first login, onboarding wizard) you do yourself after the app opens.

---

## Before you start (checklist)

Do these once before Step 1:

1. **Browser:** Use Chrome or Safari (latest).
2. **GitHub:** Your `valadrien-os` code is pushed to GitHub on the branch you want to deploy (for example `rebrand/valadrien-os` or `main`). You need permission to connect that repo to Railway.
3. **Password manager:** Have 1Password, Bitwarden, Apple Passwords, or a notes doc you trust — you will save **three** long secrets and must not lose them (especially the secrets master key + auth secret).

---

## Part A — Railway project and database

### Step A1 — Open Railway and start a new project

1. Go to **https://railway.app** and sign in.
2. Click **“New project”** (or **“+ New Project”**).
3. Choose **“Empty project”** (we will add pieces ourselves so you know what each part does).
4. Name the project something clear, e.g. **ValAdrien OS production** — click the project name at the top to rename if needed.

**Stop here:** You should see an empty project with no services yet.

---

### Step A2 — Add PostgreSQL (this is your “real” database)

Railway will host Postgres for you. You do **not** need Supabase for this path; Supabase is only another website that also sells Postgres. Railway Postgres is enough.

1. In your empty Railway project, click **“+ New”** or **“Create”** (wording varies).
2. Choose **“Database”** → **“Add PostgreSQL”** (or **“PostgreSQL”**).
3. Wait until the database shows as **running** (green or “Active”).

**Stop here:** You should see one service named like **Postgres**.

---

### Step A3 — Find the database password string Railway created (you will plug it in later)

You do not need to memorize SQL. You only need one **connection string** Railway calls `DATABASE_URL`.

1. Click the **Postgres** service (the database you just added).
2. Open the **“Variables”** tab (or **“Connect”** / **“Data”** — Railway sometimes shows connection info there).
3. Look for a variable named **`DATABASE_URL`** (Railway often creates it automatically for Postgres).
4. If you see **“Reference”** or **“Copy”** next to it: you will use Railway’s **variable reference** from your app service in Part B — you do **not** have to copy the raw password to your clipboard if Railway lets you link services (see Step B4).

If Railway only shows separate fields (host, user, password) and not one URL:

- Write down: **host**, **port**, **database name**, **user**, **password** from the Postgres panel.
- The app expects a single line that looks like:  
  `postgresql://USER:PASSWORD@HOST:PORT/railway`  
  (Replace USER, PASSWORD, HOST, PORT with your values; keep `postgresql` at the start.)

**Save** that full line in your password manager as **“ValAdrien Railway DATABASE_URL”**.

**Stop here:** You have Postgres running and you know where `DATABASE_URL` is (or the pieces to build it).

---

## Part B — Deploy the ValAdrien OS app on Railway

### Step B1 — Add a new service from your GitHub repo

1. In the **same** Railway project (same screen as Postgres), click **“+ New”** again.
2. Choose **“GitHub Repo”** (or **“Deploy from GitHub”**).
3. If Railway asks to **install the Railway app on GitHub**, approve it and pick the **organization or user** that owns `valadrien-os`.
4. Select the repository **valadrien-os** (exact name of your fork).
5. If Railway asks for a **branch**, pick the branch you want live (example: `rebrand/valadrien-os`).
6. If Railway asks for a **root directory**, leave it **empty** (repo root) unless Railway’s docs for monorepos tell you otherwise — this repo’s `Dockerfile` is at the root.

**Stop here:** Railway should start building (you may see “Building” or logs). Do not worry if it fails once — we fix that with variables in the next steps.

---

### Step B2 — Tell Railway to use the Dockerfile

1. Click your **new app service** (not Postgres).
2. Open **“Settings”**.
3. Find **“Build”** / **“Builder”** / **“Dockerfile path”**.
4. Set it so Railway builds from the **Dockerfile at the root** of the repo (often this is automatic if Railway detected `Dockerfile`).

**Stop here:** A new deploy may start; that is normal.

---

### Step B3 — Generate two secrets on your Mac (one-time; only these commands)

You need two random secrets. Easiest safe way without coding:

**Secret 1 — for login / sessions (`BETTER_AUTH_SECRET`)**

1. Open **Terminal** on your Mac (Spotlight: type **Terminal**, press Enter).
2. Paste this **one** line and press Enter:

```sh
openssl rand -base64 48
```

3. It prints **one line** of random characters. Copy that entire line.
4. Save it in your password manager as **“ValAdrien BETTER_AUTH_SECRET”**.

**Secret 2 — for company secrets encryption (`VALADRIEN_OS_SECRETS_MASTER_KEY`)**

1. In the same Terminal window, paste this line and press Enter:

```sh
openssl rand -base64 32
```

2. Copy the printed line and save it as **“ValAdrien VALADRIEN_OS_SECRETS_MASTER_KEY”**.
3. **Critical:** If you lose this key later, encrypted secrets in the database cannot be recovered. Keep it with the same care as a bank password.

**Stop here:** You have two long strings saved; you have **not** put them in Railway yet.

---

### Step B4 — Get your public URL from Railway (you will paste it several times)

1. Click your **app** service (not Postgres).
2. Open **“Settings”** → look for **“Networking”** / **“Generate domain”** / **“Public URL”**.
3. Click to **generate a public domain** if one does not exist yet.
4. Railway shows a URL like **`https://your-service-name.up.railway.app`**.
5. Copy that full URL including `https://` and save it as **“ValAdrien public URL”**.

You will use this **same** URL in three environment variables in the next step (so cookies and login redirects work).

**Stop here:** You have one public `https://…` URL written down.

---

### Step B5 — Set environment variables on the **app** service

1. Click your **app** service (not Postgres).
2. Open the **“Variables”** tab.
3. Add each row below. **Name** must match exactly (capital letters and underscores matter).

| Variable name | What to paste as the value |
| ------------- | -------------------------- |
| `DATABASE_URL` | **Best:** In Railway, use **“Add variable reference”** (or **“Reference variable”**) and choose your **Postgres** service → `DATABASE_URL`. That way the password stays managed by Railway. **Alternative:** Paste the full `postgresql://…` line you saved in Step A3. |
| `VALADRIEN_OS_DEPLOYMENT_MODE` | `authenticated` |
| `VALADRIEN_OS_DEPLOYMENT_EXPOSURE` | `public` |
| `VALADRIEN_OS_API_URL` | Your public URL from Step B4, e.g. `https://your-service-name.up.railway.app` |
| `VALADRIEN_OS_AUTH_BASE_URL_MODE` | `explicit` |
| `VALADRIEN_OS_AUTH_PUBLIC_BASE_URL` | **Exactly the same** URL as `VALADRIEN_OS_API_URL` |
| `BETTER_AUTH_SECRET` | The long string from Secret 1 in Step B3 |
| `VALADRIEN_OS_SECRETS_MASTER_KEY` | The long string from Secret 2 in Step B3 |
| `VALADRIEN_OS_MIGRATION_AUTO_APPLY` | `true` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | **Exactly the same** URL as `VALADRIEN_OS_API_URL` (Railway’s public URL only; no extra spaces) |

Optional but recommended for clarity (overrides the image default):

| Variable name | Value |
| ------------- | ----- |
| `PORT` | `3100` |

4. After saving variables, Railway will **redeploy** the app. Wait until the deploy shows **success** (green).

**If the deploy fails:** Open **“Deployments”** → click the failed deploy → read the **red error text**. Common fixes:

- **`BETTER_AUTH_SECRET` missing** — add it again, no quotes around the value in Railway’s UI.
- **`authenticated public` database error** — `DATABASE_URL` must start with `postgresql://` or `postgres://` and point to the Railway Postgres you created.
- **Auth / URL error** — the three URLs (`VALADRIEN_OS_API_URL`, `VALADRIEN_OS_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`) must be **identical** to the URL you open in the browser.

**Stop here:** Deploy is green.

---

### Step B6 — Open the site and complete first login yourself

1. In the browser, open your **public URL** from Step B4 (the `https://…up.railway.app` link).
2. You should see the ValAdrien OS board or a **sign-in / sign-up** screen (exact screen depends on your auth setup).
3. Complete **sign up** for the **first user** on this fresh database. On this codebase, the **first user** becomes the platform admin (see `Architecture.md` §13.3 — “first user wins”).
4. After login, run the **onboarding wizard** for **ValAdrien.DEV** (or your operator company name) the same way you would locally.

**Stop here:** You are using ValAdrien OS from the web; your Mac is not running `pnpm dev` for that session.

---

## Part C — Optional: use Supabase instead of Railway Postgres

Only do this if you **prefer** Supabase’s dashboard (backups, SQL editor). You still deploy the **app** on Railway; only the database moves.

1. Go to **https://supabase.com** → sign in → **“New project”**.
2. Pick an **organization**, **project name** (e.g. `valadrien-os-prod`), **database password** (save it in your password manager).
3. Choose a **region** close to you → **Create new project** → wait until the dashboard says the project is ready.
4. In Supabase: left menu **Project Settings** (gear) → **Database**.
5. Find **“Connection string”** → choose **URI** (or “Nodejs”).
6. Copy the string. It looks like `postgresql://postgres.[ref]:[YOUR-PASSWORD]@aws-0-....pooler.supabase.com:6543/postgres`.
7. Replace `[YOUR-PASSWORD]` with the database password you saved when you created the project (Supabase often shows a placeholder).
8. In **Railway**, on your **app** service → **Variables**: set **`DATABASE_URL`** to that full string (or use Supabase’s **Session mode / direct** URL if their docs say to use port **5432** for migrations — for a first setup, one consistent URI from Supabase’s “Connection pooling” doc is usually enough if the app accepts it).

Then **remove** or **disconnect** the Railway Postgres service if you are not using it, so you are not paying for two databases by mistake.

---

## Part D — If you already had an old Railway project (management-os)

That old project is **separate**. Do **not** reuse its database for `valadrien-os` unless you are doing a deliberate migration (the salvage decision was: **no** old management-os schema into this product).

**What to do:**

1. **Create a new Railway project** following Part A (clean slate).
2. Or: add a **new Postgres** and a **new GitHub-connected service** inside a folder so it does not overwrite the old service.
3. Keep the old project stopped or archived until you no longer need it.

---

## Quick reference — variable names only

Copy this list when filling Railway:

- `DATABASE_URL`
- `VALADRIEN_OS_DEPLOYMENT_MODE` = `authenticated`
- `VALADRIEN_OS_DEPLOYMENT_EXPOSURE` = `public`
- `VALADRIEN_OS_API_URL`
- `VALADRIEN_OS_AUTH_BASE_URL_MODE` = `explicit`
- `VALADRIEN_OS_AUTH_PUBLIC_BASE_URL`
- `BETTER_AUTH_SECRET`
- `VALADRIEN_OS_SECRETS_MASTER_KEY`
- `VALADRIEN_OS_MIGRATION_AUTO_APPLY` = `true`
- `BETTER_AUTH_TRUSTED_ORIGINS`

---

## Related docs (deeper detail)

- `doc/plans/2026-06-02-valadrien-cloud-blitz-go-live.md` — gates and strategy
- `docs/deploy/overview.md` — deployment modes
- `docs/deploy/environment-variables.md` — full env list
- `docs/deploy/aws-ecs.md` — if you later move off Railway to AWS

---

## Model used

None — human-authored procedural walkthrough; env names verified against `server/src/config.ts` and auth code (2026-06-02).
