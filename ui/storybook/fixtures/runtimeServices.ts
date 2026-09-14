import type { RuntimeService, RuntimeServiceCompanyPolicy, RuntimeServiceDataDeletionPlan, RuntimeServiceShare } from "@paperclipai/shared";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { seedIssueDetailCache } from "@/lib/issueDetailCache";
import { taskPanelPropertiesTab, writeTaskSidePanelState } from "@/lib/task-side-panel-state";
import { serviceKeys } from "@/hooks/useRuntimeServices";
import { createIssue, storybookAgents, storybookAuthSession, storybookCompanies, storybookProjects, storybookSecrets } from "./paperclipData";

export type ServiceScenario = "ready" | "empty" | "loading" | "refresh-error" | "starting" | "stopping" | "sleeping" | "stopped" | "failed" | "worker" | "handoff" | "exposure-error" | "retention-error" | "viewer" | "attached" | "deletion" | "expiration" | "lost-response" | "slow" | "conflict" | "logs-error";
export const companyId = "company-storybook";
export const serviceId = "42000000-0000-4000-8000-000000000001";
export const environmentId = "42000000-0000-4000-8000-000000000004";
export const reviewTask = createIssue({
  id: "42000000-0000-4000-8000-000000000002", identifier: "PAP-42", issueNumber: 42,
  title: "Build and iterate on the customer dashboard", status: "in_review",
  description: "Create a Vite React dashboard. Keep its preview available while I test it, then update the chart when I return. The app should hot reload without losing my work.",
  executionWorkspaceId: null, currentExecutionWorkspace: null, projectWorkspaceId: null,
  checkoutRunId: null, executionRunId: null, executionLockedAt: null,
  createdAt: new Date(), updatedAt: new Date(), startedAt: new Date(), lastActivityAt: new Date(),
  labelIds: [], labels: [], workProducts: [], documentSummaries: [], planDocument: null,
});
const now = () => new Date().toISOString();

export function makeService(overrides: Partial<RuntimeService> = {}): RuntimeService {
  const id = overrides.id ?? serviceId;
  return {
    id, companyId, name: "Customer dashboard", purpose: "preview", provider: "daytona",
    issueId: reviewTask.id, startedByRunId: "service-review-run", createdByAgentId: "agent-codex",
    executionWorkspaceId: null, allocationId: "42000000-0000-4000-8000-000000000003",
    retention: { state: "retained", compute: "running", error: null },
    state: "ready", desiredState: "running", revision: 1,
    policy: { idleSeconds: 3600, maxRunningSeconds: null, keepRunningUntil: null, restartAttempts: 3, readinessTimeoutSeconds: 60 },
    endpoints: [{ name: "web", port: 5173, health: "ready", status: "ready", url: "https://dashboard.preview.example.invalid", error: null, verifiedAt: now() }],
    lastActivityAt: now(), startedAt: now(), stoppedAt: null, restartCount: 0,
    previewActivity: { lastSignalAt: now() }, error: null, stopReason: null,
    detailPath: `/runtime-services/${id}`, createdAt: now(), updatedAt: now(),
    canAttachTaskWorkspace: true, ...overrides,
  };
}

export function servicesFor(scenario: ServiceScenario): RuntimeService[] {
  if (scenario === "empty") return [];
  const service = makeService();
  if (["starting", "stopping", "sleeping", "stopped", "failed"].includes(scenario)) {
    service.state = scenario as RuntimeService["state"];
    service.desiredState = scenario === "sleeping" ? "sleeping" : ["stopped", "stopping"].includes(scenario) ? "stopped" : "running";
  }
  if (scenario === "failed") { service.error = "The app did not become ready. Check its logs, fix the start command, and try again."; service.restartCount = 3; }
  if (scenario === "worker") { service.name = "Order sync worker"; service.purpose = "worker"; service.endpoints = []; service.policy.idleSeconds = null; }
  if (scenario === "handoff") { service.state = "starting"; service.handoff = { mode: "relaunch", phase: "pending" }; }
  if (scenario === "exposure-error") { service.endpoints[0]!.status = "failed"; service.endpoints[0]!.error = "Preview routing is unavailable. Open the URL to retry."; }
  if (scenario === "retention-error") { service.retention = { state: "failed", compute: "unknown", error: "Data retention could not be verified. New starts are paused until the environment reconnects." }; }
  if (scenario === "attached") service.taskWorkspace = { issueId: reviewTask.id };
  if (scenario === "deletion") { service.state = "stopped"; service.desiredState = "stopped"; service.dataDeletion = { id: "review-deletion", state: "failed", attempts: 1, error: "The environment did not confirm deletion. Retry to check the same workspace.", requestedAt: now(), updatedAt: now(), completedAt: null, retryAt: null }; }
  if (scenario === "expiration") service.retention.expiration = { policyRevision: 1, retainedDataSeconds: 86400 * 7, state: "protected", expiresAt: null, checkedAt: now(), blockers: ["Complete or cancel every linked task before deleting its workspace data."] };
  return [service];
}

