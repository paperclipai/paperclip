import { waitForCompanySettingsTurn } from "./identity-company-observer.js";
import { privateIdentityBrowser } from "./identity-private-browser.js";
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { expect } from "@playwright/test";
import type { AgentObservabilitySettingsResponse, AgentObservabilityTestReceipt } from "../../../packages/shared/src/agent-observability.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks } from "./internal-support.js";
import { identityDefinition, identityObservation, observeIdentity, probeAgentPermission } from "./identity-support.js";

interface Received { path: string; authenticated: boolean; body: Buffer; sha256: string }
interface Collector { server: Server; url: string; key: string; received: Received[] }
const collectors = new WeakMap<ChatCatalogContext, Collector>();
async function collector(): Promise<Collector> {
  const key = randomBytes(32).toString("hex"); const received: Received[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || !["/v1/logs", "/v1/traces"].includes(request.url ?? "")) { response.writeHead(404).end(); return; }
      const parts: Buffer[] = []; let size = 0;
      for await (const part of request) { const bytes = Buffer.from(part); size += bytes.length; if (size > 2_097_152) { response.writeHead(413).end(); return; } parts.push(bytes); }
      const bytes = Buffer.concat(parts); const body = request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes, { maxOutputLength: 2_097_152 }) : bytes;
      const authenticated = request.headers.authorization === `Bearer ${key}`;
      received.push({ path: request.url!, body, authenticated, sha256: createHash("sha256").update(body).digest("hex") });
      const json = String(request.headers["content-type"]).startsWith("application/json");
      response.writeHead(authenticated ? 200 : 401, { "content-type": json ? "application/json" : "application/x-protobuf" }).end(json ? "{}" : Buffer.alloc(0));
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic collector has no real local address");
  return { server, url: `http://127.0.0.1:${address.port}`, key, received };
}
export function gradeObservability(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-opt-in-trace-evidence", !!o, "Real saved destination, actual collector deliveries, native runs and disabled-export evidence are required."); if (!o) return c.result();
  const saved = o.state.saved as AgentObservabilitySettingsResponse | undefined; const receipt = o.state.testReceipt as AgentObservabilityTestReceipt | undefined;
  c.add("off-until-human-opt-in", o.state.beforeSettings === null && o.state.afterReplySettings === null && o.state.beforeConfiguredCalls === 0 && o.state.agentWriteStatus === 403
    && saved?.settings?.enabled === true && saved.settings.destination.provider === "otlp" && saved.settings.destination.endpointBaseUrl === o.state.collectorUrl
    && saved.settings.headerNames.includes("authorization") && saved.settings.credentialsConfigured && o.state.publicSettingsContainsKey === false,
    "The actual company has no export before the authorized human configures its synthetic collector and secure ingestion header; agent writes are denied and public readback contains no secret.");
  c.add("actual-selected-delivery-test", receipt?.status === "accepted" && receipt.source === "control_plane" && receipt.revision === saved?.settings?.revision
    && ["logs", "traces"].every(signal => receipt.signals[signal as "logs" | "traces"].status === "accepted") && o.state.collectorMatchedTestSignals === 2,
    "Both actual protobuf signal deliveries contain the exact control-plane test marker, company, revision and private ingestion authentication; a successful settings save is not delivery proof.");
  c.add("real-coding-agent-export", o.state.nativeExportMatched === true && o.state.enabledNativeRunCount === 2 && o.runs.length === 3 && o.runs.every(run => run.status === "succeeded" && run.runtimeMode === "native"),
    "An actual second native agent turn exports its company/agent/revision records to the selected synthetic collector; control-plane samples alone cannot prove coding-agent export.");
  c.add("disabled-stops-future-export", o.state.disabledSaved === true && o.state.disabledNativeRunCount === 3 && o.state.callsAfterDisabledRun === o.state.callsAtDisable
    && o.state.disabledCallsDidNotIncrease === true,
    "The explicit human Disable export control persists, then a third actual native turn completes without another collector delivery.");
  c.add("data-paths-not-confused", /telemetry/i.test(o.reply) && /run log|local log|local.*run/i.test(o.reply) && /optional|opt.in|observability|trace export/i.test(o.reply),
    "The answer distinguishes this optional destination from first-party Telemetry and the local run log.");
  return c.result();
}
export const observabilityIdentityCases: readonly ChatCatalogCase[] = [identityDefinition("companies.agent-observability", async ctx => {
  const before = await ctx.input.api.get<AgentObservabilitySettingsResponse>(`/api/companies/${ctx.input.fixtures.company.id}/observability`);
  if (!before.canManage || before.settings !== null || !ctx.input.privateSecrets) throw new Error("Setup blocker: the real human must manage an initially unconfigured trace destination");
  const target = await collector(); collectors.set(ctx, target); ctx.input.privateSecrets.push(target.key);
  return { beforeSettings: before.settings, collectorUrl: target.url, syntheticCollector: true };
}, gradeObservability, {
  authentication: "human-session", expectedRunCount: 3, expectedHumanMessageCount: 3, attemptTimeoutMs: 600_000,
  sourceFiles: ["chat-catalog-domains/identity-observability.ts", "chat-catalog-domains/identity-company-observer.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/companies.yaml"],
  async act(ctx, state) {
    await waitForCompanySettingsTurn(ctx); const target = collectors.get(ctx); if (!target) throw new Error("Owned synthetic collector is missing");
    const root = `/api/companies/${ctx.input.fixtures.company.id}/observability`; const source = ctx.input.page.url();
    state.afterReplySettings = (await ctx.input.api.get<AgentObservabilitySettingsResponse>(root)).settings; state.beforeConfiguredCalls = target.received.length;
    state.agentWriteStatus = await probeAgentPermission(ctx, root, "PUT", { expectedRevision: null, enabled: true, destination: { provider: "otlp", endpointBaseUrl: target.url }, credentials: { mode: "replace", headers: [] }, capture: { userPrompts: false, assistantResponses: false, toolDetails: false, toolContent: false } });
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/company/settings`, { waitUntil: "domcontentloaded" });
    const section = ctx.input.page.locator('section[aria-labelledby="agent-observability-heading"]');
    await privateIdentityBrowser({ kind: "observability", origin: ctx.input.api.baseURL, startPath: ctx.input.page.url(), cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL), endpoint: target.url, credential: `Bearer ${target.key}` });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(section.getByRole("button", { name: "Test saved settings", exact: true })).toBeEnabled();
    const saved = await ctx.input.api.get<AgentObservabilitySettingsResponse>(root); state.saved = saved; state.publicSettingsContainsKey = JSON.stringify(saved).includes(target.key);
    const response = ctx.input.page.waitForResponse(row => row.request().method() === "POST" && new URL(row.url()).pathname === `${root}/test`);
    await section.getByRole("button", { name: "Test saved settings", exact: true }).click(); const receipt = await (await response).json() as AgentObservabilityTestReceipt; state.testReceipt = receipt;
    await expect(section.getByText("Test payload accepted", { exact: true })).toBeVisible();
    state.collectorMatchedTestSignals = ["/v1/logs", "/v1/traces"].filter(signal => target.received.some(row => row.path === signal && row.authenticated && row.body.includes(receipt.marker)
      && row.body.includes(ctx.input.fixtures.company.id) && row.body.includes(receipt.revision))).length;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await sendChatMessage(ctx.input.page, "Please acknowledge that our test collector configuration is saved. Do not change its settings.");
    await waitForCompanySettingsTurn(ctx, 2); state.enabledNativeRunCount = (await ctx.allRuns()).length;
    state.nativeExportMatched = await pollUntil({ label: "actual native harness trace export", deadlineAt: Date.now() + 30_000,
      load: async () => target.received.some(row => row.authenticated && row.body.includes(ctx.input.fixtures.company.id)
        && row.body.includes(ctx.input.fixtures.agent.id) && row.body.includes(receipt.revision)), accept: Boolean });
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/company/settings`, { waitUntil: "domcontentloaded" });
    await section.getByRole("button", { name: "Disable export", exact: true }).click();
    await expect.poll(async () => (await ctx.input.api.get<AgentObservabilitySettingsResponse>(root)).settings?.enabled).toBe(false); state.disabledSaved = true; state.callsAtDisable = target.received.length;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await sendChatMessage(ctx.input.page, "Please acknowledge that export is now disabled. Do not change it or start any additional work.");
    await waitForCompanySettingsTurn(ctx, 3); state.disabledNativeRunCount = (await ctx.allRuns()).length; state.callsAfterDisabledRun = target.received.length; state.disabledCallsDidNotIncrease = state.callsAfterDisabledRun === state.callsAtDisable;
    await ctx.input.evidence("identity-synthetic-otlp-delivery.json", { syntheticCollector: true, savedRevision: receipt.revision, controlPlaneTestMarker: receipt.marker,
      requests: target.received.map(row => ({ path: row.path, authenticated: row.authenticated, sha256: row.sha256 })), nativeExportMatched: state.nativeExportMatched,
      enabledNativeRunCount: state.enabledNativeRunCount, disabledNativeRunCount: state.disabledNativeRunCount, callsAtDisable: state.callsAtDisable, callsAfterDisabledRun: state.callsAfterDisabledRun,
      realVendorDeliveryClaimed: false, telemetryAndLocalRunLogsAreSeparate: true });
  },
  observe: observeIdentity,
  async cleanup(ctx) { const target = collectors.get(ctx); if (target) { target.server.closeAllConnections(); await new Promise<void>((resolve, reject) => target.server.close(error => error ? reject(error) : resolve())); target.received.length = 0; } collectors.delete(ctx); },
})];
