import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySecrets,
  createDb,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const KEY = "ts-connection-test-key";
const actor = { actorType: "user" as const, actorId: "board" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describeEmbeddedPostgres("TypeSafe connection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-typesafe-connection-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const createCompany = () =>
    db
      .insert(companies)
      .values({
        name: `TypeSafe ${randomUUID()}`,
        issuePrefix: `TS${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  const createAgent = (companyId: string) =>
    db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
  const provider = (status = 200) =>
    vi.fn(async (_url: unknown, _init?: RequestInit) =>
      json(status === 200 ? { models: [{ name: "jev-latest" }] } : {}, status),
    );
  const serviceWith = (fetcher: ReturnType<typeof provider>) =>
    toolAccessService(db, { typesafeFetch: fetcher as unknown as typeof fetch });
  const connect = (
    service: ReturnType<typeof serviceWith>,
    companyId: string,
    configValues?: Record<string, unknown>,
  ) =>
    service.connectGalleryApp(
      companyId,
      {
        galleryKey: "typesafe",
        connectionMethodKey: "api-key",
        credentialValues: { "credentials.apiKey": KEY },
        ...(configValues ? { configValues } : {}),
      },
      actor,
    );

  it("connects, proves the key, and stores the default model", async () => {
    const company = await createCompany();
    const fetcher = provider();
    const result = await connect(serviceWith(fetcher), company.id);

    expect(result.connection).toMatchObject({
      transport: "rest_api",
      healthStatus: "ok",
      healthMessage: "TypeSafe API key is connected.",
    });
    expect(result.catalog).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/models");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);

    const [saved] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, result.connectionId));
    expect(saved!.config).toMatchObject({
      sourceTemplateKey: "typesafe",
      methodConfig: { model: "jev-latest" },
    });
    expect(JSON.stringify([result, saved])).not.toContain(KEY);
  });

  it("keeps a pinned versioned model that the alias list omits", async () => {
    const company = await createCompany();
    const result = await connect(serviceWith(provider()), company.id, { model: "jev-1.13.0" });
    const [saved] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, result.connectionId));
    expect(saved!.healthStatus).toBe("ok");
    expect(saved!.config).toMatchObject({ methodConfig: { model: "jev-1.13.0" } });
  });

  it("rejects a bad key and leaves nothing behind", async () => {
    const company = await createCompany();
    await expect(connect(serviceWith(provider(401)), company.id)).rejects.toMatchObject({
      status: 422,
      details: { code: "typesafe_api_key_rejected" },
    });
    expect(
      await db.select().from(toolConnections).where(eq(toolConnections.companyId, company.id)),
    ).toEqual([]);
    expect(
      await db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id)),
    ).toEqual([]);
  });

  it("reports a provider outage as a gateway failure", async () => {
    const company = await createCompany();
    await expect(connect(serviceWith(provider(529)), company.id)).rejects.toMatchObject({
      status: 502,
      details: { code: "typesafe_request_failed" },
    });
  });

  it("re-checks health and refreshes an empty catalog", async () => {
    const company = await createCompany();
    const service = serviceWith(provider());
    const { connectionId } = await connect(service, company.id);
    await expect(service.checkHealth(connectionId)).resolves.toMatchObject({
      connection: { healthStatus: "ok" },
    });
    await expect(service.refreshCatalog(connectionId)).resolves.toMatchObject({
      catalog: [],
      connection: { healthStatus: "ok", healthMessage: "TypeSafe API key is connected." },
    });
  });

  it("finish installs the connection for all agents", async () => {
    const company = await createCompany();
    const service = serviceWith(provider());
    const { connectionId } = await connect(service, company.id);
    await service.finishGalleryAppConnection(
      company.id,
      connectionId,
      { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" },
      actor,
    );
    const installs = await db
      .select()
      .from(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, connectionId));
    expect(installs.map(({ targetType, targetId }) => ({ targetType, targetId }))).toEqual([
      { targetType: "company", targetId: company.id },
    ]);
  });

  it("finish installs the connection for selected agents only", async () => {
    const company = await createCompany();
    const agent = await createAgent(company.id);
    await createAgent(company.id);
    const service = serviceWith(provider());
    const { connectionId } = await connect(service, company.id);
    await service.finishGalleryAppConnection(
      company.id,
      connectionId,
      { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [agent.id] } },
      actor,
    );
    const installs = await db
      .select()
      .from(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, connectionId));
    expect(installs.map(({ targetType, targetId }) => ({ targetType, targetId }))).toEqual([
      { targetType: "agent", targetId: agent.id },
    ]);
  });
});
