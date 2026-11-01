import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, toolApplications, toolConnections, toolCatalogEntries, toolProfiles, toolProfileBindings, toolProfileEntries, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("catalog publication", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let applicationId: string;
  let connectionId: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-catalog-publication-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Catalog fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Fixture MCP", type: "mcp_http" }).returning(); applicationId = application.id;
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId, name: "Fixture connection", uid: randomUUID(), transport: "mcp_remote", authKind: "none", enabled: true, status: "active", config: { url: "https://mcp.example.test/mcp" } }).returning(); connectionId = connection.id;
  });

  const serviceWithTools = (tools: unknown[]) => toolAccessService(db, {
    remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
    remoteHttpRequest: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools } }), { headers: { "content-type": "application/json" } });
    },
  });
  it.each([250, 2500])("publishes a real %i-tool catalog in bounded chunks and preserves row identities", async count => {
    const tools = Array.from({ length: count }, (_, index) => ({ name: `search_${index}`, description: "Search fixture records", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }));
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    const service = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools } }), { headers: { "content-type": "application/json" } });
      },
    });
    let catalogWrites = 0;
    const transaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((async (operation, config) => transaction(async tx => {
      const insert = tx.insert.bind(tx);
      const insertSpy = vi.spyOn(tx, "insert").mockImplementation(((table: Parameters<typeof tx.insert>[0]) => {
        if (table === toolCatalogEntries) catalogWrites += 1;
        return insert(table);
      }) as typeof tx.insert);
      try { return await operation(tx); }
      finally { insertSpy.mockRestore(); }
    }, config)) as typeof db.transaction);
    expect((await service.refreshCatalog(connectionId)).catalog).toHaveLength(count);
    expect(catalogWrites).toBe(Math.ceil(count / 500));
    const first = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)).orderBy(toolCatalogEntries.toolName);
    expect((await service.refreshCatalog(connectionId)).catalog).toHaveLength(count);
    expect(catalogWrites).toBe(2 * Math.ceil(count / 500));
    transactionSpy.mockRestore();
    const second = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)).orderBy(toolCatalogEntries.toolName);
    expect(second.map(row => [row.id, row.firstSeenAt, row.status])).toEqual(first.map(row => [row.id, row.firstSeenAt, row.status]));
  });
  it("refreshes known tools from overlapping MCP pages using the last descriptor", async () => {
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    let overlap = false;
    const descriptor = (description: string) => ({ name: "search", description, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } });
    const service = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" }
          : body.params?.cursor ? { tools: [descriptor("Last page")] }
          : { tools: [descriptor("First page")], ...(overlap ? { nextCursor: "overlap" } : {}) };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
      },
    });
    await service.refreshCatalog(connectionId);
    const [first] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));
    overlap = true;
    expect((await service.refreshCatalog(connectionId)).catalog).toHaveLength(1);
    const rows = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, firstSeenAt: first.firstSeenAt, description: "Last page" });
  });

  it("preserves operator-disabled tools and unchanged pending reviews", async () => {
    const tools = ["off", "review"].map(name => ({ name, description: "Initial tool", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }));
    const service = serviceWithTools(tools);
    await service.refreshCatalog(connectionId);
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp", quarantineNewEntries: true } }).where(eq(toolConnections.id, connectionId));
    await db.update(toolCatalogEntries).set({ status: "disabled", quarantineReason: null }).where(and(eq(toolCatalogEntries.connectionId, connectionId), eq(toolCatalogEntries.toolName, "off")));
    const reviewedAt = new Date("2020-01-01T00:00:00Z");
    await db.update(toolCatalogEntries).set({ status: "quarantined", quarantineReason: "pending_review", quarantinedAt: reviewedAt }).where(and(eq(toolCatalogEntries.connectionId, connectionId), eq(toolCatalogEntries.toolName, "review")));
    const before = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)).orderBy(toolCatalogEntries.toolName);
    const result = await service.refreshCatalog(connectionId);
    expect(result.catalog.map(entry => [entry.toolName, entry.status])).toEqual([["off", "disabled"], ["review", "quarantined"]]);
    const after = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)).orderBy(toolCatalogEntries.toolName);
    expect(after.map(row => [row.id, row.firstSeenAt, row.status, row.quarantinedAt, row.quarantineReason])).toEqual(before.map(row => [row.id, row.firstSeenAt, row.status, row.quarantinedAt, row.quarantineReason]));
  });

  it.each(["new", "quarantined"] as const)("does not restore an Off action after overlapping refreshes of a %s tool", async state => {
    await serviceWithTools([]).refreshCatalog(connectionId);
    if (state === "quarantined") await db.insert(toolCatalogEntries).values({
      companyId, applicationId, connectionId, name: "search", toolName: "search", riskLevel: "read",
      status: "quarantined", versionHash: "fixture-version", schemaHash: "fixture-schema", quarantineReason: "pending_review", quarantinedAt: new Date("2020-01-01T00:00:00Z"),
    });
    const [agent] = await db.insert(agents).values({ companyId, name: "Catalog permission fixture", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    const service = serviceWithTools([{ name: "search", annotations: { readOnlyHint: true } }]);
    const transaction = db.transaction.bind(db);
    let paused = false;
    let release!: () => void;
    const resume = new Promise<void>(resolve => { release = resolve; });
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((async (operation, config) => {
      if (!paused) { paused = true; await resume; }
      return transaction(operation, config);
    }) as typeof db.transaction);
    const later = Promise.allSettled([service.refreshCatalog(connectionId, undefined, { enableAllByDefault: true })]);
    try {
      await vi.waitFor(() => expect(paused).toBe(true), { timeout: 5000 });
      const first = await service.refreshCatalog(connectionId, undefined, { enableAllByDefault: true });
      const entry = first.catalog[0];
      const decide = () => toolAccessPolicyService(db).decide({ companyId, actor: { actorType: "agent", actorId: agent.id }, request: { connectionId, catalogEntryId: entry.id, toolName: entry.toolName, arguments: {} } });
      await expect(decide()).resolves.toMatchObject({ decision: "allow", reasonCode: "allow_profile" });
      const [selection] = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.catalogEntryId, entry.id));
      await service.deleteProfileEntry(selection.id);
      await expect(decide()).resolves.toMatchObject({ decision: "deny" });
      release();
      const [result] = await later;
      if (result.status === "rejected") throw result.reason;
      await expect(decide()).resolves.toMatchObject({ decision: "deny" });
      expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId))).toHaveLength(1);
      expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.catalogEntryId, entry.id))).toHaveLength(0);
    } finally { release(); await later; transactionSpy.mockRestore(); }
  }, 15000);

  it("keeps committed chunks and rolls back a failed default-profile publication", async () => {
    const service = serviceWithTools(Array.from({ length: 501 }, (_, index) => ({ name: `search_${index}`, annotations: { readOnlyHint: true } })));
    const transaction = db.transaction.bind(db);
    let catalogWrites = 0;
    let failProfile = false;
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((async (operation, config) => transaction(async tx => {
      const insert = tx.insert.bind(tx);
      const insertSpy = vi.spyOn(tx, "insert").mockImplementation(((table: Parameters<typeof tx.insert>[0]) => {
        if (table === toolCatalogEntries && ++catalogWrites === 2) throw new Error("second chunk failed");
        if (table === toolProfileBindings && failProfile) throw new Error("profile binding failed");
        return insert(table);
      }) as typeof tx.insert);
      try { return await operation(tx); }
      finally { insertSpy.mockRestore(); }
    }, config)) as typeof db.transaction);
    await expect(service.refreshCatalog(connectionId)).rejects.toThrow("second chunk failed");
    expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId))).toHaveLength(500);
    failProfile = true;
    await expect(service.refreshCatalog(connectionId)).rejects.toThrow("profile binding failed");
    expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId))).toHaveLength(501);
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId))).toHaveLength(0);
    transactionSpy.mockRestore();
    await service.refreshCatalog(connectionId);
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId))).toHaveLength(1);
  });

  it("waits for application publication before changing catalog rows", async () => {
    const tools = [{ name: "search", description: "Initial search", annotations: { readOnlyHint: true } }];
    const service = serviceWithTools(tools);
    await service.refreshCatalog(connectionId);
    tools[0].description = "Changed search";
    let locked!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(toolApplications).where(eq(toolApplications.id, applicationId)).for("no key update");
      locked(); await resume;
    });
    await held;
    const transaction = db.transaction.bind(db);
    let started!: (pid: number) => void;
    const begun = new Promise<number>(resolve => { started = resolve; });
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((async (operation, config) => transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [backend] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(backend.pid));
      return operation(tx);
    }, config)) as typeof db.transaction);
    const refresh = Promise.allSettled([service.refreshCatalog(connectionId)]);
    try {
      const pid = await begun;
      await vi.waitFor(async () => {
        const [activity] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(activity.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
      expect((await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)))[0].description).toBe("Initial search");
    } finally { release(); await blocker; }
    const [result] = await refresh;
    if (result.status === "rejected") throw result.reason;
    transactionSpy.mockRestore();
    expect((await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)))[0].description).toBe("Changed search");
  }, 15000);
});
