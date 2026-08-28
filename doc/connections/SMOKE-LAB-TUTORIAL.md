# Smoke Lab — hands-on tutorial

A guided, click-by-click walkthrough of the Smoke Lab for a person sitting at the
board. You'll turn on the experimental flag, start the deterministic fixture
services, drive every integration path (P1–P7) through its full governed
lifecycle, and read the results in the matrix and the dashboard card. **Nothing
here touches a real vendor or a real credential** — the OAuth provider and the
MCP servers are local fakes.

Every "You should see" below was checked against the real screens; where a
button or label is quoted, that's the exact text in the product.

> Companion docs: the automated counterparts live in
> [`SMOKE-LAB-BROWSER-RUNNER.md`](./SMOKE-LAB-BROWSER-RUNNER.md) (the agent-driven
> browser runner) and `tests/e2e/smoke-lab.spec.ts` (the headless CI mirror). The
> daily recurring routine that runs the browser smoke for you is described in
> [§8](#8-the-daily-routine-hands-off).

---

## 0. Prerequisite: any private (non-public) instance

The Smoke Lab **fail-closes** on public deployments. It runs anywhere else — you do
**not** need a special `local_trusted` box or any extra environment variables.
Turning on the flag is all the setup there is.

| Requirement | Where |
|---|---|
| `Smoke Lab` experimental flag ON | Instance settings → Experimental |
| deployment exposure **not** `public` (i.e. not internet-facing) | how the instance was started |

That's it. The everyday dev server works as-is: a `local_trusted` localhost box, an
**`authenticated` instance behind Tailscale + login** (e.g.
`http://paperclip-dev:45439`), and a `pnpm dev` server built with
`NODE_ENV=production` are all fine — those are private, so the Smoke Lab is
available. The auth mode and the Node build target no longer matter; only public
exposure is disallowed (the fake OAuth provider and fixture sidecars must never be
reachable from the open internet).

If the flag is off you'll see the tab say *"Smoke Lab is turned off"*. If you're on a
`public` instance, API calls return `403 "Smoke lab is only available on private
(non-public) deployments"` — move to a private instance.

Throughout this tutorial, `{PREFIX}` is your company's short issue prefix (shown in
the URL bar, e.g. `PAP`). Replace it in the example paths.

---

## 1. Turn on the flag

1. Open **Instance settings → Experimental** (`/{PREFIX}/settings/experimental`).
2. Find the **Smoke Lab** card and toggle it **on**.
3. **You should see:** the toggle stays on after a refresh.

---

## 2. Open the Smoke Lab and start the services

1. In the left sidebar open **Apps**, then under the **Developer** section
   ("Advanced setup for developers. Most teams never open this.") click
   **Smoke Lab** (`/{PREFIX}/apps/advanced/smoke-lab`). The breadcrumb reads
   *Apps → Advanced setup → Smoke Lab*.
2. **You should see:** a *Developer tools* page header, then the **Smoke Lab**
   section with an **Experimental** badge and a **Hands-on tutorial** link, a
   *Fixture services* row with four buttons — **Start services**, **Stop**,
   **Install fixture apps**, **Reset** — an *Integration matrix* (all cells
   "not run" at first), and a *Runs* panel ("no runs yet"). A card shows the
   **Fake OAuth demo credentials**:
   - email: `smoke@paperclip.test`
   - password: `smoke-password`
3. Click **Start services**.
   **You should see:** two service cards flip to a green **running** dot:
   - **Fake OAuth 2.0 provider** — its URL is on the instance's own host
     (`…/api/companies/{companyId}/smoke-lab/oauth/authorize`); the provider runs
     in-process, so there is no separate port.
   - **HTTP MCP fixture** — a loopback sidecar with a `http://127.0.0.1:<port>/mcp`
     URL.
