# BrainPulse Orchestration Map Implementation Plan

**Goal:** Build a local, read-only Mission Control sidecar for BrainPulse Ventures LLC that renders a live Orchestration Map and exposes the existing bounded Paperclip operating loop without changing Paperclip state.

**Architecture:** Add a standalone Node 24.11+ sidecar under `tools/mission-control` in the existing Paperclip repository. A server-side client reads the private Paperclip API using runtime-only environment variables, normalizes non-secret summaries, and serves a static browser UI. The sidecar has no mutation routes and never persists credentials.

**Tech Stack:** Node.js 24.11+, built-in `node:http`, built-in `node:test`, browser-native HTML/CSS/JavaScript, and the existing repository Playwright installation for one focused browser smoke check.

## Global Constraints

- The sidecar is read-only: it must not mutate Paperclip state, start runs, approve work, or bypass an approval gate.
- Only non-secret summaries are returned to the browser; API keys, model credentials, cookies, and secret material never enter the response or filesystem.
- Paperclip remains the source of truth for agents, routines, runs, issues, approvals, and audit history.
- Protected work always displays an owner-approval boundary for money, production, customer data/messages, accounts, credentials, legal/compliance, public posts, and external services.
- Unknown or incomplete upstream data renders as `Unknown`; it must never be inferred as healthy or successful.
- Use the existing repository token and status conventions only if the sidecar is later embedded; the standalone sidecar may use its own scoped CSS.
- Broad regression, deployment, packaging, and release suites are not part of this plan.

---

## File map

- `tools/mission-control/package.json` — standalone scripts and Node engine declaration.
- `tools/mission-control/.env.example` — names only; no credential values.
- `tools/mission-control/src/state.mjs` — pure normalization and status derivation.
- `tools/mission-control/src/policy.mjs` — protected-action classification.
- `tools/mission-control/src/paperclip-client.mjs` — read-only API client.
- `tools/mission-control/src/server.mjs` — static file server and read-only state endpoint.
- `tools/mission-control/public/index.html` — semantic page shell and accessible regions.
- `tools/mission-control/public/app.js` — browser rendering, polling, and links to Paperclip.
- `tools/mission-control/public/styles.css` — Orchestration Map visual system.
- `tools/mission-control/test/state.test.mjs` — normalization fixtures.
- `tools/mission-control/test/policy.test.mjs` — approval-boundary fixtures.
- `tools/mission-control/test/server.test.mjs` — upstream failure and redaction tests.
- `tools/mission-control/test/browser-smoke.mjs` — focused browser smoke test.
- `tools/mission-control/README.md` — local startup, configuration, and safety boundaries.

## Task 1: Scaffold the sidecar and deterministic company-state model

**Files:**
- Create: `tools/mission-control/package.json`
- Create: `tools/mission-control/.env.example`
- Create: `tools/mission-control/src/state.mjs`
- Create: `tools/mission-control/src/policy.mjs`
- Test: `tools/mission-control/test/state.test.mjs`
- Test: `tools/mission-control/test/policy.test.mjs`

**Interfaces:**
- `normalizeCompanyState({ company, dashboard, agents, routines, issues, approvals, now }) -> CompanyState`
- `deriveLaneStatus(agent, healthByAgentId) -> "healthy" | "attention" | "blocked" | "unknown"`
- `classifyAction({ categories }) -> { protected: boolean, categories: string[] }`
- `CompanyState` contains `company`, `heartbeat`, `agents`, `routines`, `decisions`, and `timeline` with no secret fields.

- [ ] **Step 1: Write failing normalization fixtures**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCompanyState } from "../src/state.mjs";

test("normalizes an agent graph and preserves unknown upstream state", () => {
  const state = normalizeCompanyState({
    company: { id: "c1", name: "BrainPulse Ventures LLC" },
    agents: [{ id: "a1", name: "Summarizer", status: "idle" }],
    routines: [{ id: "r1", title: "Daily brief", status: "active", triggers: [] }],
    issues: [],
    approvals: [],
    dashboard: null,
    now: new Date("2026-08-31T15:00:00Z"),
  });
  assert.equal(state.company.name, "BrainPulse Ventures LLC");
  assert.equal(state.agents[0].health, "unknown");
  assert.equal(state.routines[0].status, "active");
});
```

- [ ] **Step 2: Run the fixture to verify it fails**

Run: `node --test tools/mission-control/test/state.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/state.mjs`.

- [ ] **Step 3: Implement the pure state normalizer**

```js
export function normalizeCompanyState({ company, dashboard, agents = [], routines = [], issues = [], approvals = [], now = new Date() }) {
  const knownAgents = agents.map((agent) => ({
    id: agent.id,
    name: agent.name ?? "Unknown agent",
    model: agent.adapterConfig?.model ?? agent.model ?? "Unknown",
    status: agent.status ?? "unknown",
    health: agent.health ?? "unknown",
    link: `/agents/${agent.id}`,
  }));
  return {
    company: { id: company?.id ?? null, name: company?.name ?? "BrainPulse Ventures LLC" },
    heartbeat: dashboard?.heartbeat ?? "unknown",
    agents: knownAgents,
    routines: routines.map((routine) => ({ id: routine.id, title: routine.title, status: routine.status ?? "unknown", triggers: routine.triggers ?? [], link: `/routines/${routine.id}` })),
    decisions: approvals.map((approval) => ({ id: approval.id, title: approval.title ?? "Approval required", status: approval.status ?? "unknown", protected: Boolean(approval.protected), link: `/approvals/${approval.id}` })),
    timeline: issues.slice(0, 20).map((issue) => ({ id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status ?? "unknown", link: `/issues/${issue.identifier ?? issue.id}` })),
    generatedAt: now.toISOString(),
  };
}

