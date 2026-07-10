# Smoke Lab — hands-on tutorial

A guided, click-by-click walkthrough of the Smoke Lab for a person sitting at the
board. You'll turn on the experimental flag, start the deterministic fixture
services, drive every integration path (P1–P7) through its full governed
lifecycle, and read the results in the matrix and the dashboard card. **Nothing
here touches a real vendor or a real credential** — the OAuth provider and the
MCP servers are local fakes.

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
2. Find **Smoke Lab** and toggle it **on**.
3. **You should see:** the toggle stays on after a refresh.

---

## 2. Open the Smoke Lab and start the services

1. Go to **Apps → Advanced → Smoke Lab** (`/{PREFIX}/apps/advanced/smoke-lab`).
2. **You should see:** the *Smoke Lab* header with an **Experimental** badge, a
   *Fixture services* section, an empty *Integration matrix*, and an empty *Runs*
   list. A dashed card shows the **fake OAuth demo credentials**:
   - email: `smoke@paperclip.test`
   - password: `smoke-password`
3. Click **Start services**.
   **You should see:** two service cards flip to a green **running** dot — the
   *Fake OAuth 2.0 provider* and the *HTTP MCP fixture* — each with a `127.0.0.1`
   URL.
4. Click **Install fixture apps**.
   **You should see:** a toast *"Fixture apps installed"*. Two connections are now
   installed: a **remote HTTP** fixture (used by P1, P2, P5, P6, P7) and a **local
   stdio** fixture (used by P3, P4). Installing again is safe — it's idempotent.

> If **Start services** errors with a `403`, re-check §0 — you're on a `public`
> (internet-facing) instance. Any private instance works, including the everyday
> authenticated dev server.

---

## 3. The lifecycle you'll exercise on every path

Each path P1–P7 walks the same seven-step governed lifecycle. You drive it from a
fixture connection's tabs: **Setup**, **Test**, **Review**, **Activity**
(`/{PREFIX}/apps/{connectionId}/{tab}`).

| Step | What you do | What you should see |
|---|---|---|
| **connect** | Open the fixture connection (for P1, complete the fake OAuth consent). | Connection shows as active/connected. |
| **discover-catalog** | Open **Setup**. | The tool catalog lists the path's tools (e.g. `todo.list`). |
| **allowed-read** | **Test** tab → run the read tool. | Decision badge **Allowed**; the call returns without error. |
| **ask-first-write** | **Test** tab → run the write tool (with a *require-approval* policy in force). | Decision **Ask first**; a pending request appears in **Review**. |
| **approve** | **Review** tab → approve the pending write. | The request clears; the call completes. |
| **denied-call** | **Test** tab → run the blocked tool (with a *block* policy in force). | Decision **Off**; the call is refused with a reason. |
| **schema-change / quarantine** | Trigger the fixture schema flip (HTTP paths). | **Review** shows a **quarantine** pill with the changed entries held back. |
| **revoke** | **Setup** → disable the connection (or revoke the gateway session for P6). | The connection goes inactive; a revoked token is cut off (401). |
| **audit-evidence** | **Activity** tab. | Audit rows for the allowed, approved, denied, quarantine, and revoke decisions. |

The per-path tools are:

| | read (allowed) | write (ask-first) | denied | schema-flip (quarantine) |
|---|---|---|---|---|
| **HTTP** (P1, P2, P5, P6, P7) | `todo.list` | `todo.add` | `email.send` | `fixture.schemaFlip` |
| **stdio** (P3, P4) | `time.now` | `slow.ping` | `crash.now` | `malicious.metadata` |

---

## 4. Path P1 — Remote HTTP MCP, OAuth (the worked example)

This is the richest path — do it by hand once and the rest are variations.

