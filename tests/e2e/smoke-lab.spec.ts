import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ciSmokeLabScenarios, type SmokeLabLifecycleTool, type SmokeLabScenario, type SmokeRunStepPath } from "./smoke-lab.catalog";

type SmokeRunStepStatus = "pass" | "fail" | "skipped";

const SCREENSHOT_DIR = "test-results/smoke-lab";

type Json = Record<string, unknown>;
type Seed = { companyId: string; prefix: string };
type Scout = { id: string; name: string };
type SmokeRun = { id: string; status: string };
type SmokeRunStepResult = {
  step: { id: string; status: SmokeRunStepStatus };
  summary: Record<string, unknown>;
};
type ToolConnection = {
  id: string;
  name: string;
  transport: "mcp_remote" | "local_stdio";
  applicationId: string;
  enabled: boolean;
  status?: string;
  config?: Record<string, unknown> | null;
};
type ToolCatalogEntry = {
  id: string;
  toolName: string;
  name: string;
  riskLevel?: string | null;
  status?: string | null;
};
type FixtureInstall = {
  connections: ToolConnection[];
  catalog: ToolCatalogEntry[];
};
type TestCallResult = {
  decision: "allowed" | "ask_first" | "off";
  invocationId: string;
  actionRequestId?: string;
  error?: { reasonCode?: string | null; message: string };
};
type GatewaySession = {
  sessionId: string;
  token: string;
  toolsUrl: string;
  callUrl: string;
};

async function json<T = Json>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} failed ${response.status()}: ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function expectError(response: Awaited<ReturnType<APIRequestContext["get"]>>, status: number) {
  const body = await response.text();
  expect(response.status(), `${response.url()} expected ${status}, got ${response.status()}: ${body}`).toBe(status);
  return body;
}

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const body = await json<{ id: string; issuePrefix?: string; prefix?: string; urlKey?: string }>(
    await request.post("/api/companies", { data: { name: `Smoke Lab ${label} ${Date.now()}` } }),
  );
  return { companyId: body.id, prefix: body.issuePrefix ?? body.prefix ?? body.urlKey ?? "E2E" };
}

async function createScout(request: APIRequestContext, companyId: string): Promise<Scout> {
  const body = await json<{ id: string; name: string }>(
    await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name: `Smoke Scout ${Date.now()}`,
        role: "qa",
        title: "Smoke Lab scout",
        capabilities: "Runs deterministic Smoke Lab fixture calls.",
        adapterType: "process",
        adapterConfig: { command: "node", args: ["-e", "setTimeout(() => {}, 1000)"] },
      },
    }),
  );
  return { id: body.id, name: body.name };
}

async function enableSmokeLab(request: APIRequestContext) {
  await json(await request.patch("/api/instance/settings/experimental", { data: { enableSmokeLab: true, enableApps: true } }));
}

async function createSmokeRun(request: APIRequestContext, companyId: string) {
  const result = await json<{ run: SmokeRun }>(
    await request.post(`/api/companies/${companyId}/smoke-lab/runs`, {
      data: {
        trigger: "ci",
        summary: {
          catalog: "tests/e2e/smoke-lab.catalog.ts",
          scenarioCount: ciSmokeLabScenarios.length,
        },
      },
    }),
  );
  return result.run;
}

async function updateSmokeRun(
  request: APIRequestContext,
  companyId: string,
  runId: string,
  status: "passed" | "failed",
  summary: Json,
) {
  await json(await request.patch(`/api/companies/${companyId}/smoke-lab/runs/${runId}`, {
    data: { status, summary },
  }));
}

async function recordStep(
  request: APIRequestContext,
  companyId: string,
  runId: string,
  input: {
    path: SmokeRunStepPath;
    scenarioStep: string;
    status: SmokeRunStepStatus;
    detail?: string | null;
    screenshotPath?: string | null;
    durationMs?: number | null;
  },
): Promise<SmokeRunStepResult> {
  return await json<SmokeRunStepResult>(
    await request.post(`/api/companies/${companyId}/smoke-lab/runs/${runId}/steps`, {
      data: {
        path: input.path,
        scenarioStep: input.scenarioStep,
        status: input.status,
        detail: input.detail ?? null,
        screenshotArtifactRef: input.screenshotPath
          ? { kind: "playwright_screenshot", path: input.screenshotPath }
          : null,
        durationMs: input.durationMs ?? null,
      },
    }),
  );
}

