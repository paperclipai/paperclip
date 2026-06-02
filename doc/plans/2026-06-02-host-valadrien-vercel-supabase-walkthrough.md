# Walkthrough: Host ValAdrien OS on the web (GitHub → Vercel → Supabase)

**Date:** 2026-06-02  
**For:** You already use **GitHub**, **Vercel**, and **Supabase**. Railway is **not** where the main board lives.

**Goal:** Open ValAdrien OS in a browser at a real URL. Your Mac does **not** run the database or the server day to day. Secrets live in **Vercel → Environment Variables**, not in a separate password app.

**Replace / ignore for the main app:** `doc/plans/2026-06-02-railway-walkthrough-host-valadrien.md` (that doc was wrong for your stack).

---

## 1. Your stack (one picture)

```text
GitHub          →  source code (valadrien-os repo)
     ↓
Vercel          →  main app URL (board + API together)
     ↓
Supabase        →  PostgreSQL only (DATABASE_URL)
     ↓
Resend          →  email later (env var in Vercel when you wire it)
     ↓
Railway         →  ONLY extras Vercel cannot run (Python libs, some agent/worker jobs)
Docker          →  build recipe in the repo; used where the host needs a container (often Railway workers, not the Vercel board)
```

| Tool | Job | You touch it when… |
| ---- | --- | ------------------ |
| **GitHub** | Stores code; Vercel deploys from here | Every push to your deploy branch |
| **Vercel** | Hosts the **main** ValAdrien OS site + env vars | Setup + adding keys in **Project → Settings → Environment Variables** |
| **Supabase** | Database only | Once to create project + copy connection string into Vercel |
| **Resend** | Sends email | Later; add API key in Vercel when agents need email |
| **Railway** | Side services (Python, long workers) | **Not** step 1. Only when a feature doc says “deploy this worker on Railway” |

**Old management-os on Vercel:** You had a Vercel project (e.g. dashboard) and Supabase elsewhere. Same idea: **new** Supabase project for **valadrien-os** schema — do **not** point at the old archived Supabase.

---

## 2. What you do vs what coding work may still be needed

**You can do today (browser + one Terminal paste):**

1. Create Supabase project → copy `DATABASE_URL`
2. Create/connect Vercel project to GitHub → paste env vars in Vercel
3. Deploy → open URL → sign up → onboard ValAdrien.DEV

**Honest note about this repo:** ValAdrien OS is **one Node server** (Express API + built UI). The repo has a **Dockerfile** and **no `vercel.json` yet**. Vercel may need a small **deployment config commit** on GitHub before “Import project” succeeds. If the first deploy fails with “no output” or “build failed”, that is a **repo fix**, not something wrong with Supabase. Section 6 below says what to tell the agent.

---

## Part A — Supabase (database only)

### Step A1 — Create the project

1. Open **https://supabase.com** and sign in.
2. Click **New project** (or **New organization** first if Supabase asks).
3. Fill in:
   - **Name:** `valadrien-os-prod` (or any name you will recognize)
   - **Database password:** click **Generate a password** → **copy it immediately** → paste it into a temporary note on your Mac (you will use it once in the next step; long term it lives only inside the connection string in **Vercel**)
   - **Region:** pick the region closest to you (e.g. US East if you are on the US East Coast)
4. Click **Create new project**.
5. Wait until the dashboard stops saying “Setting up project” (can take 1–2 minutes).

**Stop here:** You see the Supabase project dashboard (left sidebar: Table Editor, SQL, etc.).

---

### Step A2 — Copy the database URL (this becomes `DATABASE_URL` in Vercel)

1. In Supabase, click **Project Settings** (gear icon, bottom of left sidebar).
2. Click **Database**.
3. Scroll to **Connection string**.
4. Open the **URI** tab (sometimes labeled **Connection string** → mode **URI**).
5. You will see a line like:
   `postgresql://postgres.[something]:[YOUR-PASSWORD]@aws-0-....supabase.co:6543/postgres`
6. **Replace** the text `[YOUR-PASSWORD]` with the database password you saved in Step A1.  
   The result is one long line starting with `postgresql://` — that is your **`DATABASE_URL`**.
7. Keep that line in your temporary note until Step B4 (you will paste it into Vercel).

**Stop here:** You have one full `postgresql://…` line copied. You do **not** need Supabase for anything else right now (no tables to create by hand — the app runs migrations on startup when configured).

---

## Part B — Vercel (main app + all env vars)