1. **Connect via the fake OAuth provider.**
   - From **Apps** (`/{PREFIX}/apps`), open the **HTTP fixture** connection, go to
     **Setup**, and start its OAuth connect. The fake provider's **real consent
     page** opens — a page clearly headed *"Smoke OAuth"* / *"SMOKE TEST — not a
     real provider"*.
   - The **email is pre-filled** (`smoke@paperclip.test`). Type the password
     `smoke-password` and submit.
   - **You should see:** the provider accepts the credentials and redirects back
     with an authorization `code` (the redirect target is a dead loopback callback
     — that's expected; the point is the consent succeeded). Wrong credentials are
     rejected with a `403`.
2. **Discover the catalog.** On **Setup**, confirm `todo.list` and `todo.add`
   appear in the tool list.
3. **Allowed read.** **Test** tab → pick the smoke test agent → run **`todo.list`**.
   **You should see:** an **Allowed** badge and a result with no error.
4. **Ask-first write → approve.** With a *require-approval* policy on `todo.add`,
   run **`todo.add`** from the **Test** tab. **You should see:** an **Ask first**
   badge and a **pending** request. Switch to the **Review** tab and **approve**
   it. **You should see:** the request clears and the write completes.
5. **Denied call.** With a *block* policy on `email.send`, run **`email.send`**.
   **You should see:** an **Off** badge and a refusal carrying a reason code.
6. **Schema change → quarantine.** Trigger the fixture's `fixture.schemaFlip` (it
   changes a tool's schema) and refresh the catalog. **You should see:** the
   **Review** tab surfaces a **quarantine** pill — the changed entries are held
   back until you explicitly turn them on.
7. **Revoke.** On **Setup**, **disable** the connection. **You should see:** it
   goes inactive. (Re-enable it to continue.)
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
- **P3 — Local stdio MCP template.** Entry via **Apps → Advanced**. Uses the
  **stdio** fixture and its tools (`time.now`, `slow.ping`, `crash.now`). The read
  is `time.now`; the "denied" tool `crash.now` is blocked by policy. Quarantine
  evidence is recorded via fixture metadata rather than an HTTP schema flip.
- **P4 — Plugin-provided integration.** Exercises the catalog-backed **app install**
  path a plugin would use, over the stdio fixture. Same stdio tools as P3.
  **You should see:** Activity rows record the install + lifecycle decisions.
- **P5 — Paste-a-config / run-your-own import.** Entry via **Apps → Advanced**;
  import the HTTP fixture through the advanced configuration surface, then run the
  same HTTP lifecycle. **You should see:** advanced Activity rows show the import
  and the governed calls.
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

1. Back on **Apps → Advanced → Smoke Lab**, look at the **Integration matrix**.
2. **You should see:** a row per path P1–P7 and a column per lifecycle stage, with
   a glyph per cell: **✓ pass** (green), **✗ fail** (red), **– skipped** (amber),
   and a dot for **not run**. A health dot (green/amber/red) summarizes the
   selected run, and any failing paths are listed next to it.
3. Click a run in the **Runs** list to drill into its **steps**. Each recorded step
   shows its status, a one-line detail, its duration, and — when present — a
   **View screenshot** link (for P1 this includes the typed OAuth consent page).

---

## 7. Run the automated browser smoke (optional but recommended)

Rather than click all seven paths by hand, let the agent-driven runner do it and
read the evidence:

1. On the Smoke Lab tab, click **Run browser smoke now** to open a run, **or** run
   the reference driver from a shell (it types the demo credentials into the real
   consent page for you):
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
   *"All paths passing"* when green, or the failing paths when not. It's the
   at-a-glance health signal; the Smoke Lab tab is the drill-down.

---

## 10. Clean up

- Click **Reset** on the Smoke Lab tab to clear runs and fixture state.
- Click **Stop** to stop the fixture services.
- If you booted a throwaway instance for §0, stop it (`Ctrl-C`) — its embedded
  database is disposable.

That's the whole loop: flag on → services up → fixtures installed → drive/observe
the P1–P7 lifecycle → read the matrix and the dashboard card.