async function screenshot(page: Page, scenario: SmokeLabScenario, step: string) {
  const path = `${SCREENSHOT_DIR}/${scenario.path.toLowerCase()}-${step}.png`;
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function navigateForEvidence(page: Page, seed: Seed, connectionId: string, scenario: SmokeLabScenario) {
  if (scenario.uiEntryPath === "advanced") {
    await page.goto(`/${seed.prefix}/apps/advanced`);
    await expect(page.getByRole("heading", { name: "Advanced setup" })).toBeVisible({ timeout: 20_000 });
    return;
  }
  if (scenario.uiEntryPath === "review") {
    await page.goto(`/${seed.prefix}/apps/${connectionId}/review`);
    await expect(page.getByText(/Nothing is waiting for your OK|new actions? (need|to) review/i).first()).toBeVisible({ timeout: 20_000 });
    return;
  }
  if (scenario.uiEntryPath === "activity") {
    await page.goto(`/${seed.prefix}/apps/${connectionId}/activity`);
    await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible({ timeout: 20_000 });
    return;
  }
  if (scenario.uiEntryPath === "attention") {
    await page.goto(`/${seed.prefix}/apps`);
    await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible({ timeout: 20_000 });
    return;
  }
  await page.goto(`/${seed.prefix}/apps/${connectionId}`);
  await expect(page.getByRole("heading", { name: /Smoke Lab/i }).first()).toBeVisible({ timeout: 30_000 });
}

async function runRecordedStep(
  page: Page,
  request: APIRequestContext,
  seed: Seed,
  runId: string,
  scenario: SmokeLabScenario,
  step: string,
  action: () => Promise<string | null | undefined>,
) {
  const start = Date.now();
  try {
    const screenshotHint = await action();
    const screenshotPath = await screenshot(page, scenario, step);
    await recordStep(request, seed.companyId, runId, {
      path: scenario.path,
      scenarioStep: step,
      status: "pass",
      detail: screenshotHint ?? null,
      screenshotPath,
      durationMs: Date.now() - start,
    });
  } catch (error) {
    const screenshotPath = await screenshot(page, scenario, `${step}-failed`).catch(() => null);
    await recordStep(request, seed.companyId, runId, {
      path: scenario.path,
      scenarioStep: step,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      screenshotPath,
      durationMs: Date.now() - start,
    }).catch(() => undefined);
    throw error;
  }
}

async function startAndInstallFixtures(request: APIRequestContext, companyId: string): Promise<FixtureInstall> {
  await json(await request.post(`/api/companies/${companyId}/smoke-lab/services/start`));
  return await json<FixtureInstall>(await request.post(`/api/companies/${companyId}/smoke-lab/install-fixtures`));
}

function connectionForScenario(fixtures: FixtureInstall, scenario: SmokeLabScenario): ToolConnection {
  const preferStdio = scenario.transport === "local_stdio" || scenario.transport === "plugin";
  const transport = preferStdio ? "local_stdio" : "mcp_remote";
  const connection = fixtures.connections.find((candidate) => candidate.transport === transport);
  if (!connection) throw new Error(`Missing ${transport} fixture connection for ${scenario.path}`);
  return connection;
}

async function catalog(request: APIRequestContext, connectionId: string) {
  return await json<{ catalog: ToolCatalogEntry[] }>(await request.get(`/api/tool-connections/${connectionId}/catalog`));
}

async function testCall(
  request: APIRequestContext,
  connectionId: string,
  scout: Scout,
  tool: SmokeLabLifecycleTool,
) {
  return await json<TestCallResult>(
    await request.post(`/api/tool-connections/${connectionId}/test-calls`, {
      data: { agentId: scout.id, toolName: tool.name, parameters: tool.parameters },
    }),
  );
}

async function policy(
  request: APIRequestContext,
  companyId: string,
  body: {
    name: string;
    policyType: "allow" | "block" | "require_approval";
    priority: number;
    selectors: Record<string, unknown>;
  },
) {
  return await json<{ id: string }>(await request.post(`/api/companies/${companyId}/tools/policies`, { data: body }));
}

async function approveActionRequest(request: APIRequestContext, companyId: string, actionRequestId: string) {
  await json(await request.post(`/api/tool-gateway/action-requests/${actionRequestId}/approve`, {
    data: { companyId },
  }));
}

async function pollTestCall(
  request: APIRequestContext,
  connectionId: string,
  actionRequestId: string,
  expectedPhase: string,
) {
  for (let i = 0; i < 40; i += 1) {
    const status = await json<{ phase: string }>(
      await request.get(`/api/tool-connections/${connectionId}/test-calls/${actionRequestId}`),
    );
    if (status.phase === expectedPhase) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for test-call ${actionRequestId} phase ${expectedPhase}`);
}

async function expectAuditEvent(
  request: APIRequestContext,
  companyId: string,
  options: { connectionId: string; agentId: string; search: string },
) {
  const audit = await json<{ events: Array<Json> }>(
    await request.get(
      `/api/tool-gateway/audit?companyId=${companyId}&app=${options.connectionId}&agent=${options.agentId}&search=${encodeURIComponent(options.search)}&limit=50`,
    ),
  );
  expect(audit.events.length, `expected audit/activity row matching ${options.search}`).toBeGreaterThan(0);
}

async function createGatewaySession(request: APIRequestContext, companyId: string, scout: Scout): Promise<GatewaySession> {
  const invoked = await json<{ id: string }>(await request.post(`/api/agents/${scout.id}/heartbeat/invoke`));
  return await json<GatewaySession>(
    await request.post("/api/tool-gateway/sessions", {
      data: { companyId, agentId: scout.id, runId: invoked.id, ttlMs: 60_000 },
    }),
  );
}

async function gatewayFetch(request: APIRequestContext, path: string, token: string, data?: Json) {
  const headers = { "x-paperclip-tool-gateway-token": token };
  if (data) return await request.post(path, { headers, data });
  return await request.get(path, { headers });
}

test.describe.serial("Smoke Lab scenario catalog mirror", () => {
  test.setTimeout(240_000);

  test("records the P1-P7 CI-safe Smoke Lab lifecycle into the results API @smoke-lab", async ({ page, request }) => {
    const seed = await newCompany(request, "catalog");
    const scout = await createScout(request, seed.companyId);
    await enableSmokeLab(request);
    const smokeRun = await createSmokeRun(request, seed.companyId);
    const failed: string[] = [];

    try {
      for (const scenario of ciSmokeLabScenarios) {
        const fixtures = await startAndInstallFixtures(request, seed.companyId);
        const connection = connectionForScenario(fixtures, scenario);

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "connect", async () => {
          await navigateForEvidence(page, seed, connection.id, scenario);
          return scenario.lifecycle.connect;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "discover-catalog", async () => {
          const discovered = await catalog(request, connection.id);
          expect(discovered.catalog.map((entry) => entry.toolName)).toContain(scenario.lifecycle.allowedRead.name);
          await navigateForEvidence(page, seed, connection.id, scenario);
          return `${scenario.lifecycle.discoverCatalog}: ${discovered.catalog.length} entries`;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "allowed-read", async () => {
          const read = await testCall(request, connection.id, scout, scenario.lifecycle.allowedRead);
          expect(read.decision).toBe("allowed");
          expect(read.error).toBeUndefined();
          await expectAuditEvent(request, seed.companyId, {
            connectionId: connection.id,
            agentId: scout.id,
            search: scenario.lifecycle.allowedRead.name,
          });
          await page.goto(`/${seed.prefix}/apps/${connection.id}/activity`);
          return `Allowed read ${scenario.lifecycle.allowedRead.name}`;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "ask-first-write-approved", async () => {
          await policy(request, seed.companyId, {
            name: `${scenario.path} require approval ${Date.now()}`,
            policyType: "require_approval",
            priority: 10,
            selectors: { connectionId: connection.id, toolNames: [scenario.lifecycle.askFirstWrite.name] },
          });
          const pending = await testCall(request, connection.id, scout, scenario.lifecycle.askFirstWrite);
          expect(pending.decision).toBe("ask_first");
          expect(pending.actionRequestId).toBeTruthy();
          await page.goto(`/${seed.prefix}/apps/${connection.id}/review`);
          await approveActionRequest(request, seed.companyId, pending.actionRequestId!);
          await pollTestCall(request, connection.id, pending.actionRequestId!, "done");
          return `Approved ask-first call ${scenario.lifecycle.askFirstWrite.name}`;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "denied-blocked-call", async () => {
          await policy(request, seed.companyId, {
            name: `${scenario.path} block ${Date.now()}`,
            policyType: "block",
            priority: 1,
            selectors: { connectionId: connection.id, toolNames: [scenario.lifecycle.deniedCall.name] },
          });
          const denied = await testCall(request, connection.id, scout, scenario.lifecycle.deniedCall);
          expect(denied.decision).toBe("off");
          expect(denied.error?.reasonCode).toBeTruthy();
          await page.goto(`/${seed.prefix}/apps/${connection.id}/review`);
          return `Blocked call ${scenario.lifecycle.deniedCall.name}: ${denied.error?.reasonCode}`;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "schema-change-quarantine", async () => {
          if (connection.transport !== "mcp_remote") {
            await page.goto(`/${seed.prefix}/apps/${connection.id}/activity`);
            return "Non-HTTP path records governance/quarantine evidence through fixture metadata.";
          }
          await json<ToolConnection>(await request.patch(`/api/tool-connections/${connection.id}`, {
            data: { config: { ...(connection.config ?? {}), quarantineNewEntries: true } },
          }));
          await policy(request, seed.companyId, {
            name: `${scenario.path} allow schema flip ${Date.now()}`,
            policyType: "allow",
            priority: 5,
            selectors: { connectionId: connection.id, toolNames: [scenario.lifecycle.schemaChangeQuarantine.name] },
          });
          const flipped = await testCall(request, connection.id, scout, scenario.lifecycle.schemaChangeQuarantine);
          expect(flipped.decision).toBe("allowed");
          expect(flipped.error).toBeUndefined();
          const refresh = await json<{ quarantinedCount: number }>(
            await request.post(`/api/tool-connections/${connection.id}/catalog/refresh`),
          );
          expect(refresh.quarantinedCount).toBeGreaterThan(0);
          await page.goto(`/${seed.prefix}/apps`);
          return `Catalog refresh quarantined ${refresh.quarantinedCount} changed entries.`;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "revoke", async () => {
          if (scenario.transport === "gateway_session") {
            const session = await createGatewaySession(request, seed.companyId, scout);
            const listed = await gatewayFetch(request, session.toolsUrl, session.token);
            expect(listed.ok()).toBe(true);
            await json(await request.post(`/api/tool-gateway/sessions/${session.sessionId}/revoke`, {
              data: { companyId: seed.companyId },
            }));
            await expectError(await gatewayFetch(request, session.toolsUrl, session.token), 401);
            await page.goto(`/${seed.prefix}/apps/${connection.id}/activity`);
            return scenario.lifecycle.revoke;
          }
          const disabled = await json<ToolConnection>(await request.patch(`/api/tool-connections/${connection.id}`, {
            data: { enabled: false },
          }));
          expect(disabled.enabled).toBe(false);
          await page.goto(`/${seed.prefix}/apps/${connection.id}`);
          await json<ToolConnection>(await request.patch(`/api/tool-connections/${connection.id}`, {
            data: { enabled: true },
          }));
          return scenario.lifecycle.revoke;
        });

        await runRecordedStep(page, request, seed, smokeRun.id, scenario, "audit-evidence", async () => {
          await expectAuditEvent(request, seed.companyId, {
            connectionId: connection.id,
            agentId: scout.id,
            search: scenario.lifecycle.allowedRead.name,
          });
          await page.goto(`/${seed.prefix}/apps/${connection.id}/activity`);
          return scenario.lifecycle.auditEvidence;
        });
      }
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      await updateSmokeRun(request, seed.companyId, smokeRun.id, failed.length > 0 ? "failed" : "passed", {
        catalog: "tests/e2e/smoke-lab.catalog.ts",
        scenarioCount: ciSmokeLabScenarios.length,
        failed,
      }).catch(() => undefined);
    }

    const completed = await json<{ run: SmokeRun; steps: Array<{ path: string; status: string; screenshotArtifactRef: Json | null }> }>(
      await request.get(`/api/companies/${seed.companyId}/smoke-lab/runs/${smokeRun.id}`),
    );
    expect(completed.run.status).toBe("passed");
    for (const scenario of ciSmokeLabScenarios) {
      const steps = completed.steps.filter((step) => step.path === scenario.path);
      expect(steps.length, `${scenario.path} should record lifecycle steps`).toBeGreaterThanOrEqual(8);
      expect(steps.every((step) => step.status === "pass")).toBe(true);
      expect(steps.every((step) => step.screenshotArtifactRef?.kind === "playwright_screenshot")).toBe(true);
    }
  });
});