4. Click **Install fixture apps**.
   **You should see:** a toast — *"Fixture apps installed"* the first time,
   *"Fixture apps already present"* on a re-run (installing again is safe; it's
   idempotent). Two connections now exist under **Apps → Connections**:
   - **Smoke Lab HTTP MCP fixture** — remote HTTP transport, used by P1, P2, P5,
     P6, P7. This is the one with the OAuth walkthrough.
   - **Smoke Lab stdio MCP fixture** — local stdio transport, used by P3, P4.
     **No OAuth here** — stdio servers are spawned locally and don't sign in to
     anything.

> **Which fixture am I in?** The Connections list shows both, and the stdio one
> may be listed first. If you open a fixture's **Setup** tab and there is no
> **Connect with Smoke OAuth** card — only the "Agents can use this app" toggle —
> you're in the **stdio** fixture. Go back and open **Smoke Lab HTTP MCP
> fixture** for the OAuth steps.

> If **Start services** errors with a `403`, re-check §0 — you're on a `public`
> (internet-facing) instance. Any private instance works, including the everyday
> authenticated dev server.

---

## 3. The lifecycle you'll exercise on every path

Each path P1–P7 walks the same governed lifecycle. You drive it from a fixture
connection's pages — a small left-hand menu inside the app with **Setup**,
**Review**, **Permissions**, **Activity**, **Test**, and **Advanced**
(`/{PREFIX}/apps/{connectionId}/{tab}`).

Two things to know before you start:

- **Actions are listed by their display title**, with the raw tool name behind
  them — e.g. `todo.list` renders as **List synthetic todos**. The table below
  gives both.
- **"Policies" are the per-action dropdowns on the Permissions tab.** Each action
  is **Off**, **Allowed**, or **Ask a human first**. When a step below says "with
  a require-approval policy in force", that means: set that action's dropdown to
  **Ask a human first**. "Block policy" means set it to **Off**. Fresh installs
  start conservative, so check the dropdown before running a step.

| Step | What you do | What you should see |
|---|---|---|
| **connect** | Open the fixture connection (for P1, complete the fake OAuth consent). | Connection shows **Connected**, with the action count. |
| **discover-catalog** | Open **Permissions**. | The action list includes the path's tools (e.g. **List synthetic todos**). |
| **allowed-read** | Set the read action to **Allowed**, then run it from the **Test** tab. | Decision badge **Allowed**; the call returns without error. |
| **ask-first-write** | Set the write action to **Ask a human first**, then run it from **Test**. | Decision **Ask first**; a pending request appears in **Review**. |
| **approve** | **Review** tab → approve the pending write. | The request clears; the call completes. |
| **denied-call** | Set the blocked action to **Off**, then run it from **Test**. | Decision **Off**; the call is refused with a reason. |
| **schema-change / quarantine** | Trigger the fixture schema flip (HTTP paths), then **Refresh actions** on Permissions. | A **quarantine** pill with the changed entries held back. |
| **revoke** | **Setup** → turn off the **"Agents can use this app"** toggle (or revoke the gateway session for P6). | The connection is paused; a revoked token is cut off (401). |
| **audit-evidence** | **Activity** tab. | Audit rows for the allowed, approved, denied, quarantine, and revoke decisions. |

(The results matrix in §6 folds **approve** into its *Ask-first write* column, so
the matrix shows 8 columns for these 9 steps.)

The per-path tools are:

| | read (allowed) | write (ask-first) | denied | schema-flip (quarantine) |
|---|---|---|---|---|
| **HTTP** (P1, P2, P5, P6, P7) | `todo.list` — *List synthetic todos* | `todo.add` — *Add synthetic todo* | `email.send` — *Send outbox email* | `fixture.schemaFlip` — *Fixture schema mutation* |
| **stdio** (P3, P4) | `time.now` — *Deterministic time* | `slow.ping` — *Slow stdio fixture* | `crash.now` — *Crashing stdio fixture* | `malicious.metadata` — *Malicious metadata fixture* |

---

## 4. Path P1 — Remote HTTP MCP, OAuth (the worked example)

