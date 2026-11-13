import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { cursorCloudProfile, runnerMatrix } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { assertRunnerE2EPrerequisites } from "./prerequisites.js";
import { readCursorCloudRemoteIdentity, cursorCloudIdentityProof, CursorCloudOwnedObserver } from "./cursor-cloud-observer.js";
import { assertCursorCloudCallbackIngress, startCursorCloudCallbackProxy } from "./cursor-cloud-callback-proxy.js";
import type { RunnerApi } from "./api.js";
import { assertPublicCampaign } from "./history-publish.js";
import { CursorCloudClientError } from "../../packages/paperclip-runner/src/drivers/cursor-cloud/cloud-client.js";

const cells = runnerMatrix.filter(cell => cell.suite.id === "cursor-cloud");
const agentId = "bc-11111111-1111-4111-8111-111111111111", runId = "run-22222222-2222-4222-8222-222222222222";
function notice(ownerRunId = "local-run") {
  return { runId: ownerRunId, protocolSchemaVersion: 1, payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: ownerRunId,
    sourceKind: "runner", eventType: "provider.notice.recorded", payload: { summary: JSON.stringify({ schema: "paperclip.cursor-cloud.remote-identity.v1", provider: "cursor_cloud", agentId, runId, ownerRunId, normalizedSessionId: "owned-session" }) } } } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Cursor Cloud Product E2E registration", () => {
  it("registers artifact, follow-up, active Stop and semantic planning as single-attempt explicit local cells", () => {
    expect(cells.map(cell => cell.task.id)).toEqual(["task-artifact", "cloud-followup", "active-run-stop", "plan-revise-accept"]);
    for (const cell of cells) {
      expect(cell.requiredCredentials).toEqual(["CURSOR_API_KEY"]);
      expect(cell.environment.id).toBe("local"); expect(cell.task.automaticRetryPolicy).toBe("single_attempt");
      expect(cell.suite.manualOnly).toBe(true);
      expect(selectRunnerExecutions(parseRunnerSelectors(["--id", cell.id])).map(row => row.id)).toEqual([cell.id]);
    }
    expect(cells.map(cell => cell.task.expectedRunCount)).toEqual([1, 2, 1, 3]);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(cell => cell.suite.id === "cursor-cloud")).toBe(false);
    expect(cells[0]!.task.buildMatchers("nonce", cells[0]!)).toContainEqual({ kind: "artifact_exact", name: "cursor-cloud-nonce.txt", expected: "verified-nonce\n", mimeType: "text/plain" });
    const plan = cells.find(cell => cell.task.id === "plan-revise-accept")!.task;
    expect(plan.workMode).toBe("planning");
    expect(plan.flow).toBe("plan_revision_acceptance");
    expect(plan.buildPlanMarkers?.("nonce")).toEqual({ draft: "PAPERCLIP_E2E_PLAN_DRAFT_nonce", revised: "PAPERCLIP_E2E_PLAN_REVISED_nonce" });
    expect(plan.buildRevisionRequest?.("nonce")).toContain("targetRevisionId");
    expect(plan.buildPrompt("nonce")).toContain("do not request Cursor native Plan mode");
    expect(plan.buildPrompt("nonce")).not.toContain("remain in the requested planning collaboration mode");
  });
  it("binds the exact explicit model and encrypted Cloud credential without native permission fiction", () => {
    vi.stubEnv("PAPERCLIP_CURSOR_CLOUD_ACCEPTANCE_REPO", "https://github.com/owned/disposable");
    const profile = { ...cursorCloudProfile, model: "explicit-account-model" };
    const payload = profile.buildAgent({ executionId: "owned", environmentId: "local-env", environmentFixtureId: "local", workspacePath: "/tmp/owned",
      secretRefs: { CURSOR_API_KEY: { type: "secret_ref", secretId: "secret", version: "latest" } } });
    expect(payload.adapterConfig).toMatchObject({ provider: "cursor_cloud", model: "explicit-account-model", repoUrl: "https://github.com/owned/disposable", lifecycleMode: "per_turn", env: { CURSOR_API_KEY: { type: "secret_ref", secretId: "secret" } } });
    expect(payload.adapterConfig).not.toHaveProperty("codexPermissionMode"); expect(payload.adapterConfig).not.toHaveProperty("cwd");
  });
  it("refuses public publication of native provider identity snapshots", () => {
    expect(() => assertPublicCampaign({ results: [{ suiteId: "cursor-cloud" } as never] })).toThrow("Private");
    expect(() => assertPublicCampaign({ results: [{ suiteId: "core-compatibility" } as never] })).not.toThrow();
  });
  it("setup-blocks missing prerequisites before credential loading and accepts an explicitly configured local profile", () => {
    expect(() => assertRunnerE2EPrerequisites(cells, {})).toThrow("setup-blocked");
    const environment = { PAPERCLIP_CURSOR_CLOUD_ACCEPTANCE_MODEL: "explicit-model", PAPERCLIP_CURSOR_CLOUD_ACCEPTANCE_REPO: "https://github.com/owned/disposable", PAPERCLIP_PUBLIC_URL: "https://callback.example.test", PAPERCLIP_CURSOR_CLOUD_CALLBACK_PORT: "43121", PAPERCLIP_CURSOR_CLOUD_ALLOW_UNPRICED_QUALIFICATION: "1" };
    const configured = cells.map(cell => ({ ...cell, profile: { ...cell.profile, model: "explicit-model" } }));
    expect(() => assertRunnerE2EPrerequisites(configured, environment)).not.toThrow();
    expect(() => assertRunnerE2EPrerequisites(configured, { ...environment, PAPERCLIP_CURSOR_CLOUD_ALLOW_UNPRICED_QUALIFICATION: undefined })).toThrow("ALLOW_UNPRICED_QUALIFICATION");
    expect(() => assertRunnerE2EPrerequisites(configured, { ...environment, PAPERCLIP_PUBLIC_URL: "http://localhost" })).toThrow("setup-blocked");
    expect(() => assertRunnerE2EPrerequisites(configured, { ...environment, PAPERCLIP_CURSOR_CLOUD_ACCEPTANCE_REPO: "https://user:secret@example.test/repo" })).toThrow("setup-blocked");
    expect(() => assertRunnerE2EPrerequisites(cells, environment)).toThrow("exact configured model");
  });
});