export function deriveLaneStatus(agent, healthByAgentId = {}) {
  return healthByAgentId[agent.id] ?? agent.health ?? "unknown";
}
```

- [ ] **Step 4: Add protected-action classification and rerun focused tests**

```js
export const PROTECTED_CATEGORIES = Object.freeze([
  "money", "production", "customer_data", "customer_messages", "accounts",
  "credentials", "legal_compliance", "public_posts", "external_services",
]);

export function classifyAction({ categories = [] } = {}) {
  const normalized = categories.filter((category) => PROTECTED_CATEGORIES.includes(category));
  return { protected: normalized.length > 0, categories: normalized };
}
```

Run: `node --test tools/mission-control/test/state.test.mjs tools/mission-control/test/policy.test.mjs`
Expected: PASS with all fixtures green.

- [ ] **Step 5: Commit the deterministic model**

```bash
git add tools/mission-control/package.json tools/mission-control/.env.example tools/mission-control/src/state.mjs tools/mission-control/src/policy.mjs tools/mission-control/test/state.test.mjs tools/mission-control/test/policy.test.mjs
git commit -m "feat(mission-control): add company state model"
```

## Task 2: Add the fail-closed Paperclip read path

**Files:**
- Create: `tools/mission-control/src/paperclip-client.mjs`
- Create: `tools/mission-control/src/server.mjs`
- Test: `tools/mission-control/test/server.test.mjs`

**Interfaces:**
- `createPaperclipClient({ baseUrl, apiKey, fetchImpl }) -> { readCompanyState(companyId) }`
- `GET /api/mission-control/state?companyId=<id>` returns `CompanyState` or a structured `503` error with no credential material.
- `GET /healthz` returns `{ "status": "ok" }` without contacting Paperclip.

- [ ] **Step 1: Write failing client/server tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createPaperclipClient } from "../src/paperclip-client.mjs";

test("client rejects upstream failures without returning authorization data", async () => {
  const client = createPaperclipClient({ baseUrl: "http://paperclip.test", apiKey: "secret", fetchImpl: async () => new Response("down", { status: 503 }) });
  await assert.rejects(() => client.readCompanyState("c1"), /Paperclip request failed: 503/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/mission-control/test/server.test.mjs`
Expected: FAIL because `../src/paperclip-client.mjs` does not exist.

- [ ] **Step 3: Implement the read-only client**

```js
import { normalizeCompanyState } from "./state.mjs";

export function createPaperclipClient({ baseUrl, apiKey, fetchImpl = fetch }) {
  async function get(path) {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`Paperclip request failed: ${response.status}`);
    return response.json();
  }
  return {
    async readCompanyState(companyId) {
      const [company, dashboard, agents, routines, issues] = await Promise.all([
        get(`/api/companies/${companyId}`),
        get(`/api/companies/${companyId}/dashboard`),
        get(`/api/companies/${companyId}/agents`),
        get(`/api/companies/${companyId}/routines`),
        get(`/api/companies/${companyId}/issues?limit=20`),
      ]);
      return normalizeCompanyState({ company, dashboard, agents, routines, issues, approvals: [] });
    },
  };
}
```

- [ ] **Step 4: Implement the fail-closed HTTP server**

The server must expose only static assets, `/healthz`, and `/api/mission-control/state`; it must return `503` with `{ error: "CONTROL_PLANE_UNAVAILABLE" }` when the upstream read fails and must never include the `authorization` header, API key, or upstream body in the response.

- [ ] **Step 5: Run focused server tests and commit**

Run: `node --test tools/mission-control/test/server.test.mjs`
Expected: PASS for success, upstream failure, health, and redaction cases.

```bash
git add tools/mission-control/src/paperclip-client.mjs tools/mission-control/src/server.mjs tools/mission-control/test/server.test.mjs
git commit -m "feat(mission-control): add fail-closed Paperclip reader"
```