This is the richest path — do it by hand once and the rest are variations.

1. **Connect via the fake OAuth provider.**
   - From **Apps → Connections** (`/{PREFIX}/apps`), open **Smoke Lab HTTP MCP
     fixture** (not the stdio one — see the callout in §2), then choose **Setup**.
   - **You should see:** a **Connect with Smoke OAuth** card ("Open the provider's
     consent page to finish connecting this app.") with a **Connect with Smoke
     OAuth** button. If someone already connected it, the card reads **Connected
     with Smoke OAuth** with a **Reconnect** button instead — Reconnect walks the
     same flow.
   - Click it. The fake provider's **real consent page** opens: a brown banner
     *"SMOKE TEST - not a real provider"*, headed *"Paperclip Smoke OAuth login +
     consent"*.
   - The **email is pre-filled** (`smoke@paperclip.test`). Type the password
     `smoke-password` and click **Authorize smoke test app**.
   - **You should see:** the provider accepts the credentials and returns you to
     this connection's **Setup** tab with the card now reading **Connected with
     Smoke OAuth**. Wrong credentials are rejected with a `403`.
2. **Discover the catalog.** Open **Permissions** and confirm **List synthetic
   todos** (`todo.list`) and **Add synthetic todo** (`todo.add`) appear under
   *Action permissions*.
3. **Allowed read.** Make sure **List synthetic todos** is set to **Allowed** in
   Permissions. Then on the **Test** tab, pick an agent in the **Test as** picker
   and run **List synthetic todos**. **You should see:** an **Allowed** badge and
   a result with no error.
4. **Ask-first write → approve.** In Permissions, set **Add synthetic todo** to
   **Ask a human first**. Run it from the **Test** tab. **You should see:** an
   **Ask first** badge and a **pending** request. Switch to the **Review** tab
   (its idle state says "Nothing is waiting for your OK right now") and
   **approve** it. **You should see:** the request clears and the write completes.
5. **Denied call.** In Permissions, set **Send outbox email** (`email.send`) to
   **Off**, then run it from **Test**. **You should see:** an **Off** badge and a
   refusal carrying a reason code.
6. **Schema change → quarantine.** Run **Fixture schema mutation**
   (`fixture.schemaFlip`) — it changes a tool's schema — then click **Refresh
   actions** on the **Permissions** tab. **You should see:** a **quarantine**
   pill (on Review and Permissions) — the changed entries are held back until you
   explicitly turn them on.
7. **Revoke.** On **Setup**, turn off the **"Agents can use this app"** toggle.
   **You should see:** the app is paused for every agent. (Turn it back on to
   continue.)
8. **Audit evidence.** **Activity** tab. **You should see:** rows for each decision
   above (allowed, approved, denied, quarantine, revoke).

> Prefer not to click all seven by hand? Use the automated browser smoke — §7 —
> which performs exactly these steps and leaves you screenshots to read, including
> a shot of the filled OAuth consent page.

---

## 5. Paths P2–P7 — what's different

Each path reuses the §3 lifecycle. Only the connect/transport and a couple of
tools change.

- **P2 — Remote HTTP MCP, API key.** Same HTTP fixture and tools as P1, but the
  connection is authenticated with a static fixture credential instead of OAuth.
  **You should see:** audit rows preserve the decisions **without** ever exposing
  the credential value.
- **P3 — Local stdio MCP template.** Uses the **Smoke Lab stdio MCP fixture**
  connection and its tools (see the stdio row in §3's table). The read is
  **Deterministic time** (`time.now`); the "denied" tool **Crashing stdio
  fixture** (`crash.now`) is blocked by policy. Its **Setup** tab has no OAuth
  card — just the "Agents can use this app" toggle. Quarantine evidence is
  recorded via fixture metadata rather than an HTTP schema flip.
- **P4 — Plugin-provided integration.** Exercises the catalog-backed **app install**
  path a plugin would use, over the stdio fixture. Same stdio tools as P3.
  **You should see:** Activity rows record the install + lifecycle decisions.
- **P5 — Paste-a-config / run-your-own import.** Entry via the **Developer**
  section of Apps; import the HTTP fixture through the advanced configuration
  surface, then run the same HTTP lifecycle. **You should see:** advanced
  Activity rows show the import and the governed calls.
- **P6 — Token broker / gateway session.** Create a **run-scoped gateway session**
  for the smoke agent, list tools through the session token, then **revoke** the
  session. **You should see:** the token lists tools before revoke and is **cut
  off (401)** after. Entry/evidence via **Activity**.
- **P7 — Governance surfaces.** Entry via **Review**. This path is about the
  governance surfaces themselves — profiles, ask-first policies, block policies,
  and quarantine. **You should see:** Review and Activity expose the ask-first,
  block, quarantine, and revoke evidence together.

---

## 6. Read the results matrix

1. Back on **Apps → Developer → Smoke Lab**, look at the **Integration matrix**.
2. **You should see:** a row per path (*P1 Remote HTTP · OAuth* … *P7 Governance
   surfaces*) and a column per lifecycle stage — **Connect**, **Discover
   catalog**, **Allowed read**, **Ask-first write**, **Denied call**,
   **Schema-change quarantine**, **Revoke**, **Audit evidence** — with a glyph
   per cell: **✓ pass** (green), **✗ fail** (red), **– skipped** (amber), and a
   dot for **not run**. A health dot (green/amber/red) summarizes the selected
   run, and any failing paths are listed next to it.
3. Click a run in the **Runs** list to drill into its **steps**. Each recorded step
   shows its status, a one-line detail, its duration, and — when present — a
   **View screenshot** link (for P1 this includes the typed OAuth consent page).

---

## 7. Run the automated browser smoke (optional but recommended)

Rather than click all seven paths by hand, let the agent-driven runner do it and
read the evidence:

1. In the **Runs** panel of the Smoke Lab tab, click **Run browser smoke now** to
   open a run, **or** run the reference driver from a shell (it types the demo
   credentials into the real consent page for you):
   ```bash
   SMOKE_BASE=http://127.0.0.1:3251 \
     node --experimental-strip-types tests/e2e/smoke-lab-browser-runner.mts
   # SMOKE_ONLY=P1,P3 restricts to a subset; omit for the full P1–P7 sweep.
   ```
2. **You should see:** the matrix fills in green as each step is recorded, every
   step carrying a viewable screenshot, and a new entry in the **Runs** list.

---

## 8. The daily routine (hands-off)

A recurring Paperclip routine — **"Daily Smoke Lab integration smoke (P1-P7)"** —
runs the browser smoke for you every day and:

- **records** each run to the results API (matrix + dashboard);
- on a real **failure**, files a `high`-priority issue with the failing step and a
  screenshot, assigned to the owning coder, and links it back to the run;
- when the flag is off or the instance is unreachable, records an **amber/skipped**
  run instead of failing silently.

It's driven by `tests/e2e/smoke-lab-routine.mts`. See that file's header and the
routine's own description for the runbook.

---

## 9. Read the dashboard card

1. Open the **Dashboard** (`/{PREFIX}/dashboard`).
2. **You should see:** an **Integration smoke** card summarizing the latest run —
   *"All paths passing"* when green, the failing paths when not, or *"No runs
   yet — Run one from the Smoke Lab tab"* before the first run. It's the
   at-a-glance health signal; the Smoke Lab tab is the drill-down. Clicking the
   card takes you to the Smoke Lab.

---

## 10. Clean up

- Click **Reset** on the Smoke Lab tab to clear runs and fixture state.
- Click **Stop** to stop the fixture services.
- If you booted a throwaway instance for §0, stop it (`Ctrl-C`) — its embedded
  database is disposable.

That's the whole loop: flag on → services up → fixtures installed → drive/observe
the P1–P7 lifecycle → read the matrix and the dashboard card.
