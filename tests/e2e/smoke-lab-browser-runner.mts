/**
 * Smoke Lab agent-driven browser runner (PAP-13350 / plan §D4 item 1).
 *
 * This is the reference implementation the `smoke-lab-browser-runner` runbook
 * points at: a QA agent drives a REAL browser through the P1-P7 Smoke Lab
 * lifecycle against a live local_trusted instance, typing demo credentials into
 * the fake OAuth consent page, and posts every step + a viewable screenshot to
 * the S1 results API so the run lands in the Smoke Lab UI + dashboard card.
 *
 * It deliberately imports the S4 catalog as the single source of truth for the
 * scenario/step list (do NOT fork the step list).
 *
 * Run:
 *   node --experimental-strip-types tests/e2e/smoke-lab-browser-runner.mts
 * Env (all optional except a reachable BASE):
 *   SMOKE_BASE=http://127.0.0.1:3211   target local_trusted, non-prod instance
 *   SMOKE_COMPANY_ID=<uuid>            reuse a company (else creates one)
 *   SMOKE_SHOT_DIR=/tmp/pap13350-shots screenshot output dir
 *   SMOKE_ONLY=P1,P3                   restrict to a subset of catalog paths
 *                                      (budget-bounding for the daily D5 routine;
 *                                      selects scenarios, does NOT fork the steps)
 *   SMOKE_TRIGGER=manual|ci|routine    smoke_run trigger (default "manual")
 *   SMOKE_CHROMIUM_PATH=/path/to/chromium optional browser executable override
 *   SMOKE_FORCE_FAIL=<detail>          inject one synthetic failing step on the
 *                                      first scenario — the canonical self-test for
 *                                      the §D5 routine's file-on-failure wiring.
 */
import { promises as fs } from "node:fs";
import { chromium } from "playwright";
import { ciSmokeLabScenarios } from "./smoke-lab.catalog.ts";

