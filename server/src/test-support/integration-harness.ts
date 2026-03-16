import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Test } from "supertest";
import request from "supertest";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  type Db,
} from "@paperclipai/db";
import { createApp } from "../app.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

type ApiClient = {
  get(pathname: string): Test;
  post(pathname: string): Test;
  patch(pathname: string): Test;
  delete(pathname: string): Test;
};

type IntegrationHarness = {
  db: Db;
  rootDir: string;
  storageDir: string;
  board: ApiClient;
  asAgent(token: string, runId?: string): ApiClient;
  cleanup(): Promise<void>;
  createCompany(input?: { name?: string; description?: string | null; budgetMonthlyCents?: number }): Promise<Record<string, unknown>>;
  createGoal(companyId: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  createProject(companyId: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  createAgent(companyId: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  createAgentKey(agentId: string, name?: string): Promise<Record<string, unknown>>;
  createIssue(companyId: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  createApproval(companyId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  createSecret(companyId: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

function withApiPrefix(pathname: string) {
  return pathname.startsWith("/api") ? pathname : `/api${pathname}`;
}

// Keep the test client tiny and explicit so integration tests can focus on
// route behavior without re-implementing header plumbing in every call site.
function createApiClient(app: ReturnType<typeof request>, defaultHeaders: Record<string, string>): ApiClient {
  const applyHeaders = (test: Test) => {
    for (const [key, value] of Object.entries(defaultHeaders)) {
      test.set(key, value);
    }
    return test;
  };

  return {
    get: (pathname) => applyHeaders(app.get(withApiPrefix(pathname))),
    post: (pathname) => applyHeaders(app.post(withApiPrefix(pathname))),
    patch: (pathname) => applyHeaders(app.patch(withApiPrefix(pathname))),
    delete: (pathname) => applyHeaders(app.delete(withApiPrefix(pathname))),
  };
}

async function expectStatus(
  response: Awaited<ReturnType<Test["then"]>>,
  expectedStatus: number,
  label: string,
) {
  if (response.status !== expectedStatus) {
    throw new Error(`${label} expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body as Record<string, unknown>;
}

export async function createIntegrationHarness(): Promise<IntegrationHarness> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-integration-"));
  const storageDir = path.join(rootDir, "storage");
  const databaseDir = path.join(rootDir, "db");
  const port = await detectPort(55432);
  const embedded = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: true,
  });

  await embedded.initialise();
  await embedded.start();

  const adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "paperclip");
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(databaseUrl);

  const db = createDb(databaseUrl);
  const storageService = createStorageService(createLocalDiskStorageProvider(storageDir));
  const app = await createApp(db, {
    uiMode: "none",
    storageService,
    databaseConnectionString: databaseUrl,
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: true,
  });

  const requester = request(app);
  const board = createApiClient(requester, {});

  return {
    db,
    rootDir,
    storageDir,
    board,
    asAgent(token: string, runId?: string) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
      };
      if (runId) headers["x-paperclip-run-id"] = runId;
      return createApiClient(requester, headers);
    },
    async cleanup() {
      await (db as any).$client?.end?.({ timeout: 1 });
      await embedded.stop();
      await rm(rootDir, { recursive: true, force: true });
    },
    async createCompany(input) {
      const response = await board.post("/companies").send({
        name: input?.name ?? "Integration Company",
        description: input?.description ?? null,
        budgetMonthlyCents: input?.budgetMonthlyCents ?? 0,
      });
      return expectStatus(response, 201, "create company");
    },
    async createGoal(companyId, input) {
      const response = await board.post(`/companies/${companyId}/goals`).send({
        title: input?.title ?? "Ship the control plane",
        description: input?.description ?? null,
        level: input?.level ?? "company",
        status: input?.status ?? "active",
        planningHorizon: input?.planningHorizon ?? "next",
        sortOrder: input?.sortOrder ?? 0,
        parentId: input?.parentId ?? null,
        ownerAgentId: input?.ownerAgentId ?? null,
      });
      return expectStatus(response, 201, "create goal");
    },
    async createProject(companyId, input) {
      const response = await board.post(`/companies/${companyId}/projects`).send({
        name: input?.name ?? "Control Plane",
        description: input?.description ?? null,
        status: input?.status ?? "in_progress",
        goalId: input?.goalId ?? null,
        goalIds: input?.goalIds ?? [],
        leadAgentId: input?.leadAgentId ?? null,
      });
      return expectStatus(response, 201, "create project");
    },
    async createAgent(companyId, input) {
      const response = await board.post(`/companies/${companyId}/agents`).send({
        name: input?.name ?? "Integration Agent",
        role: input?.role ?? "general",
        title: input?.title ?? null,
        reportsTo: input?.reportsTo ?? null,
        capabilities: input?.capabilities ?? "Integration coverage agent",
        adapterType: input?.adapterType ?? "process",
        adapterConfig: input?.adapterConfig ?? {
          command: "node",
          args: ["-e", "process.stdout.write('integration run')"],
          timeoutSec: 10,
        },
        budgetMonthlyCents: input?.budgetMonthlyCents ?? 0,
        permissions: input?.permissions,
        managerPlanningModeOverride: input?.managerPlanningModeOverride ?? null,
        metadata: input?.metadata ?? null,
      });
      return expectStatus(response, 201, "create agent");
    },
    async createAgentKey(agentId, name = "integration") {
      const response = await board.post(`/agents/${agentId}/keys`).send({ name });
      return expectStatus(response, 201, "create agent key");
    },
    async createIssue(companyId, input) {
      const response = await board.post(`/companies/${companyId}/issues`).send({
        title: input?.title ?? "Ship review coverage",
        description: input?.description ?? null,
        status: input?.status ?? "todo",
        priority: input?.priority ?? "high",
        projectId: input?.projectId ?? null,
        goalId: input?.goalId ?? null,
        parentId: input?.parentId ?? null,
        assigneeAgentId: input?.assigneeAgentId ?? null,
        assigneeUserId: input?.assigneeUserId ?? null,
        labelIds: input?.labelIds ?? [],
      });
      return expectStatus(response, 201, "create issue");
    },
    async createApproval(companyId, input) {
      const response = await board.post(`/companies/${companyId}/approvals`).send(input);
      return expectStatus(response, 201, "create approval");
    },
    async createSecret(companyId, input) {
      const response = await board.post(`/companies/${companyId}/secrets`).send({
        name: input?.name ?? "integration-secret",
        value: input?.value ?? "shh-secret",
        provider: input?.provider ?? "local_encrypted",
        description: input?.description ?? "Integration test secret",
        externalRef: input?.externalRef ?? null,
      });
      return expectStatus(response, 201, "create secret");
    },
  };
}
