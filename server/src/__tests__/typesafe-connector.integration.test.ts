import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  assignedTypesafeConnections,
  executeTypesafeAsk,
} from "../services/connectors/typesafe.js";
import {
  applyConnectorSkills,
  resolveConnectorAssignments,
} from "../services/connector-runtime.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const KEY = "ts-connector-test-key";
const STATE = "private-customer-state";
const INSTRUCTIONS = "Is this private-instruction urgent?";
const actor = { actorType: "user" as const, actorId: "board" };
const ANSWER = {
  model: "jev-1.13.0",
  answers: { urgent: { type: "noul", noul: 0.91 } },
  usage: { input_tokens: 40, output_tokens: 3 },
};
const ask = (extra: Record<string, unknown> = {}) => ({
  state: STATE,
  questions: { urgent: { type: "noul", instructions: INSTRUCTIONS } },
  ...extra,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describeEmbeddedPostgres("TypeSafe connector", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-typesafe-connector-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const provider = (evaluateStatus = 200) =>
    vi.fn(async (url: unknown, _init?: RequestInit) =>
      String(url).endsWith("/models")
        ? json({ models: [{ name: "jev-latest" }] })
        : json(evaluateStatus === 200 ? ANSWER : {}, evaluateStatus),
    );
  const evaluateCalls = (fetcher: ReturnType<typeof provider>) =>
    fetcher.mock.calls.filter(([url]) => String(url).endsWith("/systemone"));

  async function fixture(access: "all_agents" | "first_agent" | "none" = "all_agents") {
    const [company] = await db
      .insert(companies)
      .values({
        name: `TypeSafe ${randomUUID()}`,
        issuePrefix: `TS${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    const makeAgent = () =>
      db
        .insert(agents)
        .values({
          companyId: company!.id,
          name: `Agent ${randomUUID()}`,
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
        })
        .returning()
        .then((rows) => rows[0]!);
    const first = await makeAgent();
    const second = await makeAgent();
    const connectionId = await connectTypesafe(company!.id, access, first.id);
    return { companyId: company!.id, first, second, connectionId };
  }

  async function connectTypesafe(
    companyId: string,
    access: "all_agents" | "first_agent" | "none",
    agentId: string,
    configValues?: Record<string, unknown>,
  ) {
    const service = toolAccessService(db, { typesafeFetch: provider() as unknown as typeof fetch });
    const { connectionId } = await service.connectGalleryApp(
      companyId,
      {
        galleryKey: "typesafe",
        connectionMethodKey: "api-key",
        name: `TypeSafe ${randomUUID().slice(0, 8)}`,
        credentialValues: { "credentials.apiKey": KEY },
        ...(configValues ? { configValues } : {}),
      },
      actor,
    );
    await service.finishGalleryAppConnection(
      companyId,
      connectionId,
      {
        enabledCatalogEntryIds: [],
        askFirstCatalogEntryIds: [],
        access: access === "first_agent" ? { agentIds: [agentId] } : "all_agents",
      },
      actor,
    );
    if (access === "none")
      await db
        .delete(toolConnectionInstalls)
        .where(eq(toolConnectionInstalls.connectionId, connectionId));
    return connectionId;
  }

  const binding = (companyId: string, agentId: string) => ({
    companyId,
    agentId,
    runId: null,
    issueId: null,
  });

  it("gives no access without an install", async () => {
    const { companyId, first } = await fixture("none");
    const fetcher = provider();
    expect(await assignedTypesafeConnections(db, { companyId, agentId: first.id })).toEqual([]);
    await expect(
      executeTypesafeAsk(db, binding(companyId, first.id), ask(), fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("gives every agent access through a company install", async () => {
    const { companyId, first, second, connectionId } = await fixture("all_agents");
    for (const agent of [first, second]) {
      const assigned = await assignedTypesafeConnections(db, { companyId, agentId: agent.id });
      expect(assigned.map((connection) => connection.id)).toEqual([connectionId]);
    }
  });

  it("limits an agent install to that agent", async () => {
    const { companyId, first, second, connectionId } = await fixture("first_agent");
    expect(
      (await assignedTypesafeConnections(db, { companyId, agentId: first.id })).map((c) => c.id),
    ).toEqual([connectionId]);
    expect(await assignedTypesafeConnections(db, { companyId, agentId: second.id })).toEqual([]);
  });

  it("never crosses a company boundary", async () => {
    const owner = await fixture("all_agents");
    const other = await fixture("none");
    expect(
      await assignedTypesafeConnections(db, { companyId: other.companyId, agentId: other.first.id }),
    ).toEqual([]);
    // A forged binding that pairs another company's agent with the owner company.
    expect(
      await assignedTypesafeConnections(db, { companyId: other.companyId, agentId: owner.first.id }),
    ).toEqual([]);
    await expect(
      executeTypesafeAsk(
        db,
        binding(other.companyId, other.first.id),
        ask({ connectionId: owner.connectionId }),
        provider() as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each(["disabled", "archived"] as const)("drops a %s connection", async (status) => {
    const { companyId, first, connectionId } = await fixture("all_agents");
    await db.update(toolConnections).set({ status }).where(eq(toolConnections.id, connectionId));
    expect(await assignedTypesafeConnections(db, { companyId, agentId: first.id })).toEqual([]);
  });

  it("drops a connection that is switched off", async () => {
    const { companyId, first, connectionId } = await fixture("all_agents");
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, connectionId));
    expect(await assignedTypesafeConnections(db, { companyId, agentId: first.id })).toEqual([]);
  });

  it("refuses a call after access is revoked mid-run", async () => {
    const { companyId, first, connectionId } = await fixture("all_agents");
    const fetcher = provider();
    await executeTypesafeAsk(db, binding(companyId, first.id), ask(), fetcher as unknown as typeof fetch);
    await db
      .delete(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, connectionId));
    await expect(
      executeTypesafeAsk(db, binding(companyId, first.id), ask(), fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 403 });
    expect(evaluateCalls(fetcher)).toHaveLength(1);
  });

  it("asks with the connection model and returns the provider answer", async () => {
    const { companyId, first } = await fixture("all_agents");
    const fetcher = provider();
    const result = await executeTypesafeAsk(
      db,
      binding(companyId, first.id),
      ask(),
      fetcher as unknown as typeof fetch,
    );
    expect(result).toEqual(ANSWER);
    const [[, init]] = evaluateCalls(fetcher);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      state: STATE,
      model: "jev-latest",
      questions: { urgent: { type: "noul", instructions: INSTRUCTIONS } },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("lets a call override the model", async () => {
    const { companyId, first } = await fixture("all_agents");
    const fetcher = provider();
    await executeTypesafeAsk(
      db,
      binding(companyId, first.id),
      ask({ model: "jev-preview" }),
      fetcher as unknown as typeof fetch,
    );
    expect(JSON.parse(String(evaluateCalls(fetcher)[0]![1]?.body)).model).toBe("jev-preview");
  });

  it("requires a connection choice when two are assigned", async () => {
    const { companyId, first, connectionId } = await fixture("all_agents");
    const secondConnectionId = await connectTypesafe(companyId, "all_agents", first.id, {
      model: "jev-preview",
    });
    const fetcher = provider();
    await expect(
      executeTypesafeAsk(db, binding(companyId, first.id), ask(), fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 422, details: { code: "typesafe_connection_required" } });
    expect(evaluateCalls(fetcher)).toHaveLength(0);

    await executeTypesafeAsk(
      db,
      binding(companyId, first.id),
      ask({ connectionId: secondConnectionId }),
      fetcher as unknown as typeof fetch,
    );
    expect(JSON.parse(String(evaluateCalls(fetcher)[0]![1]?.body)).model).toBe("jev-preview");

    await expect(
      executeTypesafeAsk(
        db,
        binding(companyId, first.id),
        ask({ connectionId: randomUUID() }),
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(connectionId).not.toBe(secondConnectionId);
  });

  it("rejects a malformed request before contacting TypeSafe", async () => {
    const { companyId, first } = await fixture("all_agents");
    const fetcher = provider();
    await expect(
      executeTypesafeAsk(
        db,
        binding(companyId, first.id),
        { state: STATE, questions: { q: { type: "score", instructions: "?", criteria: ["only"] } } },
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [429, 429, "typesafe_rate_limited", true],
    [529, 503, "typesafe_overloaded", true],
    [400, 422, "typesafe_invalid_request", false],
    [422, 422, "typesafe_invalid_request", false],
    [401, 502, "typesafe_api_key_rejected", false],
  ])("surfaces provider %i as %i without retrying", async (providerStatus, status, code, retryable) => {
    const { companyId, first } = await fixture("all_agents");
    const fetcher = provider(providerStatus);
    await expect(
      executeTypesafeAsk(db, binding(companyId, first.id), ask(), fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({ status, details: { code, retryable } });
    expect(evaluateCalls(fetcher)).toHaveLength(1);
  });

  it("reports an unreadable provider answer as a gateway failure, not a bad request", async () => {
    const { companyId, first } = await fixture("all_agents");
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      json({ model: "jev-1.13.0", answers: { urgent: { type: "essay", text: STATE } }, usage: {} }),
    );
    const error = await executeTypesafeAsk(
      db,
      binding(companyId, first.id),
      ask(),
      fetcher as unknown as typeof fetch,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 502,
      details: { code: "typesafe_invalid_response", retryable: false },
    });
    expect(JSON.stringify([(error as Error).message, (error as { details?: unknown }).details])).not.toContain(STATE);
  });

  it("logs usage without state, instructions, answers or the key", async () => {
    const { companyId, first, connectionId } = await fixture("all_agents");
    await executeTypesafeAsk(
      db,
      binding(companyId, first.id),
      ask(),
      provider() as unknown as typeof fetch,
    );
    const rows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "typesafe.ask")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "agent",
      actorId: first.id,
      entityType: "tool_connection",
      entityId: connectionId,
      details: { model: "jev-latest", questionCount: 1, inputTokens: 40, outputTokens: 3 },
    });
    const rendered = JSON.stringify(rows[0]);
    for (const secret of [KEY, STATE, "private-instruction", "0.91"])
      expect(rendered).not.toContain(secret);
  });

  it("contributes the tool and skill only to eligible agents", async () => {
    const { companyId, first, second, connectionId } = await fixture("first_agent");
    const eligible = await resolveConnectorAssignments(db, { companyId, agentId: first.id });
    expect(eligible).toEqual([
      expect.objectContaining({
        key: "typesafe",
        skillKey: "paperclipai/paperclip/typesafe",
        resources: [expect.objectContaining({ id: connectionId, connectionId })],
        tools: [expect.objectContaining({ name: "typesafe_ask" })],
      }),
    ]);
    expect(await resolveConnectorAssignments(db, { companyId, agentId: second.id })).toEqual([]);

    const config = await applyConnectorSkills({}, [], eligible);
    const skill = config.paperclipRuntimeSkills.find(
      (entry) => entry.key === "paperclipai/paperclip/typesafe",
    );
    expect(skill).toBeTruthy();
    const markdown = await fs.readFile(path.join(skill!.source, "SKILL.md"), "utf8");
    expect(markdown).toContain("typesafe_ask");
    expect(markdown).toContain(connectionId);
    expect(markdown).not.toContain(KEY);
  });
});