### Step B1 — Connect GitHub to Vercel (if not already)

1. Open **https://vercel.com** and sign in.
2. If GitHub is not connected: **Account Settings → GitHub → Connect** and allow Vercel to see your repos.

**Stop here:** Vercel can list your GitHub repositories.

---

### Step B2 — Create the Vercel project from your repo

1. On Vercel dashboard, click **Add New… → Project**.
2. Find **`valadrien-os`** (your fork, e.g. under `ValDola-stack` or your user).
3. Click **Import**.
4. **Framework Preset:** if Vercel guesses “Other” or “Vite”, that is OK for now.
5. **Root Directory:** leave as **`.`** (repository root) unless your team uses a subfolder (default for this repo is root).
6. **Build Command / Output Directory:** leave as Vercel suggests for the first try; we may adjust after a failed deploy (Section 6).
7. **Do not deploy yet** if Vercel shows an “Environment Variables” section on this screen — go to Step B3 first, then come back and click **Deploy**.  
   If Vercel only offers **Deploy** now, continue to B3, then add variables and **Redeploy**.

**Stop here:** Project exists in Vercel (even if first deploy fails — that is normal until env vars + build config are right).

---

### Step B3 — Generate two secrets on your Mac (paste into Vercel, not 1Password)

Vercel will store these. You only need Terminal for **random strings**, not for hosting the app.

1. Open **Terminal** on your Mac.
2. Run this and copy the **one line** it prints:

```sh
openssl rand -base64 48
```

3. Label that value in your head as **`BETTER_AUTH_SECRET`** (for login sessions).

4. Run this and copy the **one line** it prints:

```sh
openssl rand -base64 32
```

5. Label that value as **`VALADRIEN_OS_SECRETS_MASTER_KEY`** (encrypts company secrets in the DB). **Do not lose this** after it is in Vercel — if you delete it from Vercel and the DB has encrypted data, that data is gone.

**Stop here:** Two random strings in your temporary note, plus the `DATABASE_URL` from Part A.

---

### Step B4 — Add environment variables in Vercel

1. In Vercel, open your **valadrien-os** project.
2. Go to **Settings → Environment Variables**.
3. For **each row below**, click **Add**:
   - **Key** = exact name in the first column
   - **Value** = what the second column says
   - **Environment** = check **Production** (and **Preview** too if you want preview deploys to work the same way)

| Key (copy exactly) | Value |
| ------------------ | ----- |
| `DATABASE_URL` | The full `postgresql://…` line from Step A2 |
| `VALADRIEN_OS_DEPLOYMENT_MODE` | `authenticated` |
| `VALADRIEN_OS_DEPLOYMENT_EXPOSURE` | `public` |
| `VALADRIEN_OS_API_URL` | Leave empty for now — fill in Step B5 after you know the URL |
| `VALADRIEN_OS_AUTH_BASE_URL_MODE` | `explicit` |
| `VALADRIEN_OS_AUTH_PUBLIC_BASE_URL` | Leave empty for now — same as B5 |
| `BETTER_AUTH_SECRET` | The string from B3 (first `openssl` command) |
| `VALADRIEN_OS_SECRETS_MASTER_KEY` | The string from B3 (second `openssl` command) |
| `VALADRIEN_OS_MIGRATION_AUTO_APPLY` | `true` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Leave empty for now — same URL as B5 |

4. Click **Save** after each variable (or add all then save, depending on Vercel UI).

**Stop here:** All variables except the three URL-related ones are set.

---

### Step B5 — Deploy, get your public URL, finish the three URL variables

1. Go to **Deployments** tab → click **Redeploy** on the latest (or trigger **Deploy** from **Git** if nothing ran yet).
2. Wait for the deployment.  
   - **If it succeeds:** open **Visit** / the `.vercel.app` link. Copy that full URL including `https://`.
   - **If it fails:** skip to **Section 6** (do not fight Supabase — fix build/deploy first).
3. Go back to **Settings → Environment Variables**.
4. Set these **three** to the **exact same** URL (your `https://….vercel.app` or custom domain):

| Key | Value |
| --- | ----- |
| `VALADRIEN_OS_API_URL` | `https://YOUR-PROJECT.vercel.app` |
| `VALADRIEN_OS_AUTH_PUBLIC_BASE_URL` | same |
| `BETTER_AUTH_TRUSTED_ORIGINS` | same |

5. **Redeploy** again so the running app picks up the URL variables.