## Task 3: Build the Orchestration Map browser surface

**Files:**
- Create: `tools/mission-control/public/index.html`
- Create: `tools/mission-control/public/app.js`
- Create: `tools/mission-control/public/styles.css`

**Interfaces:**
- Browser requests `/api/mission-control/state?companyId=...` every 15 seconds.
- Render functions `renderHeader`, `renderGraph`, `renderDecisionRail`, and `renderTimeline` accept only `CompanyState`.
- Links point back to the Paperclip base URL and do not create mutation actions.

- [ ] **Step 1: Create the accessible page shell**

Add landmarks with `header`, `main`, `section[aria-labelledby]`, a live status region, and empty containers for `company-header`, `agent-graph`, `decision-rail`, and `operations-timeline`. Include a visible `Read-only Mission Control` label.

- [ ] **Step 2: Add the visual system**

Use deep navy/charcoal surfaces, electric-blue activity paths, green healthy states, amber attention states, red blocked states, monospace machine values, visible focus rings, and `prefers-reduced-motion` handling. Do not use animated motion to convey critical status.

- [ ] **Step 3: Render the four zones**

Implement:

```js
export function renderHeader(state) { /* heartbeat + counts */ }
export function renderGraph(state) { /* Chief of Staff center + lane nodes */ }
export function renderDecisionRail(state) { /* approval details + protected boundary */ }
export function renderTimeline(state) { /* runs, routines, recoveries */ }
```

Each state card must display `Unknown` when the value is missing, and every event must include a source link.

- [ ] **Step 4: Add polling and fail-closed browser states**

On `503`, replace the graph with **Control plane unavailable**, keep the last timestamp visible as stale, and never display stale values as healthy. On malformed JSON, show **Unknown data** and a retry affordance that only repeats the read request.

- [ ] **Step 5: Commit the browser surface**

```bash
git add tools/mission-control/public/index.html tools/mission-control/public/app.js tools/mission-control/public/styles.css
git commit -m "feat(mission-control): add orchestration map surface"
```

## Task 4: Add local operation, focused browser proof, and handoff documentation

**Files:**
- Modify: `tools/mission-control/package.json`
- Create: `tools/mission-control/test/browser-smoke.mjs`
- Create: `tools/mission-control/README.md`

**Interfaces:**
- `npm start` launches the sidecar on `127.0.0.1:61962` by default.
- `npm test` runs only the sidecar’s deterministic tests.
- `npm run smoke:browser` runs the one browser smoke file against a local fixture server.

- [ ] **Step 1: Add scripts without adding runtime dependencies**

```json
{
  "name": "@brainpulse/mission-control",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.11.0" },
  "scripts": {
    "start": "node src/server.mjs",
    "test": "node --test test/*.test.mjs",
    "smoke:browser": "node test/browser-smoke.mjs"
  }
}
```

- [ ] **Step 2: Write the browser smoke test**

Start a fixture HTTP server that returns a fixed non-secret `CompanyState`, launch the sidecar against it, open the page with Playwright, and assert the four landmarks, legal masthead, `Read-only Mission Control`, one healthy lane, one approval card, and one source link.

- [ ] **Step 3: Run focused proof**

Run: `npm --prefix tools/mission-control test`
Expected: PASS for state, policy, and server tests.

Run: `npm --prefix tools/mission-control run smoke:browser`
Expected: PASS for the four visible zones and read-only label.

- [ ] **Step 4: Document safe startup and configuration**

README must show:

```sh
export PAPERCLIP_API_URL=http://127.0.0.1:3100
export PAPERCLIP_API_KEY='(enter at runtime; do not commit)'
export PAPERCLIP_COMPANY_ID='39f0b0b8-1f7a-4aab-b9c9-bbcadc2eb0cc'
npm start
```

It must state that the browser is read-only, credentials remain runtime-only, Paperclip routines remain the autonomy source of truth, and the sidecar must not be exposed publicly.

- [ ] **Step 5: Inspect the frozen diff and commit documentation**

Run: `git diff --check -- tools/mission-control`
Expected: no whitespace errors.

```bash
git add tools/mission-control/package.json tools/mission-control/test/browser-smoke.mjs tools/mission-control/README.md
git commit -m "docs(mission-control): document local operation and proof"
```

## Final handoff checks

- Confirm only `tools/mission-control/**` changed.
- Confirm no credential values, cookies, or secret material appear in tracked files.
- Run the focused test and browser smoke commands above.
- Run `git diff --check` on the frozen diff.
- Record any omitted broad suites as `NOT RUN — GLOBAL MINIMAL-TEST POLICY`.
- Do not deploy, publish, alter Paperclip schedules, approve work, or add a public listener as part of this plan.