/** Story-only API simulation. No request here provisions compute or reaches a Paperclip instance. */
export function installRuntimeServiceReview(scenario: ServiceScenario, page: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  let services = servicesFor(scenario);
  if (page === "inventory" && scenario === "ready") services.push(
    makeService({ id: "42000000-0000-4000-8000-000000000005", name: "Component library", state: "sleeping", desiredState: "sleeping", endpoints: [{ name: "storybook", port: 6006, status: "ready", health: "ready", url: "https://storybook.preview.example.invalid", error: null, verifiedAt: now() }] }),
    makeService({ id: "42000000-0000-4000-8000-000000000006", name: "Order sync worker", purpose: "worker", endpoints: [], policy: { ...makeService().policy, idleSeconds: null } }),
  );
  let policy: RuntimeServiceCompanyPolicy = { companyId, revision: 1, config: { previewIdleSeconds: 3600, workerIdleSeconds: null, maxRunningSeconds: null, maxRunningServices: 5, maxServiceAllocations: 10, retainedDataSeconds: null }, usage: { runningServices: services.filter((s) => s.desiredState === "running").length, serviceAllocations: 1 }, updatedAt: now() };
  let shares: RuntimeServiceShare[] = [];
  let env = { NODE_ENV: { type: "plain" as const, value: "development" }, ...(storybookSecrets[0] ? { API_KEY: { type: "secret_ref" as const, secretId: storybookSecrets[0].id, version: "latest" as const } } : {}) };
  let lost = false;
  const acceptedRequests = new Set<string>();
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, ms); timers.add(timer); };
  const sourceFetch = window.fetch;
  const environment = { id: environmentId, companyId, name: "Daytona development", driver: "sandbox", status: "active", config: { provider: "daytona" }, metadata: {}, createdAt: now(), updatedAt: now() };
  const access = { source: "authenticated", isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: scenario === "viewer" ? "viewer" : "owner" }] };
  const health = { status: "ok", deploymentMode: "local_trusted", bootstrapStatus: "ready" };
  client.setQueryData(queryKeys.companies.all, { companies: storybookCompanies, unauthorized: false });
  client.setQueryData(queryKeys.auth.session, page === "auth" ? null : storybookAuthSession);
  client.setQueryData(queryKeys.agents.list(companyId), storybookAgents);
  client.setQueryData(queryKeys.projects.list(companyId), storybookProjects);
  client.setQueryData(queryKeys.issues.list(companyId), [reviewTask]);
  client.setQueryData(queryKeys.issues.labels(companyId), []);
  client.setQueryData(queryKeys.health, health);
  client.setQueryData(queryKeys.access.currentBoardAccess, access);
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableStreamlinedUi: true, enableEnvironments: true, enableIsolatedWorkspaces: false, enableManagedSandboxOnly: false });
  client.setQueryData(queryKeys.instance.generalSettings, { keyboardShortcuts: true });
  seedIssueDetailCache(client, reviewTask);
  const comments = [{ id: "service-review-comment", companyId, issueId: reviewTask.id, authorAgentId: "agent-codex", authorUserId: null, authorType: "agent", body: "The dashboard is ready for review. Open **web** in the Services section of this task’s properties.\n\nThe Vite server will stay available after this run. Send me your changes here and I’ll update the same app; the browser will hot reload.", presentation: null, metadata: null, createdAt: now(), updatedAt: now() }];
  for (const ref of [reviewTask.id, reviewTask.identifier!]) {
    client.setQueryData(queryKeys.issues.comments(ref), { pages: [comments], pageParams: [null] });
    client.setQueryData(queryKeys.issues.documents(ref), []);
    client.setQueryData([...queryKeys.issues.documents(ref), "plan"], null);
    client.setQueryData(queryKeys.issues.liveRuns(ref), []);
    client.setQueryData(queryKeys.issues.runs(ref), []);
    client.setQueryData(queryKeys.issues.activeRun(ref), null);
  }
  writeTaskSidePanelState(storybookAuthSession.user.id, companyId, reviewTask.id, { state: { tabs: [taskPanelPropertiesTab()], activeTabId: "properties" }, userInteracted: true, autoPlanHandled: true, launcherOpen: false, updatedAt: Date.now() });
  if (scenario !== "loading") {
    client.setQueryData(serviceKeys.list(companyId), structuredClone(services));
    client.setQueryData(serviceKeys.list(companyId, reviewTask.id), structuredClone(services));
    services.forEach((s) => client.setQueryData(serviceKeys.detail(companyId, s.id), structuredClone(s)));
  }
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
    const path = url.pathname;
    if (path === "/api/health") return Response.json(health);
    if (path === "/api/announcements/current") return Response.json(null);
    if (path === "/api/auth/get-session") return Response.json(page === "auth" ? null : storybookAuthSession);
    if (path.startsWith("/api/auth/") && method !== "GET") return Response.json({ message: "Storybook uses simulated sign-in. No real account is connected." }, { status: 401 });
    if (path === "/api/instance/settings/experimental") return Response.json({ enableStreamlinedUi: true, enableEnvironments: true, enableIsolatedWorkspaces: false, enableManagedSandboxOnly: false });
    if (path === "/api/instance/settings/general") return Response.json({ keyboardShortcuts: true });
    if (path === "/api/cli-auth/me") return Response.json(access);
    if (path === `/api/companies/${companyId}/environments`) return Response.json([environment]);
    if (path === `/api/environments/${environmentId}`) return Response.json(environment);
    if (path === `/api/environments/${environmentId}/delete-blast-radius`) return Response.json({ environmentId, canDelete: false, deleteBlockedReasons: ["runtime_service_retention"], staticReferences: { isManagedLocal: false, isInstanceDefault: false, agentDefaultCount: 0, executionWorkspaceSelectionCount: 0, issueSelectionCount: 0, projectSelectionCount: 0, secretBindingCount: 0 }, activeRuntimeUse: { activeLeaseCount: 0, activeCustomImageSetupSessionCount: 0, hasActiveRuntimeUse: false }, pendingCleanupLeaseCount: 0, reusableSandboxLeaseCount: 0, reusableSandboxLeaseHolders: [], retainedServiceAllocationCount: 1 });
    if (path === `/api/companies/${companyId}/runtime-service-policy`) {
      if (method === "PATCH") policy = { ...policy, revision: policy.revision + 1, config: { ...policy.config, ...body.config }, updatedAt: now() };
      return Response.json(policy);
    }
    const match = path.match(/^\/api\/companies\/company-storybook\/runtime-services(?:\/([^/]+))?(?:\/(.*))?$/);
    if (match) {
      if (scenario === "loading" && method === "GET") return new Promise<Response>((_, reject) => { const signal = init?.signal; signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); });
      const resource = match[2] ?? "";
      if (scenario === "refresh-error" && method === "GET" && !resource) return Response.json({ error: "Service status is temporarily unavailable." }, { status: 503 });
      if (!match[1]) {
        if (method === "POST") { const row = makeService({ id: crypto.randomUUID(), name: body.name, purpose: body.purpose, state: "starting", endpoints: body.purpose === "worker" ? [] : makeService().endpoints }); services.push(row); later(() => { row.state = "ready"; void client.invalidateQueries({ queryKey: serviceKeys.company(companyId) }); }, 1400); return Response.json(row); }
        return Response.json(services.filter((s) => !url.searchParams.get("issueId") || s.issueId === url.searchParams.get("issueId")));
      }
      const row = services.find((s) => s.id === match[1]);
      if (!row) return Response.json({ error: "This service is outside the review fixture." }, { status: 404 });
      if (scenario === "conflict" && method !== "GET") return Response.json({ error: "Another operator changed this service. Load its current settings before saving." }, { status: 409 });
      if (method !== "GET" && body.requestId && ["control", "policy", "environment", "attach-task", "detach-task"].includes(resource)) {
        const key = `${path}:${body.requestId}`;
        if (acceptedRequests.has(key)) return Response.json(row);
        acceptedRequests.add(key);
      }
      if (method !== "GET" && scenario === "slow") await new Promise<void>((resolve) => later(resolve, 5000));
      if (resource === "control") {
        row.revision++;
        row.desiredState = body.action === "stop" ? "stopped" : body.action === "sleep" ? "sleeping" : "running";
        row.state = body.action === "stop" ? "stopping" : "starting";
        row.error = null;
        later(() => { row.state = row.desiredState === "stopped" ? "stopped" : row.desiredState === "sleeping" ? "sleeping" : "ready"; row.revision++; void client.invalidateQueries({ queryKey: serviceKeys.company(companyId) }); }, 1600);
      }
      if (resource === "policy" && method === "PATCH") { row.policy = { ...row.policy, ...body.policy }; row.revision++; }
      if (resource === "environment") { if (method === "PATCH") { env = body.env; row.revision++; } else return Response.json({ revision: row.revision, env }); }
      if (resource === "logs") return scenario === "logs-error" ? Response.json({ error: "Logs temporarily unavailable" }, { status: 503 }) : Response.json({ text: row.purpose === "worker" ? "Worker ready\nSynced 42 orders\nWaiting for the next batch…" : "VITE ready in 318 ms\nLocal: http://localhost:5173/\n14:04:21 [vite] hmr update /src/App.tsx\n14:06:08 [vite] hmr update /src/components/Chart.tsx\n" });
      if (resource === "attach-task") { row.taskWorkspace = { issueId: body.issueId }; row.issueId = body.issueId; row.revision++; }
      if (resource === "detach-task") { row.taskWorkspace = null; row.revision++; }
      if (resource === "shares") { if (method === "POST") shares.push({ id: crypto.randomUUID(), endpointName: body.endpointName, expiresAt: body.expiresAt, revokedAt: null, createdAt: now(), url: "https://foo.paperclip.example.invalid/runtime-previews/shared/storybook-demo" }); return Response.json(method === "POST" ? shares.at(-1) : shares); }
      if (resource.startsWith("shares/")) { const share = shares.find((s) => s.id === resource.slice(7)); if (share) { share.revokedAt = now(); share.url = null; } return Response.json(share); }
      if (resource.startsWith("storage")) return Response.json({ allocationId: row.allocationId, serviceCount: services.length, services: services.map(({ id, name, state }) => ({ id, name, state })), usage: { status: "ready", bytes: 148_897_792, checkedAt: now(), measuredAt: now(), reason: null } });
      if (resource === "data-deletion") {
        if (method === "POST") { row.dataDeletion = { id: "review-deletion", state: "pending", attempts: 0, error: null, requestedAt: now(), updatedAt: now(), completedAt: null, retryAt: null }; later(() => { row.dataDeletion!.state = "deleted"; row.dataDeletion!.completedAt = now(); row.state = "deleted"; row.desiredState = "deleted"; row.revision++; void client.invalidateQueries(); }, 1800); }
        const result: RuntimeServiceDataDeletionPlan = { allocationId: row.allocationId, provider: "daytona", planToken: "a".repeat(64), scope: "independent_allocation", blockers: row.desiredState === "running" ? ["Stop all services sharing this workspace before deleting their data."] : [], services: services.map(({ id, name, state }) => ({ id, name, state })), tasks: [], includesHostMirror: true, deletion: row.dataDeletion ?? null };
        return Response.json(result);
      }
      if (method !== "GET" && scenario === "lost-response" && !lost) { lost = true; throw new TypeError("Simulated response loss"); }
      return Response.json(row);
    }
    const issue = path.match(/^\/api\/issues\/([^/]+)(?:\/(.*))?$/);
    if (issue && [reviewTask.id, reviewTask.identifier].includes(issue[1])) {
      const resource = issue[2] ?? "";
      if (!resource) return Response.json(reviewTask);
      if (resource === "comments") return Response.json(comments);
      if (resource === "active-run") return Response.json(null);
      if (resource.startsWith("documents/")) return Response.json({ error: "This task has no document." }, { status: 404 });
      if (resource === "read") return Response.json({ ok: true });
      return Response.json([]);
    }
    if (path === `/api/companies/${companyId}/issues`) return Response.json(url.searchParams.has("parentId") || url.searchParams.has("descendantOf") || url.searchParams.has("createdFromIssueId") ? [] : [reviewTask]);
    // Other app chrome reads use the existing global Storybook fixtures.
    // Writes outside this explicitly simulated surface always fail closed.
    if (path.startsWith("/api/") && method !== "GET") return Response.json({ error: "This action is outside the Storybook review." }, { status: 400 });
    return sourceFetch(input, init);
  };
  window.fetch = fetchFixture;
  return { client, restore() { disposed = true; timers.forEach(clearTimeout); void client.cancelQueries(); client.clear(); if (window.fetch === fetchFixture) window.fetch = sourceFetch; } };
}