describe("Cloud observer evidence calibration", () => {
  function planObserver(change?: (rows: Array<Record<string, any>>, identities: Array<Record<string, any>>) => void) {
    const rows = [0, 1, 2].map(index => ({ id: `local-${index}`, companyId: "owned-company", agentId: "owned-agent", sessionIdBefore: null,
      contextSnapshot: index === 2 ? { forceFreshSession: true, workspaceRefreshReason: "accepted_plan_confirmation",
        source: "issue.interaction.accept", interactionStatus: "accepted", interactionId: "revised-confirmation" } : {} }));
    const identities = rows.map((row, index) => ({ agentId: index < 2 ? agentId : "bc-33333333-3333-4333-8333-333333333333",
      runId: `run-22222222-2222-4222-8222-22222222222${index}`, normalizedSessionId: index < 2 ? "planning-session" : "accepted-session" }));
    change?.(rows, identities);
    const api = { get: vi.fn(async (path: string) => {
      if (path.includes("companies/")) return rows;
      const index = rows.findIndex(row => path.includes(`/heartbeat-runs/${row.id}`));
      if (index < 0) throw new Error("Unknown owned fixture run");
      if (!path.includes("/events?")) return rows[index];
      const value = notice(rows[index]!.id);
      const identity = JSON.parse(value.payload.prpEvent.payload.summary);
      value.payload.prpEvent.payload.summary = JSON.stringify({ ...identity, ...identities[index] });
      return [{ ...value, seq: 1 }];
    }) } as unknown as RunnerApi;
    return new CursorCloudOwnedObserver(api, "owned-company", "owned-agent", "test-key");
  }
  it("allows only the revision-bound accepted Plan to rotate its owned Cloud session", async () => {
    const observer = planObserver();
    expect((await observer.assertContinuity(3))[0]?.passed).toBe(false);
    expect((await observer.assertPlanTransitions(["local-0", "local-1", "local-2"], "revised-confirmation"))[0]?.passed).toBe(true);
  });
  it.each(["early rotation", "same accepted agent", "same accepted session", "duplicate native run", "wrong interaction", "missing reset", "wrong source", "not accepted", "prior session"])("rejects %s during Plan transitions", async reason => {
    const observer = planObserver((rows, identities) => {
      if (reason === "early rotation") identities[1]!.normalizedSessionId = "unexplained-session";
      if (reason === "same accepted agent") identities[2]!.agentId = identities[1]!.agentId;
      if (reason === "same accepted session") identities[2]!.normalizedSessionId = identities[1]!.normalizedSessionId;
      if (reason === "duplicate native run") identities[2]!.runId = identities[1]!.runId;
      if (reason === "wrong interaction") rows[2]!.contextSnapshot.interactionId = "old-confirmation";
      if (reason === "missing reset") rows[2]!.contextSnapshot.forceFreshSession = false;
      if (reason === "wrong source") rows[2]!.contextSnapshot.source = "issue.comment";
      if (reason === "not accepted") rows[2]!.contextSnapshot.interactionStatus = "pending";
      if (reason === "prior session") rows[2]!.sessionIdBefore = "planning-session";
    });
    expect((await observer.assertPlanTransitions(["local-0", "local-1", "local-2"], "revised-confirmation"))[0]?.passed).toBe(false);
  });
  it("rejects missing, duplicate or reordered Plan turn ownership", async () => {
    for (const owners of [["local-0", "local-1"], ["local-0", "local-0", "local-2"], ["local-2", "local-1", "local-0"]]) {
      expect((await planObserver().assertPlanTransitions(owners, "revised-confirmation"))[0]?.passed).toBe(false);
    }
    expect((await planObserver().assertPlanTransitions(["local-0", "local-1", "local-2"], null))[0]?.passed).toBe(false);
  });
  it("requires persisted runner-owned identity and exports digests without native IDs", () => {
    const identity = readCursorCloudRemoteIdentity([notice()], "local-run")!;
    expect(identity).toMatchObject({ agentId, runId, ownerRunId: "local-run" });
    expect(JSON.stringify(cursorCloudIdentityProof(identity))).not.toContain(agentId);
    expect(readCursorCloudRemoteIdentity([], "local-run")).toBeUndefined();
    expect(readCursorCloudRemoteIdentity([notice("foreign-run")], "local-run")).toBeUndefined();
  });
  it.each(["provider", "text", "schema", "row", "owner", "native-id"])("rejects plausible wrong %s identity evidence", reason => {
    const value = notice(), event = value.payload.prpEvent;
    if (reason === "provider") event.sourceKind = "provider";
    if (reason === "text") event.eventType = "assistant.message";
    if (reason === "schema") event.schemaVersion = 2;
    if (reason === "row") value.runId = "other-run";
    if (["owner", "native-id"].includes(reason)) {
      const identity = JSON.parse(event.payload.summary); identity[reason === "owner" ? "ownerRunId" : "agentId"] = "foreign"; event.payload.summary = JSON.stringify(identity);
      expect(() => readCursorCloudRemoteIdentity([value], "local-run")).toThrow("invalid owner");
    } else expect(readCursorCloudRemoteIdentity([value], "local-run")).toBeUndefined();
  });
  it("refuses unrelated agents before any provider cleanup mutation", async () => {
    const api = { get: vi.fn(async (path: string) => path.includes("companies/") ? [{ id: "foreign" }] : { id: "foreign", companyId: "owned-company", agentId: "other-agent" }) } as unknown as RunnerApi;
    const observer = new CursorCloudOwnedObserver(api, "owned-company", "owned-agent", "test-key");
    const remove = vi.spyOn(observer.client, "deleteAgent");
    expect((await observer.cleanup())[0]?.passed).toBe(false); expect(remove).not.toHaveBeenCalled();
  });
  function ownedObserver() {
    const api = { get: vi.fn(async (path: string) => path.includes("/events?") ? [{ ...notice(), seq: 1 }] : path.includes("companies/") ? [{ id: "local-run" }] : { id: "local-run", companyId: "owned-company", agentId: "owned-agent" }) } as unknown as RunnerApi;
    const observer = new CursorCloudOwnedObserver(api, "owned-company", "owned-agent", "test-key");
    vi.spyOn(observer.client, "getRun").mockResolvedValue({ id: runId, agentId, status: "CANCELLED", createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" });
    return observer;
  }
  it("does not equate a deletion acknowledgment with remote absence", async () => {
    vi.useFakeTimers();
    const observer = ownedObserver();
    vi.spyOn(observer.client, "deleteAgent").mockResolvedValue({ id: agentId });
    const lookup = vi.spyOn(observer.client, "getAgent").mockResolvedValue({ id: agentId, status: "IDLE", env: { type: "cloud" }, url: "https://cursor.com/agents/test", createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" });
    const startedAt = Date.now();
    const completed = observer.cleanup();
    await vi.runAllTimersAsync();
    expect(await completed).toMatchObject([{ passed: false }]);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(30_000);
    expect(lookup).toHaveBeenCalledWith(agentId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it.each(["timeout", "acknowledged"])("waits for authoritative absence after an %s delete without issuing another mutation", async outcome => {
    vi.useFakeTimers();
    const observer = ownedObserver();
    const remove = vi.spyOn(observer.client, "deleteAgent");
    if (outcome === "timeout") remove.mockRejectedValue(new CursorCloudClientError("timeout"));
    else remove.mockResolvedValue({ id: agentId });
    const lookup = vi.spyOn(observer.client, "getAgent")
      .mockResolvedValueOnce({ id: agentId, status: "IDLE", env: { type: "cloud" }, url: "https://cursor.com/agents/test", createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" })
      .mockRejectedValue(new CursorCloudClientError("http_error", { status: 404 }));
    const completed = observer.cleanup();
    await vi.runAllTimersAsync();
    expect(await completed).toMatchObject([{ passed: true }]);
    expect(remove).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it("reconciles an ambiguous deletion reply through authoritative absence", async () => {
    const observer = ownedObserver();
    vi.spyOn(observer.client, "deleteAgent").mockRejectedValue(new CursorCloudClientError("invalid_response"));
    vi.spyOn(observer.client, "getAgent").mockRejectedValue(new CursorCloudClientError("http_error", { status: 404 }));
    expect((await observer.cleanup())[0]?.passed).toBe(true);
  });
  it("retains a deletion authorization failure even if a later lookup hides the resource", async () => {
    const observer = ownedObserver();
    vi.spyOn(observer.client, "deleteAgent").mockRejectedValue(new CursorCloudClientError("http_error", { status: 403 }));
    vi.spyOn(observer.client, "getAgent").mockRejectedValue(new CursorCloudClientError("http_error", { status: 404 }));
    expect((await observer.cleanup())[0]?.passed).toBe(false);
  });
  it("does not accept an unavailable absence check", async () => {
    const observer = ownedObserver();
    vi.spyOn(observer.client, "deleteAgent").mockResolvedValue({ id: agentId });
    vi.spyOn(observer.client, "getAgent").mockRejectedValue(new CursorCloudClientError("timeout"));
    expect((await observer.cleanup())[0]?.passed).toBe(false);
  });
});

const listen = async (server: Server) => { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return (server.address() as { port: number }).port; };
const close = (server: Server) => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); });
it("exposes only the callback path over a real loopback connection and strips operator cookies", async () => {
  const requests: Array<{ path?: string; cookie?: string; auth?: string }> = [];
  const app = createServer((request, response) => { requests.push({ path: request.url, cookie: request.headers.cookie, auth: request.headers.authorization }); response.writeHead(401).end(); });
  const appPort = await listen(app), reservation = createServer(), proxyPort = await listen(reservation); await close(reservation);
  const stop = await startCursorCloudCallbackProxy({ appPort, port: proxyPort });
  try {
    const origin = `http://127.0.0.1:${proxyPort}`;
    await assertCursorCloudCallbackIngress(origin);
    const response = await fetch(`${origin}/mcp/native-runs/00000000-0000-4000-8000-000000000000`, { method: "POST", headers: { cookie: "operator-session", authorization: "Bearer owned-capability" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(requests).toHaveLength(2); expect(requests.every(request => !request.cookie)).toBe(true);
    expect(requests.at(-1)?.auth).toBe("Bearer owned-capability");
    await expect(assertCursorCloudCallbackIngress("https://bad.example.test", async () => new Response("operator app", { status: 200 }))).rejects.toThrow("callback listener");
  } finally { await stop(); await close(app); }
});
