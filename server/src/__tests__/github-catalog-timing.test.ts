import { randomUUID } from "node:crypto";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import {
  authUsers, companies, companyMemberships, connectionGrants, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, toolApplications, toolConnections,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeConnectionCredential } from "../services/connection-credentials.js";
import { syncConnectionCredentialBindings } from "../services/connection-credential-bindings.js";
import { withRunExecutionTiming } from "../services/execution-preparation-timing.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import { toolAccessService } from "../services/tool-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GitHub repository catalog execution timing", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let exporter: InMemorySpanExporter, provider: TracerProvider, manager: AsyncLocalStorageContextManager;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-github-catalog-timing-");
    db = createDb(temporary.connectionString, { maxConnections: 3 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "01234567890123456789012345678901");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    manager = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(manager)).toBe(true);
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    trace.disable(); context.disable(); manager.disable();
    await provider.shutdown();
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function fixture() {
    const userId = `catalog-user-${randomUUID()}`;
    const [company] = await db.insert(companies).values({ name: "Catalog timing", issuePrefix: `GH${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(authUsers).values({ id: userId, name: "Catalog owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "GitHub catalog", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id, applicationId: application.id, name: "Private GitHub connection", uid: randomUUID(),
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", enabled: true, status: "active",
      config: { sourceTemplateKey: "github", oauth: { strategy: "paperclip_cloud_connector", connectorProfile: "github.code" } },
    }).returning();
    const token = `private-fixture-token-${randomUUID()}`;
    const { secret } = await writeConnectionCredential(db, {
      companyId: company.id, connectionName: connection.name, configPath: "oauth.access_token", label: "Access token",
      value: token, ownerUserId: userId, actor: { userId },
    });
    const [grant] = await db.insert(connectionGrants).values({
      companyId: company.id, connectionId: connection.id, kind: "user", subjectUserId: userId,
      credentialSecretRefs: [{ configPath: "oauth.access_token", secretId: secret.id, versionSelector: "latest" }],
    }).returning();
    await syncConnectionCredentialBindings(db, connection);
    const webhook = vi.fn(async () => trace.getTracer("catalog-fixture").startActiveSpan("fixture.webhook", async span => {
      await Promise.resolve(); span.end();
    }));
    const connector = { setWebhookBinding: webhook } as unknown as PaperclipCloudConnector;
    const service = toolAccessService(db, { paperclipCloudConnector: connector });
    expect(await service.githubReadHeaders(company.id, connection.id, userId)).toEqual({ Authorization: `Bearer ${token}` });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async url =>
      trace.getTracer("catalog-fixture").startActiveSpan("fixture.github_http", async span => {
        await Promise.resolve();
        span.end();
        const path = new URL(String(url)).pathname;
        if (path === "/user") return Response.json({ id: 42, login: "private-fixture-login" });
        if (path === "/user/installations") return Response.json({ installations: [{ id: 101, repository_selection: "selected", account: { login: "private-fixture-org" } }] });
        if (path === "/user/installations/101/repositories") return Response.json({ repositories: [{ id: 201, full_name: "private-fixture-org/repository", private: true }] });
        throw new Error("Unexpected fixture request");
      }));
    return { companyId: company.id, userId, connection, grant, service, fetchMock, webhook, token };
  }

  function span(name: string) {
    const found = exporter.getFinishedSpans().find(candidate => candidate.name === name);
    expect(found, name).toBeDefined();
    return found!;
  }

  it("attributes a real grant row-lock wait and preserves provider/write/webhook order", async () => {
    const f = await fixture();
    let release!: () => void, acquired!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id)).for("update");
      acquired(); await released;
    });
    await ready;
    const pending = withRunExecutionTiming("catalog-lock", () => f.service.listGitHubRepositories(f.companyId, f.userId));
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => { expect(f.fetchMock).toHaveBeenCalledTimes(3); });
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select count(*)::int as count from pg_locks where not granted and locktype = ${"transactionid"}`);
        expect(waiting[0]?.count).toBeGreaterThan(0);
      });
      expect(exporter.getFinishedSpans().some(candidate => candidate.name === "connectors.github.grant_lock")).toBe(false);
      expect(f.webhook).not.toHaveBeenCalled();
    } finally {
      release(); await blocker; await pending;
    }
    const result = await pending;
    expect(result).toMatchObject({ connectionCount: 1, failedConnectionCount: 0, repositories: [{ id: "201", fullName: "private-fixture-org/repository" }] });
    const [saved] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id));
    expect(saved.providerTenant?.github?.repositoryCount).toBe(1);
    expect(f.webhook).toHaveBeenCalledTimes(1);
    const catalog = span("connectors.github.catalog");
    const refresh = span("connectors.github.refresh");
    const transaction = span("connectors.github.refresh.transaction");
    expect(catalog.parentSpanContext?.spanId).toBe(span("task.execution_attempt").spanContext().spanId);
    expect(refresh.parentSpanContext?.spanId).toBe(catalog.spanContext().spanId);
    expect(transaction.parentSpanContext?.spanId).toBe(refresh.spanContext().spanId);
    for (const name of ["grant_lock", "grant_write"]) expect(span(`connectors.github.${name}`).parentSpanContext?.spanId).toBe(transaction.spanContext().spanId);
    for (const name of ["entry", "commit"]) expect(span(`connectors.github.refresh.transaction.${name}`).parentSpanContext?.spanId).toBe(transaction.spanContext().spanId);
    expect(span("fixture.github_http").parentSpanContext?.spanId).toBe(span("connectors.github.repositories").spanContext().spanId);
    expect(span("fixture.webhook").parentSpanContext?.spanId).toBe(span("connectors.github.webhooks").spanContext().spanId);
    for (const name of ["connections", "grants", "grant_members", "membership"]) expect(span(`connectors.github.${name}`).parentSpanContext?.spanId).toBe(catalog.spanContext().spanId);
    const exported = JSON.stringify(exporter.getFinishedSpans().map(({ name, attributes, events }) => ({ name, attributes, events })));
    for (const privateValue of [f.companyId, f.userId, f.connection.id, f.connection.name, f.grant.id, f.token, "private-fixture-org", "private-fixture-login"]) expect(exported).not.toContain(privateValue);
  });

  it("preserves denied audiences and swallowed provider failures without exporting error text", async () => {
    const f = await fixture();
    const denied = await withRunExecutionTiming("catalog-denied", () => f.service.listGitHubRepositories(f.companyId, "unrelated-user"));
    expect(denied).toMatchObject({ repositories: [], connectionCount: 0, failedConnectionCount: 0 });
    expect(f.fetchMock).not.toHaveBeenCalled();
    const failure = new Error(`private-provider-error-${randomUUID()}`);
    f.fetchMock.mockRejectedValue(failure);
    const result = await withRunExecutionTiming("catalog-failed", () => f.service.listGitHubRepositories(f.companyId, f.userId));
    expect(result).toMatchObject({ repositories: [], connectionCount: 1, failedConnectionCount: 1 });
    expect(span("connectors.github.repositories").status.code).toBe(2);
    expect(span("connectors.github.refresh").status.code).toBe(2);
    expect(JSON.stringify(exporter.getFinishedSpans().map(({ attributes, events }) => ({ attributes, events })))).not.toContain(failure.message);
    expect(f.webhook).not.toHaveBeenCalled();
  });

  it("retains the single access-conflict retry and records rollback before the successful commit", async () => {
    const f = await fixture();
    const request = f.fetchMock.getMockImplementation()!;
    let changed = false;
    f.fetchMock.mockImplementation(async (...args) => {
      const response = await request(...args);
      if (!changed && new URL(String(args[0])).pathname.endsWith("/repositories")) {
        changed = true;
        await db.update(connectionGrants).set({ providerTenant: { github: {
          userId: "42", login: "private-fixture-login", installationCount: 0, repositoryCount: 0,
          repositorySelection: "none", installationIds: [], installationOwnerLogins: [], accessRevision: "concurrent-webhook",
        } } }).where(eq(connectionGrants.id, f.grant.id));
      }
      return response;
    });
    const result = await withRunExecutionTiming("catalog-conflict", () => f.service.listGitHubRepositories(f.companyId, f.userId));
    expect(result).toMatchObject({ connectionCount: 1, failedConnectionCount: 0, repositories: [{ id: "201" }] });
    expect(f.fetchMock).toHaveBeenCalledTimes(6);
    expect(f.webhook).toHaveBeenCalledTimes(1);
    const transactions = exporter.getFinishedSpans().filter(candidate => candidate.name === "connectors.github.refresh.transaction");
    expect(transactions).toHaveLength(2);
    expect(transactions.map(candidate => candidate.status.code)).toEqual([2, 0]);
    const rollback = span("connectors.github.refresh.transaction.rollback");
    const commit = span("connectors.github.refresh.transaction.commit");
    expect(rollback.parentSpanContext?.spanId).toBe(transactions[0].spanContext().spanId);
    expect(commit.parentSpanContext?.spanId).toBe(transactions[1].spanContext().spanId);
    const retryRead = exporter.getFinishedSpans().find(candidate => candidate.name === "connectors.github.grants"
      && candidate.parentSpanContext?.spanId === span("connectors.github.refresh").spanContext().spanId);
    expect(retryRead).toBeDefined();
  });

  it("keeps the same catalog outputs with endpoint disabled and emits no owned-run spans outside an attempt", async () => {
    const f = await fixture();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    const disabled = await withRunExecutionTiming("catalog-off", () => f.service.listGitHubRepositories(f.companyId, f.userId));
    expect(disabled).toMatchObject({ connectionCount: 1, failedConnectionCount: 0, repositories: [{ id: "201" }] });
    expect(exporter.getFinishedSpans().filter(candidate => candidate.name.startsWith("connectors.github."))).toEqual([]);
    exporter.reset();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const outside = await f.service.listGitHubRepositories(f.companyId, f.userId);
    expect(outside).toEqual(disabled);
    expect(exporter.getFinishedSpans().filter(candidate => candidate.name.startsWith("connectors.github."))).toEqual([]);
    exporter.reset();
    const enabled = await withRunExecutionTiming("catalog-on", () => f.service.listGitHubRepositories(f.companyId, f.userId));
    expect(enabled).toEqual(disabled);
    expect(span("connectors.github.catalog").status.code).toBe(0);
  });
});