**Stop here:** Deployment green, URL opens in browser (login page or board).

---

### Step B6 — Custom domain (optional, e.g. `os.valadrien.dev`)

1. Vercel project → **Settings → Domains**.
2. Add **`os.valadrien.dev`** (or your chosen hostname).
3. Vercel shows **DNS records** (usually a CNAME). In your DNS provider (where `valadrien.dev` is managed), add that record.
4. When Vercel shows the domain as **Valid**, update the **three URL env vars** in B5 to `https://os.valadrien.dev` and **Redeploy**.

**Stop here:** You can use either `.vercel.app` or your custom domain consistently in all three URL variables.

---

### Step B7 — First use (only you can do this in the browser)

1. Open your public URL in Chrome/Safari.
2. **Sign up** with the first account on this fresh database. That account becomes platform admin (“first user wins”).
3. Run the **onboarding wizard** for **ValAdrien.DEV** (company name, optional website / founder links).
4. Confirm infra entitlements exist: in the app or via API, managed company should show postgres / email / llm / hosting / worker as **entitled** (no need to “buy Supabase” in approvals).

**Stop here:** You are on the web stack; close `pnpm dev` on your Mac for normal use.

---

## Part C — Resend (later, not blocking URL)

When agents need outbound email:

1. **https://resend.com** → API key.
2. Vercel → **Settings → Environment Variables** → add `RESEND_API_KEY` (and any from-address vars your setup uses).
3. Redeploy.

No separate vault — same Vercel env screen as everything else.

---

## Part D — Railway (only when Vercel is the wrong tool)

**Do not** put the main ValAdrien OS board on Railway if your standard is GitHub + Vercel + Supabase.

Use Railway when **documentation or a feature** says you need:

- Python libraries or scripts Vercel will not run
- Long-running **worker** processes separate from the control plane
- Agent-side jobs that are not the Express server in this repo

Typical pattern:

```text
Browser → Vercel (valadrien-os) → Supabase
              ↘
               Railway (optional worker) → same Supabase or separate queue
```

Add Railway **after** Part B works. Create a **new Railway service** only for that worker repo/folder — not a second copy of the whole OS.

---

## Section 6 — If Vercel deploy fails (what it means, what to ask for)

Common messages:

| What you see | Meaning | What to do |
| ------------ | ------- | ---------- |
| Build failed / no output directory | Vercel does not know how to build this monorepo server | Ask in chat: **“Add Vercel deployment config for valadrien-os (Express + ui build)”** — that is a **GitHub commit**, not a Supabase change |
| Crashes on start: `DATABASE_URL` | Env var missing or wrong password in URI | Re-check Step A2 and B4 |
| Crashes: `BETTER_AUTH_SECRET` | Missing auth secret | Re-check B3 and B4 |
| Crashes: `authenticated public` + database | `DATABASE_URL` must be real Postgres (`postgresql://…`) | Must be Supabase URI, not empty |
| Login redirect loop | URL env vars mismatch | All three URL keys in B5 must match the URL in the browser bar exactly |

**Do not** move the main app to Railway just because Vercel failed once — fix deploy config or use Vercel’s **Docker/container** option for this repo if your Vercel plan supports it (same env vars from Part B).

---

## Checklist (tick in order)

- [ ] **A1–A2** Supabase project `valadrien-os-prod` + `DATABASE_URL` copied
- [ ] **B1–B2** Vercel project imported from GitHub `valadrien-os`
- [ ] **B3** Two `openssl` secrets generated
- [ ] **B4** Env vars in Vercel (except three URLs)
- [ ] **B5** Deploy OK + three URL vars set + redeploy
- [ ] **B6** (Optional) Custom domain + update three URLs
- [ ] **B7** First signup + ValAdrien.DEV onboarding
- [ ] **C** Resend when needed
- [ ] **D** Railway only for a named worker, not the board

---

## Related docs

- `doc/plans/2026-06-02-valadrien-cloud-blitz-go-live.md` — go/no-go gates (strategy)
- `doc/plans/2026-06-01-valadrien-cloud-managed-infra.md` — ValAdrien Cloud entitlements
- `docs/deploy/environment-variables.md` — full env reference
- `docs/deploy/database.md` — Supabase connection notes

---

## Model used

None — human-authored procedural walkthrough aligned to operator stack (GitHub / Vercel / Supabase); env names verified against `server/src/config.ts` (2026-06-02).