const BASE = (process.env.SMOKE_BASE ?? "http://127.0.0.1:3211").replace(/\/$/, "");
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? "/tmp/pap13350-shots";
const CHROMIUM_PATH = process.env.SMOKE_CHROMIUM_PATH?.trim() || null;
const DEMO_EMAIL = "smoke@paperclip.test";
const DEMO_PASSWORD = "smoke-password";
const ONLY = (process.env.SMOKE_ONLY ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const TRIGGER = process.env.SMOKE_TRIGGER ?? "manual";

type Json = Record<string, any>;

function assert(cond: any, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function api(method: string, path: string, body?: Json): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function uploadShot(companyId: string, file: string): Promise<string> {
  const buf = await fs.readFile(file);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/png" }), file.split("/").pop());
  form.append("namespace", "smoke-lab");
  const res = await fetch(`${BASE}/api/companies/${companyId}/assets/images`, {
    method: "POST",
    headers: { origin: BASE },
    body: form as any,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`asset upload failed ${res.status}: ${text.slice(0, 200)}`);
  const j = text ? JSON.parse(text) : {};
  return `${BASE}${j.contentPath}`;
}

async function main() {
  await fs.mkdir(SHOT_DIR, { recursive: true });

  // Company + scout
  let companyId = process.env.SMOKE_COMPANY_ID ?? "";
  let prefix = "";
  if (!companyId) {
    const co = await api("POST", "/api/companies", { name: `Smoke Lab Browser Run ${Date.now()}` });
    companyId = co.id;
    prefix = co.issuePrefix ?? co.urlKey ?? "SMO";
  } else {
    const list = await api("GET", "/api/companies");
    const co = (Array.isArray(list) ? list : list.companies ?? []).find((c: Json) => c.id === companyId);
    prefix = co?.issuePrefix ?? co?.urlKey ?? "SMO";
  }
  await api("PATCH", "/api/instance/settings/experimental", { enableSmokeLab: true });
  const scout = await api("POST", `/api/companies/${companyId}/agents`, {
    name: `Smoke Scout ${Date.now()}`, role: "qa", title: "Smoke Lab scout",
    capabilities: "Runs deterministic Smoke Lab fixture calls.",
    adapterType: "process", adapterConfig: { command: "node", args: ["-e", "setTimeout(()=>{},1000)"] },
  });
  console.log(`company=${companyId} prefix=${prefix} scout=${scout.id}`);

  const scenarios = ONLY.length
    ? ciSmokeLabScenarios.filter((s) => ONLY.includes(s.path))
    : ciSmokeLabScenarios;
  assert(scenarios.length, `SMOKE_ONLY=${ONLY.join(",")} matched no catalog paths`);

  const run = (await api("POST", `/api/companies/${companyId}/smoke-lab/runs`, {
    trigger: TRIGGER,
    summary: { catalog: "tests/e2e/smoke-lab.catalog.ts", driver: "agent-browser (real chromium)", track: "D4 agent-driven browser", scenarioCount: scenarios.length, only: ONLY.length ? ONLY : undefined },
  })).run;
  console.log(`smoke_run=${run.id}`);

  const browser = await chromium.launch({
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    headless: true,
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const failed: string[] = [];

  const shot = async (scenario: Json, step: string) => {
    const file = `${SHOT_DIR}/${scenario.path.toLowerCase()}-${step}.png`;
    await page.screenshot({ path: file, fullPage: true });
    return await uploadShot(companyId, file);
  };
  const record = async (scenario: Json, step: string, status: string, detail: string | null, url: string | null, ms: number) => {
    await api("POST", `/api/companies/${companyId}/smoke-lab/runs/${run.id}/steps`, {
      path: scenario.path, scenarioStep: step, status, detail,
      screenshotArtifactRef: url ? { kind: "agent_browser_screenshot", url } : null,
      durationMs: ms,
    });
  };
  const doStep = async (scenario: Json, step: string, action: () => Promise<string | null | undefined>) => {
    const t0 = Date.now();
    try {
      const hint = await action();
      const url = await shot(scenario, step);
      await record(scenario, step, "pass", hint ?? null, url, Date.now() - t0);
      console.log(`  ${scenario.path}/${step} PASS`);
    } catch (e: any) {
      let url: string | null = null;
      try { url = await shot(scenario, `${step}-failed`); } catch {}
      await record(scenario, step, "fail", e?.message ?? String(e), url, Date.now() - t0).catch(() => {});
      failed.push(`${scenario.path}/${step}: ${e?.message ?? e}`);
      console.log(`  ${scenario.path}/${step} FAIL: ${e?.message ?? e}`);
    }
  };

  const gotoUI = async (scenario: Json, connId: string) => {
    const p = scenario.uiEntryPath;
    if (p === "advanced") await page.goto(`${BASE}/${prefix}/apps/advanced`, { waitUntil: "networkidle" });
    else if (p === "review") await page.goto(`${BASE}/${prefix}/apps/${connId}/review`, { waitUntil: "networkidle" });
    else if (p === "activity") await page.goto(`${BASE}/${prefix}/apps/${connId}/activity`, { waitUntil: "networkidle" });
    else if (p === "attention") await page.goto(`${BASE}/${prefix}/apps/attention`, { waitUntil: "networkidle" });
    else await page.goto(`${BASE}/${prefix}/apps/${connId}`, { waitUntil: "networkidle" });
  };

  const auditHit = async (connId: string, search: string) => {
    const a = await api("GET", `/api/tool-gateway/audit?companyId=${companyId}&app=${connId}&agent=${scout.id}&search=${encodeURIComponent(search)}&limit=50`);
    assert((a.events?.length ?? 0) > 0, `audit row for ${search}`);
  };

  for (const scenario of scenarios) {
    console.log(`--- ${scenario.path}: ${scenario.title} ---`);
    // Fixtures (board UI action; idempotent). Start services then install.
    const services = (await api("POST", `/api/companies/${companyId}/smoke-lab/services/start`)).services;
    const oauthUrl = services.find((s: Json) => s.id === "fake-oauth")?.url as string;
    const fx = await api("POST", `/api/companies/${companyId}/smoke-lab/install-fixtures`);
    const preferStdio = scenario.transport === "local_stdio" || scenario.transport === "plugin";
    const wantTransport = preferStdio ? "local_stdio" : "mcp_remote";
    const conn = fx.connections.find((c: Json) => c.transport === wantTransport);
    assert(conn, `${wantTransport} connection for ${scenario.path}`);

    // connect
    await doStep(scenario, "connect", async () => {
      if (scenario.authMode === "oauth") {
        // REAL BROWSER: fake OAuth login + consent page, type demo credentials.
        const authorize = `${oauthUrl}?client_id=smoke-client&redirect_uri=${encodeURIComponent("http://127.0.0.1/callback")}&scope=${encodeURIComponent("smoke:openid smoke:profile smoke:email")}&state=smoke-state&response_type=code`;
        await page.goto(authorize, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: /Smoke OAuth/i }).waitFor({ timeout: 15_000 });
        await page.fill('input[name="email"]', DEMO_EMAIL);
        await page.fill('input[name="password"]', DEMO_PASSWORD);
        // Screenshot the filled consent page as evidence before submit.
        const consentUrl = await shot(scenario, "connect-consent");
        await record(scenario, "connect-consent", "pass", `Typed demo creds ${DEMO_EMAIL} into fake OAuth consent page`, consentUrl, 0);
        // Submit consent; capture the 302 to prove the fake provider accepted the
        // demo creds (redirect target is a dead loopback callback that never loads).
        const [resp] = await Promise.all([
          page.waitForResponse((r: any) => r.url().includes("/smoke-lab/oauth/authorize") && r.request().method() === "POST", { timeout: 12_000 }),
          page.click('button[type="submit"]'),
        ]);
        const loc = resp.headers()["location"] ?? "";
        assert(resp.status() === 302 && /[?&]code=/.test(loc), `OAuth consent accepted creds → 302 with code (status ${resp.status()}, location ${loc.slice(0, 80)})`);
        // The 302 target is a dead loopback callback; let that failed navigation
        // commit (chrome-error page) before navigating into the Paperclip UI.
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(800);
        await gotoUI(scenario, conn.id);
        return `${scenario.lifecycle.connect} (typed demo creds into consent page; provider issued code via 302)`;
      }
      await gotoUI(scenario, conn.id);
      return scenario.lifecycle.connect;
    });

    // discover-catalog
    await doStep(scenario, "discover-catalog", async () => {
      const cat = await api("GET", `/api/tool-connections/${conn.id}/catalog`);
      const names = (cat.catalog ?? []).map((e: Json) => e.toolName);
      assert(names.includes(scenario.lifecycle.allowedRead.name), `catalog has ${scenario.lifecycle.allowedRead.name}`);
      await gotoUI(scenario, conn.id);
      return `${scenario.lifecycle.discoverCatalog}: ${names.length} entries`;
    });

    // allowed-read
    await doStep(scenario, "allowed-read", async () => {
      const read = await api("POST", `/api/tool-connections/${conn.id}/test-calls`, {
        agentId: scout.id, toolName: scenario.lifecycle.allowedRead.name, parameters: scenario.lifecycle.allowedRead.parameters,
      });
      assert(read.decision === "allowed", `allowed-read decision=${read.decision}`);
      assert(!read.error, "allowed-read no error");
      await auditHit(conn.id, scenario.lifecycle.allowedRead.name);
      await page.goto(`${BASE}/${prefix}/apps/${conn.id}/activity`, { waitUntil: "networkidle" });
      return `Allowed read ${scenario.lifecycle.allowedRead.name}`;
    });

    // ask-first-write-approved
    await doStep(scenario, "ask-first-write-approved", async () => {
      await api("POST", `/api/companies/${companyId}/tools/policies`, {
        name: `${scenario.path} require approval ${Date.now()}`, policyType: "require_approval", priority: 10,
        selectors: { connectionId: conn.id, toolNames: [scenario.lifecycle.askFirstWrite.name] },
      });
      const pending = await api("POST", `/api/tool-connections/${conn.id}/test-calls`, {
        agentId: scout.id, toolName: scenario.lifecycle.askFirstWrite.name, parameters: scenario.lifecycle.askFirstWrite.parameters,
      });
      assert(pending.decision === "ask_first", `ask-first decision=${pending.decision}`);
      assert(pending.actionRequestId, "ask-first has actionRequestId");
      await page.goto(`${BASE}/${prefix}/apps/${conn.id}/review`, { waitUntil: "networkidle" });
      await api("POST", `/api/tool-gateway/action-requests/${pending.actionRequestId}/approve`, { companyId });
      let approved = false;
      for (let i = 0; i < 40; i++) {
        const st = await api("GET", `/api/tool-connections/${conn.id}/test-calls/${pending.actionRequestId}`);
        if (st.phase === "done") {
          approved = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert(approved, `Timed out waiting for test-call ${pending.actionRequestId} phase done`);
      return `Approved ask-first call ${scenario.lifecycle.askFirstWrite.name}`;
    });

    // denied-blocked-call
    await doStep(scenario, "denied-blocked-call", async () => {
      await api("POST", `/api/companies/${companyId}/tools/policies`, {
        name: `${scenario.path} block ${Date.now()}`, policyType: "block", priority: 1,
        selectors: { connectionId: conn.id, toolNames: [scenario.lifecycle.deniedCall.name] },
      });
      const denied = await api("POST", `/api/tool-connections/${conn.id}/test-calls`, {
        agentId: scout.id, toolName: scenario.lifecycle.deniedCall.name, parameters: scenario.lifecycle.deniedCall.parameters,
      });
      assert(denied.decision === "off", `denied decision=${denied.decision}`);
      assert(denied.error?.reasonCode, "denied has reasonCode");
      await page.goto(`${BASE}/${prefix}/apps/${conn.id}/review`, { waitUntil: "networkidle" });
      return `Blocked call ${scenario.lifecycle.deniedCall.name}: ${denied.error?.reasonCode}`;
    });

    // schema-change-quarantine
    await doStep(scenario, "schema-change-quarantine", async () => {
      if (conn.transport !== "mcp_remote") {
        await page.goto(`${BASE}/${prefix}/apps/${conn.id}/activity`, { waitUntil: "networkidle" });
        return "Non-HTTP path records governance/quarantine evidence through fixture metadata.";
      }
      await api("PATCH", `/api/tool-connections/${conn.id}`, { config: { ...(conn.config ?? {}), quarantineNewEntries: true } });
      await api("POST", `/api/companies/${companyId}/tools/policies`, {
        name: `${scenario.path} allow schema flip ${Date.now()}`, policyType: "allow", priority: 5,
        selectors: { connectionId: conn.id, toolNames: [scenario.lifecycle.schemaChangeQuarantine.name] },
      });
      const flipped = await api("POST", `/api/tool-connections/${conn.id}/test-calls`, {
        agentId: scout.id, toolName: scenario.lifecycle.schemaChangeQuarantine.name, parameters: scenario.lifecycle.schemaChangeQuarantine.parameters,
      });
      assert(flipped.decision === "allowed", `schema-flip decision=${flipped.decision}`);
      const refresh = await api("POST", `/api/tool-connections/${conn.id}/catalog/refresh`);
      assert((refresh.quarantinedCount ?? 0) > 0, `quarantinedCount=${refresh.quarantinedCount}`);
      await page.goto(`${BASE}/${prefix}/apps/attention`, { waitUntil: "networkidle" });
      return `Catalog refresh quarantined ${refresh.quarantinedCount} changed entries.`;
    });

    // revoke
    await doStep(scenario, "revoke", async () => {
      if (scenario.transport === "gateway_session") {
        const invoked = await api("POST", `/api/agents/${scout.id}/heartbeat/invoke`);
        const session = await api("POST", "/api/tool-gateway/sessions", { companyId, agentId: scout.id, runId: invoked.id, ttlMs: 60_000 });
        const listRes = await fetch(`${BASE}${new URL(session.toolsUrl, BASE).pathname}`, { headers: { "x-paperclip-tool-gateway-token": session.token } });
        assert(listRes.ok, "gateway tools list ok pre-revoke");
        await api("POST", `/api/tool-gateway/sessions/${session.sessionId}/revoke`, { companyId });
        const after = await fetch(`${BASE}${new URL(session.toolsUrl, BASE).pathname}`, { headers: { "x-paperclip-tool-gateway-token": session.token } });
        assert(after.status === 401, `revoked token cut off (got ${after.status})`);
        await page.goto(`${BASE}/${prefix}/apps/${conn.id}/activity`, { waitUntil: "networkidle" });
        return scenario.lifecycle.revoke;
      }
      const disabled = await api("PATCH", `/api/tool-connections/${conn.id}`, { enabled: false });
      assert(disabled.enabled === false, "connection disabled");
      await page.goto(`${BASE}/${prefix}/apps/${conn.id}`, { waitUntil: "networkidle" });
      await api("PATCH", `/api/tool-connections/${conn.id}`, { enabled: true });
      return scenario.lifecycle.revoke;
    });

    // audit-evidence
    await doStep(scenario, "audit-evidence", async () => {
      await auditHit(conn.id, scenario.lifecycle.allowedRead.name);
      await page.goto(`${BASE}/${prefix}/apps/${conn.id}/activity`, { waitUntil: "networkidle" });
      return scenario.lifecycle.auditEvidence;
    });
  }

  // Optional injected failure — the canonical self-test for the §D5 routine's
  // file-on-failure wiring. Records a real fail step + screenshot so the wrapper
  // sees exit 2 + a `<path>-<step>-failed.png` to attach.
  if (process.env.SMOKE_FORCE_FAIL) {
    const target = scenarios[0];
    await doStep(target, "forced-failure", async () => {
      throw new Error(`SMOKE_FORCE_FAIL: ${process.env.SMOKE_FORCE_FAIL}`);
    });
  }

  // Finalize run + capture the run in the live Smoke Lab UI.
  await api("PATCH", `/api/companies/${companyId}/smoke-lab/runs/${run.id}`, {
    status: failed.length ? "failed" : "passed",
    summary: { catalog: "tests/e2e/smoke-lab.catalog.ts", driver: "agent-browser (real chromium)", scenarioCount: scenarios.length, only: ONLY.length ? ONLY : undefined, failed },
  });
  await page.goto(`${BASE}/${prefix}/apps/advanced/smoke-lab`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const tabFile = `${SHOT_DIR}/zz-smoke-lab-tab.png`;
  await page.screenshot({ path: tabFile, fullPage: true });
  await page.goto(`${BASE}/${prefix}/dashboard`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const dashFile = `${SHOT_DIR}/zz-dashboard-card.png`;
  await page.screenshot({ path: dashFile, fullPage: true });

  await browser.close();

  const finalRun = await api("GET", `/api/companies/${companyId}/smoke-lab/runs/${run.id}`);
  const steps = finalRun.steps ?? [];
  const byPath: Record<string, number> = {};
  for (const s of steps) byPath[s.path] = (byPath[s.path] ?? 0) + 1;
  console.log("\n=== RESULT ===");
  console.log(`companyId=${companyId} prefix=${prefix} runId=${run.id} status=${finalRun.run?.status}`);
  console.log(`steps=${steps.length} perPath=${JSON.stringify(byPath)} failed=${failed.length}`);
  console.log(`withScreenshot=${steps.filter((s: Json) => s.screenshotArtifactRef?.url).length}/${steps.length}`);
  console.log(`tabShot=${tabFile} dashShot=${dashFile}`);
  await fs.writeFile(`${SHOT_DIR}/result.json`, JSON.stringify({ companyId, prefix, runId: run.id, status: finalRun.run?.status, steps: steps.length, byPath, failed }, null, 2));
  if (failed.length) process.exitCode = 2;
}

main().catch((e) => { console.error("RUNNER ERROR", e); process.exit(1); });
