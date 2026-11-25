import { randomUUID, generateKeyPairSync, createHash, createHmac, sign } from "node:crypto";
import { mkdtemp, writeFile, rm, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import {
  INSPECTION_AUDIENCE,
  INSPECTION_HEADER,
  INSPECTION_PERMIT_TYPE,
  INSPECTION_RESOURCES,
  inspectionReadPath,
  parseInspectionQuery,
  type InspectionQuery,
  type InspectionPermit,
} from "@paperclipai/shared";
import { customerSuccessRunAuthority } from "../services/customer-success-authority.js";
import {
  readCustomerSuccessResource,
  inspectionReaders,
  RUN_SUMMARY_COLUMNS,
  primaryKeyColumns,
} from "../services/customer-success-inspection.js";
import { searchCustomerSuccessRuns } from "../services/customer-success-run-search.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import type { RunLogStore } from "../services/run-log-store.js";
import {
  customerSuccessRoutes,
  fitInspectionResponse,
  verifyInspectionPermit,
} from "../routes/customer-success.js";
import { agentIdentityService } from "../services/agent-identity.js";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { errorHandler } from "../middleware/error-handler.js";
import { redactAgentAdapterConfig } from "../redaction.js";
import type { StorageService } from "../storage/types.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("customer-success read authority", () => {
  let db: schema.Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let directory: string;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let runId: string;
  let bearer: string;
  const storage: StorageService = {
    provider: "local_disk",
    putFile: async () => {
      throw new Error("write forbidden");
    },
    deleteObject: async () => {
      throw new Error("write forbidden");
    },
    headObject: async () => ({ exists: true }),
    getObject: async (_companyId, _objectKey, opts) => ({
      stream: Readable.from([
        Buffer.from([0, 1, 2, 3, 4]).subarray(
          opts?.range?.start ?? 0,
          opts?.range ? opts.range.end + 1 : undefined,
        ),
      ]),
      contentType: "application/octet-stream",
    }),
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "inspection-test-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "inspection-home");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "inspection-local-fixture");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    database = await startEmbeddedPostgresTestDatabase("inspection-db-");
    db = schema.createDb(database.connectionString);
    const companies = await db
      .insert(schema.companies)
      .values([
        { name: "Customer", issuePrefix: "CUS" },
        { name: "Other", issuePrefix: "OTH" },
      ])
      .returning();
    companyId = companies[0].id;
    otherCompanyId = companies[1].id;
    const [agent] = await db
      .insert(schema.agents)
      .values({ companyId, name: "Managed inspection fixture", adapterType: "process" })
      .returning();
    agentId = agent.id;
    const [run] = await db
      .insert(schema.heartbeatRuns)
      .values({ companyId, agentId, status: "running", startedAt: new Date() })
      .returning();
    runId = run.id;
    bearer = createLocalAgentJwt(agentId, companyId, "process", runId)!;
  });
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it("unprovisioned reads never generate a key, strict authority requires a current managed run", async () => {
    await expect(customerSuccessRunAuthority(db, bearer)).rejects.toThrow("unprovisioned");
    expect(await db.select().from(schema.agentIdentityKeys)).toHaveLength(0);
    const key = await agentIdentityService(db).ensureAgentIdentity(companyId, agentId);
    expect(await customerSuccessRunAuthority(db, bearer)).toEqual({
      version: 1,
      active: true,
      instanceId: "inspection-home",
      companyId,
      agentId,
      runId,
      keyId: key.keyId,
    });
    await expect(customerSuccessRunAuthority(db, "ordinary-api-key")).rejects.toThrow(
      "managed-run",
    );
    await db.update(schema.agents).set({ status: "paused" }).where(eq(schema.agents.id, agentId));
    await expect(customerSuccessRunAuthority(db, bearer)).rejects.toThrow("not active");
    await db.update(schema.agents).set({ status: "idle" }).where(eq(schema.agents.id, agentId));
    await db
      .update(schema.heartbeatRuns)
      .set({ resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(schema.heartbeatRuns.id, runId));
    await expect(customerSuccessRunAuthority(db, bearer)).rejects.toThrow("not active");
    await db
      .update(schema.heartbeatRuns)
      .set({ resultJson: null, status: "succeeded" })
      .where(eq(schema.heartbeatRuns.id, runId));
    await expect(customerSuccessRunAuthority(db, bearer)).rejects.toThrow("not active");
    await db
      .update(schema.heartbeatRuns)
      .set({ status: "running" })
      .where(eq(schema.heartbeatRuns.id, runId));
  });
  it("rejects legacy signatures, missing instance claims and foreign-instance derived tokens", async () => {
    const [header, payload] = bearer.split(".");
    const input = `${header}.${payload}`;
    const legacy = `${input}.${createHmac("sha256", "inspection-local-fixture").update(input).digest("base64url")}`;
    expect(verifyLocalAgentJwt(legacy)).not.toBeNull();
    expect(verifyLocalAgentJwt(legacy, { strictRunAuthority: true })).toBeNull();
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "development-clone");
    const foreign = createLocalAgentJwt(agentId, companyId, "process", runId)!;
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "inspection-home");
    await expect(customerSuccessRunAuthority(db, foreign)).rejects.toThrow("managed-run");
  });
  it("every catalog reader is company scoped, paginated, and leaves the complete database unchanged", async () => {
    const snapshot = async () => {
      const tables = await db.execute(
        sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
      );
      const data: Record<string, unknown> = {};
      for (const table of tables) {
        const name = String(table.tablename).replaceAll('"', '""');
        data[name] = await db.execute(
          sql.raw(
            `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM "${name}" t`,
          ),
        );
      }
      return JSON.stringify(data);
    };
    const before = await snapshot();
    for (const resource of INSPECTION_RESOURCES) {
      const result = (await readCustomerSuccessResource(db, storage, {
        operation: "list",
        resource,
        companyId,
        limit: 1,
      })) as { items: unknown[] };
      expect(result.items.length).toBeLessThanOrEqual(1);
    }
    expect(await snapshot()).toEqual(before);
    await expect(
      db.transaction(
        (tx) =>
          tx.update(schema.agents).set({ name: "forbidden" }).where(eq(schema.agents.id, agentId)),
        { accessMode: "read only" },
      ),
    ).rejects.toThrow();
    expect(inspectionReaders.agentIdentities.omit).toContain("privateKeyMaterial");
    const identity = (await readCustomerSuccessResource(db, storage, {
      operation: "get",
      resource: "agentIdentities",
      companyId,
      resourceId: agentId,
    })) as Record<string, unknown>;
    expect(identity).not.toHaveProperty("privateKeyMaterial");
    await expect(
      readCustomerSuccessResource(db, storage, {
        operation: "get",
        resource: "agentIdentities",
        companyId: otherCompanyId,
        resourceId: agentId,
      }),
    ).rejects.toThrow("not found");
  });
  it("returns tasks/documents verbatim and uses existing adapter config redaction", async () => {
    await db
      .update(schema.agents)
      .set({
        adapterConfig: {
          env: { API_KEY: "hidden", NOTE: "same existing env policy" },
          promptTemplate: "Do useful work",
        },
      })
      .where(eq(schema.agents.id, agentId));
    const agent = (await readCustomerSuccessResource(db, storage, {
      operation: "get",
      resource: "agents",
      companyId,
      resourceId: agentId,
    })) as { adapterConfig: { env: Record<string, unknown>; promptTemplate: string } };
    expect(JSON.stringify(agent)).not.toContain("hidden");
    expect(agent.adapterConfig.promptTemplate).toEqual("Do useful work");
    const [task] = await db
      .insert(schema.issues)
      .values({
        companyId,
        title: "A pasted instruction",
        description: "Keep prose unchanged: arbitrary pasted material",
      })
      .returning();
    const taskResult = (await readCustomerSuccessResource(db, storage, {
      operation: "get",
      resource: "tasks",
      companyId,
      resourceId: task.id,
    })) as { description: string };
    expect(taskResult.description).toEqual(task.description);
    await expect(
      readCustomerSuccessResource(db, storage, {
        operation: "get",
        resource: "tasks",
        companyId: otherCompanyId,
        resourceId: task.id,
      }),
    ).rejects.toThrow("not found");
  });
  it("reads existing instruction files without recovery, adoption, or filesystem writes", async () => {
    const file = join(directory, "AGENTS.md");
    await writeFile(file, "# Investigate carefully\n");
    await db
      .update(schema.agents)
      .set({ adapterConfig: { instructionsFilePath: file } })
      .where(eq(schema.agents.id, agentId));
    const before = await stat(file);
    const count = (await db.select().from(schema.agentInstructionRevisions)).length;
    const result = (await readCustomerSuccessResource(db, storage, {
      operation: "instructions.file",
      companyId,
      resourceId: agentId,
    })) as { content: string };
    expect(Buffer.from(result.content, "base64").toString()).toEqual("# Investigate carefully\n");
    expect((await stat(file)).mtimeMs).toEqual(before.mtimeMs);
    expect((await db.select().from(schema.agentInstructionRevisions)).length).toEqual(count);
    await writeFile(join(directory, ".env"), "CREDENTIAL=do-not-return");
    await expect(
      readCustomerSuccessResource(db, storage, {
        operation: "instructions.file",
        companyId,
        resourceId: agentId,
        path: ".env",
      }),
    ).rejects.toThrow("denied by policy");
    await symlink(file, join(directory, "linked.md"));
    await expect(
      readCustomerSuccessResource(db, storage, {
        operation: "instructions.file",
        companyId,
        resourceId: agentId,
        path: "linked.md",
      }),
    ).rejects.toThrow("symlink");
  });
  it("reuses environment redaction for project and routine configuration and revisions", async () => {
    const env = {
      CONFIG: { type: "plain" as const, value: "configuration-credential" },
      REFERENCE: {
        type: "secret_ref" as const,
        secretId: randomUUID(),
        version: "latest" as const,
      },
    };
    const [project] = await db
      .insert(schema.projects)
      .values({ companyId, name: "Configured project", env })
      .returning();
    const [routine] = await db
      .insert(schema.routines)
      .values({ companyId, title: "Configured routine", env })
      .returning();
    const [revision] = await db
      .insert(schema.routineRevisions)
      .values({
        companyId,
        routineId: routine.id,
        revisionNumber: 1,
        title: routine.title,
        snapshot: {
          version: 1,
          routine: { ...routine },
          triggers: [],
        } as typeof schema.routineRevisions.$inferInsert.snapshot,
      })
      .returning();
    const expected = redactAgentAdapterConfig({ env }).env;
    for (const [resource, resourceId] of [
      ["projects", project.id],
      ["routines", routine.id],
      ["routineRevisions", revision.id],
    ] as const) {
      const row = (await readCustomerSuccessResource(db, storage, {
        operation: "get",
        resource,
        companyId,
        resourceId,
      })) as { env?: unknown; snapshot?: { routine: { env: unknown } } };
      expect(row.snapshot?.routine.env ?? row.env).toEqual(expected);
      expect(JSON.stringify(row)).not.toContain("configuration-credential");
    }
    await expect(
      readCustomerSuccessResource(db, storage, {
        operation: "get",
        resource: "users",
        companyId,
        resourceId: "missing",
      }),
    ).rejects.toThrow("not found");
  });
  it("asset bytes and bounded byte ranges are company scoped, without bypass URLs", async () => {
    const [asset] = await db
      .insert(schema.assets)
      .values({
        companyId,
        provider: "local_disk",
        objectKey: "test/object",
        contentType: "application/octet-stream",
        byteSize: 5,
        sha256: "fixture",
      })
      .returning();
    const result = (await readCustomerSuccessResource(db, storage, {
      operation: "assets.content",
      companyId,
      resourceId: asset.id,
      range: { start: 1, end: 3 },
    })) as { content: string; bytes: number };
    expect(Buffer.from(result.content, "base64")).toEqual(Buffer.from([1, 2, 3]));
    expect(result.bytes).toEqual(3);
    await expect(
      readCustomerSuccessResource(db, storage, {
        operation: "assets.content",
        companyId: otherCompanyId,
        resourceId: asset.id,
      }),
    ).rejects.toThrow("not found");
  });
  it("tenant requests verify exact Cloud permit parameters, consume centrally, reject cookies and unknown paths", async () => {
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "fixture-stack");
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_CLOUD_ORIGIN", "https://cloud.example.test");
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_AUTHORITY_ENABLED", "true");
    const keys = generateKeyPairSync("ed25519");
    const jwks = { keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "cloud" }] };
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_JWKS", JSON.stringify(jwks));
    const query: InspectionQuery = {
      operation: "get",
      resource: "companies",
      companyId,
      resourceId: companyId,
    };
    const now = Math.floor(Date.now() / 1000);
    const claims: InspectionPermit = {
      v: 1,
      iss: "paperclip-cloud",
      aud: INSPECTION_AUDIENCE,
      sub: "fixture-stack",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      bindingVersion: 1,
      grantId: randomUUID(),
      requestId: randomUUID(),
      agentId,
      keyId: "sha256:fixture",
      runId,
      query,
    };
    function token(value = claims, privateKey = keys.privateKey) {
      const header = Buffer.from(
        JSON.stringify({ alg: "EdDSA", typ: INSPECTION_PERMIT_TYPE, kid: "cloud" }),
      ).toString("base64url");
      const body = Buffer.from(JSON.stringify(value)).toString("base64url");
      const input = `${header}.${body}`;
      return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
    }
    const fetcher = vi.fn().mockResolvedValue(Response.json({ consumed: true }));
    vi.stubGlobal("fetch", fetcher);
    const app = express();
    app.use(express.json());
    app.use("/api/customer-success/v1", customerSuccessRoutes(db, storage));
    app.use(errorHandler);
    const response = await request(app)
      .post("/api/customer-success/v1/read")
      .set(INSPECTION_HEADER, token())
      .send(query);
    expect(response.status).toEqual(200);
    expect(response.headers["cache-control"]).toEqual("no-store");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toEqual(
      "https://cloud.example.test/v1/customer-success/permits/consume",
    );
    expect(
      (
        await request(app)
          .post("/api/customer-success/v1/read")
          .set(INSPECTION_HEADER, token())
          .send({ ...query, resource: "agents" })
      ).status,
    ).toEqual(403);
    expect(
      (
        await request(app)
          .post("/api/customer-success/v1/read")
          .set(INSPECTION_HEADER, token())
          .set("Cookie", "session=ignored")
          .send(query)
      ).status,
    ).toEqual(403);
    expect(
      (
        await request(app)
          .get("/api/customer-success/v1/run-authority")
          .set("Authorization", `Bearer ${bearer}`)
      ).status,
    ).toEqual(200);
    expect((await request(app).post("/api/customer-success/v1/unknown").send({})).status).toEqual(
      404,
    );
    // Count, order and view live only on the extended path, so a tenant that
    // predates them answers 404 there and Cloud fails closed.
    const countQuery: InspectionQuery = { operation: "count", resource: "tasks", companyId };
    const countToken = () => token({ ...claims, jti: randomUUID(), query: countQuery });
    expect(
      (
        await request(app)
          .post("/api/customer-success/v1/read")
          .set(INSPECTION_HEADER, countToken())
          .send(countQuery)
      ).status,
    ).toEqual(403);
    const counted = await request(app)
      .post("/api/customer-success/v1/read-v2")
      .set(INSPECTION_HEADER, countToken())
      .send(countQuery);
    expect(counted.status).toEqual(200);
    expect(counted.body).toEqual({ total: expect.any(Number), byStatus: expect.any(Object) });
    const original = await request(app)
      .post("/api/customer-success/v1/read-v2")
      .set(INSPECTION_HEADER, token())
      .send(query);
    expect(original.status).toEqual(200);
    fetcher.mockResolvedValue(new Response("", { status: 503 }));
    expect(
      (
        await request(app)
          .post("/api/customer-success/v1/read")
          .set(INSPECTION_HEADER, token())
          .send(query)
      ).status,
    ).toEqual(403);
    expect(() =>
      verifyInspectionPermit(token({ ...claims, sub: "other-stack" }), jwks, "fixture-stack"),
    ).toThrow();
    expect(() =>
      verifyInspectionPermit(token({ ...claims, exp: now }), jwks, "fixture-stack"),
    ).toThrow();
    expect(() =>
      verifyInspectionPermit(token({ ...claims, exp: now + 61 }), jwks, "fixture-stack"),
    ).toThrow();
    expect(() =>
      verifyInspectionPermit(
        token(claims, generateKeyPairSync("ed25519").privateKey),
        jwks,
        "fixture-stack",
      ),
    ).toThrow();
  });
  it("fits an oversized list page to the response limit and points nextOffset at the first omitted row", async () => {
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "fixture-stack");
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_CLOUD_ORIGIN", "https://cloud.example.test");
    const keys = generateKeyPairSync("ed25519");
    vi.stubEnv(
      "PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_JWKS",
      JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "cloud" }] }),
    );
    const [bulky] = await db
      .insert(schema.companies)
      .values({ name: "Bulky", issuePrefix: "BLK" })
      .returning();
    await db.insert(schema.issues).values(
      Array.from({ length: 40 }, (_, index) => ({
        companyId: bulky.id,
        title: `Large task ${index}`,
        description: "x".repeat(200 * 1024),
      })),
    );
    function permitFor(query: InspectionQuery) {
      const now = Math.floor(Date.now() / 1000);
      const claims: InspectionPermit = {
        v: 1,
        iss: "paperclip-cloud",
        aud: INSPECTION_AUDIENCE,
        sub: "fixture-stack",
        iat: now,
        exp: now + 60,
        jti: randomUUID(),
        bindingVersion: 1,
        grantId: randomUUID(),
        requestId: randomUUID(),
        agentId,
        keyId: "sha256:fixture",
        runId,
        query,
      };
      const header = Buffer.from(
        JSON.stringify({ alg: "EdDSA", typ: INSPECTION_PERMIT_TYPE, kid: "cloud" }),
      ).toString("base64url");
      const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      return `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString("base64url")}`;
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ consumed: true })));
    const app = express();
    app.use(express.json());
    app.use("/api/customer-success/v1", customerSuccessRoutes(db, storage));
    app.use(errorHandler);
    async function page(offset: number) {
      const query: InspectionQuery = {
        operation: "list",
        resource: "tasks",
        companyId: bulky.id,
        limit: 25,
        offset,
      };
      return request(app)
        .post("/api/customer-success/v1/read")
        .set(INSPECTION_HEADER, permitFor(query))
        .send(query);
    }
    const ordered = (
      await db
        .select({ id: schema.issues.id })
        .from(schema.issues)
        .where(eq(schema.issues.companyId, bulky.id))
        .orderBy(schema.issues.id)
    ).map((row) => row.id);

    const first = await page(5);
    expect(first.status).toEqual(200);
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(2 * 1024 * 1024);
    const count = first.body.items.length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(20);
    expect(first.body.nextOffset).toEqual(5 + count);
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual(ordered.slice(5, 5 + count));

    const second = await page(first.body.nextOffset);
    expect(second.status).toEqual(200);
    const next = second.body.items.map((item: { id: string }) => item.id);
    expect(next).toEqual(ordered.slice(5 + count, 5 + count + next.length));
    vi.unstubAllGlobals();
  });

  it("returns null only when a single item cannot fit, and fits only list pages", () => {
    const files = { kind: "files", truncated: true, items: ["a".repeat(40), "b".repeat(40), "c".repeat(40)] };
    expect(fitInspectionResponse(files, "files.list", 0, 120)).toBeNull();
    const small = { items: [1, 2, 3], nextOffset: null };
    expect(fitInspectionResponse(small, "list", 0, 1024)).toEqual(JSON.stringify(small));
    const big = { items: ["a".repeat(40), "b".repeat(40), "c".repeat(40)], nextOffset: 3 };
    expect(JSON.parse(fitInspectionResponse(big, "list", 10, 120)!)).toEqual({
      items: ["a".repeat(40), "b".repeat(40)],
      nextOffset: 12,
    });
    expect(fitInspectionResponse({ items: ["a".repeat(200), "b"], nextOffset: null }, "list", 0, 100)).toBeNull();
    expect(fitInspectionResponse({ content: "a".repeat(200) }, "get", 0, 100)).toBeNull();
  });

  it("reads assigned repository URLs, snapshotted skill files, and workspace downloads with existing file restrictions", async () => {
    const root = await mkdtemp(join(directory, "workspace-"));
    await writeFile(join(root, "result.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(join(root, ".env"), "TOKEN=fixture");
    await symlink(join(root, "result.bin"), join(root, "link.bin"));
    const [project] = await db
      .insert(schema.projects)
      .values({ companyId, name: "Onboarding repo" })
      .returning();
    const [workspace] = await db
      .insert(schema.projectWorkspaces)
      .values({
        companyId,
        projectId: project.id,
        name: "Local checkout",
        cwd: root,
        repoUrl: "https://github.com/example/onboarding",
      })
      .returning();
    const [issue] = await db
      .insert(schema.issues)
      .values({ companyId, projectId: project.id, title: "Workspace outputs" })
      .returning();
    const base = {
      companyId,
      resourceId: issue.id,
      context: { projectId: project.id, workspaceId: workspace.id },
    };
    const repo = (await readCustomerSuccessResource(db, storage, {
      operation: "get",
      resource: "projectWorkspaces",
      companyId,
      resourceId: workspace.id,
    })) as { repoUrl: string };
    expect(repo.repoUrl).toEqual("https://github.com/example/onboarding");
    const before = await stat(join(root, "result.bin"));
    const result = (await readCustomerSuccessResource(db, storage, {
      ...base,
      operation: "files.download",
      path: "result.bin",
      range: { start: 2, end: 7 },
    })) as { content: string; bytes: number };
    expect(Buffer.from(result.content, "base64")).toEqual(Buffer.alloc(6, 7));
    expect(result.bytes).toEqual(6);
    expect((await stat(join(root, "result.bin"))).mtimeMs).toEqual(before.mtimeMs);
    for (const path of [".env", "../result.bin", "link.bin"])
      await expect(
        readCustomerSuccessResource(db, storage, { ...base, operation: "files.download", path }),
      ).rejects.toThrow();
    await expect(
      readCustomerSuccessResource(db, storage, {
        ...base,
        operation: "files.download",
        path: "result.bin",
      }),
    ).rejects.toThrow("bounded byte range");
    const listed = await readCustomerSuccessResource(db, storage, {
      ...base,
      operation: "files.list",
      limit: 5,
    });
    expect(JSON.stringify(listed)).toContain("result.bin");
    expect(
      await readCustomerSuccessResource(db, storage, {
        ...base,
        operation: "files.download",
        path: "empty.txt",
      }),
    ).toMatchObject({ available: true, bytes: 0, content: "" });
    const [unassigned] = await db
      .insert(schema.issues)
      .values({ companyId, title: "No workspace" })
      .returning();
    expect(
      await readCustomerSuccessResource(db, storage, {
        companyId,
        resourceId: unassigned.id,
        operation: "files.read",
        path: "result.txt",
      }),
    ).toMatchObject({ available: false });
    const [skill] = await db
      .insert(schema.companySkills)
      .values({
        companyId,
        key: "example",
        slug: "example",
        name: "Example",
        markdown: "# Example",
        fileInventory: [{ path: "SKILL.md", kind: "markdown", sizeBytes: 9 }],
      })
      .returning();
    const [version] = await db
      .insert(schema.companySkillVersions)
      .values({
        companyId,
        companySkillId: skill.id,
        revisionNumber: 1,
        fileInventory: [{ path: "SKILL.md", kind: "markdown", content: "# Example" }],
      })
      .returning();
    await db
      .update(schema.companySkills)
      .set({ currentVersionId: version.id })
      .where(eq(schema.companySkills.id, skill.id));
    const snapshot = (await readCustomerSuccessResource(db, storage, {
      operation: "skills.file",
      companyId,
      resourceId: skill.id,
    })) as { content: string };
    expect(Buffer.from(snapshot.content, "base64").toString()).toEqual("# Example");
    await expect(
      readCustomerSuccessResource(db, storage, {
        operation: "skills.file",
        companyId,
        resourceId: skill.id,
        path: ".env",
      }),
    ).rejects.toThrow("denied by policy");
    const versions = (await readCustomerSuccessResource(db, storage, {
      operation: "list",
      resource: "skillVersions",
      companyId,
      parentId: skill.id,
    })) as { items: unknown[] };
    expect(versions.items).toHaveLength(1);
  });
  it("counts by status, orders newest first, and returns lean run summaries, company scoped", async () => {
    const [company, other] = await db
      .insert(schema.companies)
      .values([
        { name: "Counted", issuePrefix: "CNT" },
        { name: "Elsewhere", issuePrefix: "ELS" },
      ])
      .returning();
    const [countedAgent] = await db
      .insert(schema.agents)
      .values({ companyId: company.id, name: "Counted agent", adapterType: "process" })
      .returning();
    const [otherAgent] = await db
      .insert(schema.agents)
      .values({ companyId: other.id, name: "Other agent", adapterType: "process" })
      .returning();
    const heavy = { transcript: "x".repeat(200_000) };
    const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
    const runs = await db
      .insert(schema.heartbeatRuns)
      .values([
        { companyId: company.id, agentId: countedAgent.id, status: "succeeded", createdAt: at(1), startedAt: at(1), finishedAt: at(3), resultJson: heavy, contextSnapshot: heavy },
        { companyId: company.id, agentId: countedAgent.id, status: "failed", createdAt: at(5), startedAt: at(5), finishedAt: at(6), errorCode: "adapter_failed", resultJson: heavy },
        { companyId: company.id, agentId: countedAgent.id, status: "failed", createdAt: at(9), startedAt: at(9), resultJson: heavy },
        { companyId: other.id, agentId: otherAgent.id, status: "failed", createdAt: at(20) },
      ])
      .returning();
    await db.insert(schema.issues).values([
      { companyId: company.id, title: "Open", status: "todo" },
      { companyId: company.id, title: "Shipped", status: "done" },
      { companyId: other.id, title: "Not ours", status: "done" },
    ]);

    expect(
      await readCustomerSuccessResource(db, storage, { operation: "count", resource: "runs", companyId: company.id }),
    ).toEqual({ total: 3, byStatus: { succeeded: 1, failed: 2 } });
    expect(
      await readCustomerSuccessResource(db, storage, { operation: "count", resource: "tasks", companyId: company.id }),
    ).toEqual({ total: 2, byStatus: { todo: 1, done: 1 } });
    expect(
      await readCustomerSuccessResource(db, storage, {
        operation: "count",
        resource: "comments",
        companyId: company.id,
      }),
    ).toEqual({ total: 0, byStatus: null });

    const latest = (await readCustomerSuccessResource(db, storage, {
      operation: "list",
      resource: "runs",
      companyId: company.id,
      order: "newest",
      view: "summary",
      limit: 1,
    })) as { items: Array<Record<string, unknown>>; nextOffset: number | null };
    expect(latest.items.map((r) => r.id)).toEqual([runs[2].id]);
    expect(latest.nextOffset).toEqual(1);
    expect(Object.keys(latest.items[0]).sort()).toEqual([...RUN_SUMMARY_COLUMNS, "diagnostics", "durationMs"].sort());
    expect(latest.items[0].durationMs).toBeNull();
    expect(latest.items[0].diagnostics).toEqual([]);
    expect(JSON.stringify(latest).length).toBeLessThan(2_000);

    const page = (await readCustomerSuccessResource(db, storage, {
      operation: "list",
      resource: "runs",
      companyId: company.id,
      order: "newest",
      view: "summary",
      limit: 2,
      offset: 1,
    })) as { items: Array<Record<string, unknown>> };
    expect(page.items.map((r) => [r.id, r.durationMs])).toEqual([
      [runs[1].id, 60_000],
      [runs[0].id, 120_000],
    ]);
    const oldest = (await readCustomerSuccessResource(db, storage, {
      operation: "list",
      resource: "runs",
      companyId: company.id,
      order: "oldest",
      limit: 1,
    })) as { items: Array<Record<string, unknown>> };
    expect(oldest.items[0].id).toEqual(runs[0].id);
    expect(oldest.items[0]).toHaveProperty("resultJson");

    const one = (await readCustomerSuccessResource(db, storage, {
      operation: "get",
      resource: "runs",
      companyId: company.id,
      resourceId: runs[1].id,
      view: "summary",
    })) as Record<string, unknown>;
    expect(one).toMatchObject({ id: runs[1].id, status: "failed", errorCode: "adapter_failed", durationMs: 60_000 });
    expect(one).not.toHaveProperty("resultJson");
    expect(one).not.toHaveProperty("contextSnapshot");
  });
  it("ordered pages cover rows that share a creation time exactly once", async () => {
    for (const resource of INSPECTION_RESOURCES)
      expect(primaryKeyColumns(inspectionReaders[resource].table).length, resource).toBeGreaterThan(0);
    const [company] = await db
      .insert(schema.companies)
      .values({ name: "Labelled", issuePrefix: "LBL" })
      .returning();
    const [issue] = await db.insert(schema.issues).values({ companyId: company.id, title: "Tagged" }).returning();
    const labels = await db
      .insert(schema.labels)
      .values(Array.from({ length: 5 }, (_, i) => ({ companyId: company.id, name: `label-${i}`, color: "#000000" })))
      .returning();
    const createdAt = new Date(Date.UTC(2026, 0, 2));
    await db
      .insert(schema.issueLabels)
      .values(labels.map((label) => ({ companyId: company.id, issueId: issue.id, labelId: label.id, createdAt })));
    for (const order of ["newest", "oldest"] as const) {
      const seen: string[] = [];
      for (let offset = 0; offset < labels.length; offset += 2) {
        const page = (await readCustomerSuccessResource(db, storage, {
          operation: "list",
          resource: "taskLabels",
          companyId: company.id,
          order,
          limit: 2,
          offset,
        })) as { items: Array<{ labelId: string }> };
        seen.push(...page.items.map((row) => row.labelId));
      }
      expect(seen.sort()).toEqual(labels.map((label) => label.id).sort());
    }
  });
  it("count, order, view, and runs.search are bounded and take their versioned read paths", () => {
    expect(inspectionReadPath(parseInspectionQuery({ operation: "list", resource: "runs", companyId }))).toEqual("/read");
    for (const value of [
      { operation: "count", resource: "runs", companyId },
      { operation: "list", resource: "runs", companyId, order: "newest" },
      { operation: "get", resource: "runs", companyId, resourceId: agentId, view: "summary" },
    ])
      expect(inspectionReadPath(parseInspectionQuery(value))).toEqual("/read-v2");
    for (const value of [
      { operation: "count", resource: "runs" },
      { operation: "runs.search", patterns: ["paperclip_git_storage_limit"] },
      { operation: "runs.search", companyId, patterns: ["paperclip_git_storage_limit"], includeExcerpts: true },
    ])
      expect(inspectionReadPath(parseInspectionQuery(value))).toEqual("/read-v3");
    for (const value of [
      { operation: "count", companyId },
      { operation: "list", resource: "runs" },
      { operation: "count", resource: "runs", companyId, resourceId: agentId },
      { operation: "get", resource: "runs", companyId, resourceId: agentId, order: "newest" },
      { operation: "list", resource: "runs", companyId, order: "random" },
      { operation: "list", resource: "tasks", companyId, view: "summary" },
      { operation: "list", resource: "runs", companyId, view: "full" },
      { operation: "runs.log", companyId, resourceId: agentId, view: "summary" },
      { operation: "runs.search", patterns: [] },
      { operation: "runs.search", patterns: ["a", "b", "c", "d", "e", "f"] },
      { operation: "runs.search", patterns: ["dup", "DUP"] },
      { operation: "runs.search", patterns: ["paperclip_git_storage_limit"], includeExcerpts: true },
      { operation: "runs.search", patterns: ["ok"], resource: "runs" },
      {
        operation: "runs.search",
        patterns: ["ok"],
        createdAfter: "2026-11-25T00:00:00Z",
        createdBefore: "2026-11-24T00:00:00Z",
      },
      { operation: "list", resource: "runs", companyId, patterns: ["nope"] },
    ])
      expect(() => parseInspectionQuery(value)).toThrow();
  });
  it("runs.search catches hidden platform errors inside succeeded runs, reports co-occurrence, and redacts excerpts", async () => {
    const [coA, coB] = await db
      .insert(schema.companies)
      .values([
        { name: "SearchCoA", issuePrefix: "SCA" },
        { name: "SearchCoB", issuePrefix: "SCB" },
      ])
      .returning();
    const [agentA] = await db
      .insert(schema.agents)
      .values({ companyId: coA.id, name: "Codex A", adapterType: "codex_local" })
      .returning();
    const [agentB] = await db
      .insert(schema.agents)
      .values({ companyId: coB.id, name: "OpenCode B", adapterType: "opencode_local" })
      .returning();

    const t1 = new Date("2026-11-23T10:00:00.000Z");
    const t2 = new Date("2026-11-24T10:00:00.000Z");
    const t3 = new Date("2026-11-24T12:00:00.000Z");

    const [runBoth, runGitOnly] = await db
      .insert(schema.heartbeatRuns)
      .values([
        {
          companyId: coA.id,
          agentId: agentA.id,
          status: "succeeded",
          exitCode: 0,
          runtimeMode: "native",
          driverKind: "codex",
          createdAt: t1,
        },
        {
          companyId: coA.id,
          agentId: agentA.id,
          status: "succeeded",
          exitCode: 0,
          runtimeMode: "native",
          driverKind: "codex",
          createdAt: t2,
        },
      ])
      .returning();
    const [runOtherCo] = await db
      .insert(schema.heartbeatRuns)
      .values([
        {
          companyId: coB.id,
          agentId: agentB.id,
          status: "failed",
          exitCode: 1,
          runtimeMode: "native",
          driverKind: "opencode",
          error: "remote_workspace_archive_failed: exit=75 program=git reason=git_storage_guard_unavailable",
          createdAt: t3,
        },
      ])
      .returning();

    await db.insert(schema.heartbeatRunEvents).values([
      {
        companyId: coA.id,
        runId: runBoth.id,
        agentId: agentA.id,
        seq: 1,
        eventType: "item.completed",
        stream: "system",
        payload: {
          prpEvent: {
            payload: {
              kind: "commandExecution",
              aggregatedOutput:
                "Paperclip: GitHub capability_missing; continuing without managed credentials.\n" +
                "paperclip_git_storage_limit: Git's storage guard is unavailable or misconfigured; Git did not complete.",
            },
          },
        },
      },
      {
        companyId: coA.id,
        runId: runBoth.id,
        agentId: agentA.id,
        seq: 2,
        eventType: "platform.diagnostic",
        stream: "system",
        message: "git_storage_guard_unavailable",
        payload: { code: "git_storage_guard_unavailable" },
      },
      {
        companyId: coA.id,
        runId: runGitOnly.id,
        agentId: agentA.id,
        seq: 1,
        eventType: "item.completed",
        stream: "system",
        payload: {
          prpEvent: {
            payload: {
              kind: "commandExecution",
              aggregatedOutput:
                "paperclip_git_storage_limit: Git's storage guard is unavailable or misconfigured.",
            },
          },
        },
      },
    ]);

    // Company-scoped search with excerpts returns redacted matches and co-occurrence.
    const scoped = (await readCustomerSuccessResource(db, storage, {
      operation: "runs.search",
      companyId: coA.id,
      patterns: ["paperclip_git_storage_limit", "capability_missing"],
      createdAfter: "2026-11-23T00:00:00.000Z",
      includeExcerpts: true,
    })) as {
      runsScanned: number;
      runsTotalInWindow: number;
      truncated: boolean;
      byDiagnostic: Record<string, number>;
      patterns: Array<{
        pattern: string;
        matchedRuns: number;
        byStatus: Record<string, number>;
        sampleRuns: Array<{ runId: string; excerpt?: string; diagnostics: string[] }>;
      }>;
      coOccurrence: Array<{ patterns: string[]; matchedRuns: number }>;
    };
    expect(scoped.runsScanned).toBe(2);
    expect(scoped.runsTotalInWindow).toBe(2);
    expect(scoped.truncated).toBe(false);
    expect(scoped.byDiagnostic).toEqual({ git_storage_guard_unavailable: 1 });
    expect(scoped.patterns[0]!.matchedRuns).toBe(2);
    expect(scoped.patterns[0]!.byStatus).toEqual({ succeeded: 2 });
    expect(scoped.patterns[0]!.sampleRuns[0]!.excerpt).toContain("paperclip_git_storage_limit");
    expect(scoped.patterns[1]!.matchedRuns).toBe(1);
    expect(scoped.coOccurrence).toEqual([
      { patterns: ["paperclip_git_storage_limit"], matchedRuns: 1 },
      { patterns: ["paperclip_git_storage_limit", "capability_missing"], matchedRuns: 1 },
    ]);

    // Stack-wide search (no companyId, zero excerpts) spans both companies on the stack.
    const stackWide = (await readCustomerSuccessResource(db, storage, {
      operation: "runs.search",
      patterns: ["paperclip_git_storage_limit", "git_storage_guard_unavailable"],
      createdAfter: "2026-11-23T00:00:00.000Z",
      createdBefore: "2026-11-25T00:00:00.000Z",
    })) as {
      runsScanned: number;
      patterns: Array<{ pattern: string; matchedRuns: number; sampleRuns: Array<{ runId: string; excerpt?: string }> }>;
    };
    expect(stackWide.runsScanned).toBe(3);
    expect(stackWide.patterns[0]!.matchedRuns).toBe(2);
    // Matches both runOtherCo (run.error) and runBoth (platform.diagnostic event).
    expect(stackWide.patterns[1]!.matchedRuns).toBe(2);
    expect(stackWide.patterns[1]!.sampleRuns.map((r) => r.runId)).toContain(runOtherCo.id);
    expect(stackWide.patterns[1]!.sampleRuns.map((r) => r.runId)).toContain(runBoth.id);
    expect(stackWide.patterns[0]!.sampleRuns[0]!.excerpt).toBeUndefined();

    // Stack-wide count (no companyId) counts across all companies on the stack.
    const allRunCount = (await readCustomerSuccessResource(db, storage, {
      operation: "count",
      resource: "runs",
    })) as { total: number; byStatus: Record<string, number> };
    expect(allRunCount.total).toBeGreaterThanOrEqual(3);

    // Summary view attaches structured diagnostics on succeeded runs.
    const summaryRun = (await readCustomerSuccessResource(db, storage, {
      operation: "get",
      resource: "runs",
      companyId: coA.id,
      resourceId: runBoth.id,
      view: "summary",
    })) as { status: string; diagnostics: string[] };
    expect(summaryRun.status).toBe("succeeded");
    expect(summaryRun.diagnostics).toEqual(["git_storage_guard_unavailable"]);
  });

  it("runs.search redacts registered secrets before excerpt slicing, decodes escaped literals, and marks unreadable/slow logs truncated", async () => {
    const [co] = await db
      .insert(schema.companies)
      .values({ name: "SearchEdgeCo", issuePrefix: "SEC" })
      .returning();
    const [agent] = await db
      .insert(schema.agents)
      .values({ companyId: co.id, name: "EdgeAgent", adapterType: "codex_local" })
      .returning();

    // 1) Secret crossing the 240-char excerpt boundary AND a multiline secret must be
    // redacted in full BEFORE slicing or whitespace collapsing.
    const boundarySecret = "sk-boundary-secret-0123456789abcdef-tail";
    const multilineSecret = "BEGIN-SECRET-LINE1\nMIDDLE-SECRET-LINE2\nEND-SECRET-LINE3";
    const [secretRun] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId: co.id,
        agentId: agent.id,
        status: "succeeded",
        runtimeMode: "native",
        driverKind: "codex",
      })
      .returning();
    const redactions = createRunSecretRedactionRegistry(db);
    await redactions.register(co.id, secretRun.id, boundarySecret);
    await redactions.register(co.id, secretRun.id, multilineSecret);

    await db.insert(schema.heartbeatRunEvents).values({
      companyId: co.id,
      runId: secretRun.id,
      agentId: agent.id,
      seq: 1,
      eventType: "item.completed",
      stream: "system",
      payload: {
        prpEvent: {
          payload: {
            kind: "commandExecution",
            aggregatedOutput:
              `MARKER_BOUNDARY ${"x".repeat(100)} ${boundarySecret} ` +
              `and multiline ${multilineSecret} plus say "hello"\\world`,
          },
        },
      },
    });

    const redactedSearch = await searchCustomerSuccessRuns(db, {
      operation: "runs.search",
      companyId: co.id,
      patterns: ["MARKER_BOUNDARY", 'say "hello"\\world'],
      includeExcerpts: true,
    });
    expect(redactedSearch.patterns[0]!.matchedRuns).toBe(1);
    const boundaryExcerpt = redactedSearch.patterns[0]!.sampleRuns[0]!.excerpt ?? "";
    expect(boundaryExcerpt).toContain("MARKER_BOUNDARY");
    expect(boundaryExcerpt).not.toContain("sk-boundary");
    expect(boundaryExcerpt).not.toContain("0123456789");
    expect(boundaryExcerpt).not.toContain("BEGIN-SECRET");
    expect(boundaryExcerpt).not.toContain("MIDDLE-SECRET");
    // Literal pattern with quotes and backslash matches decoded JSON payload.
    expect(redactedSearch.patterns[1]!.matchedRuns).toBe(1);
    const escapedExcerpt = redactedSearch.patterns[1]!.sampleRuns[0]!.excerpt ?? "";
    expect(escapedExcerpt).toContain('say "hello"\\world');
    expect(escapedExcerpt).not.toContain("BEGIN-SECRET");
    expect(escapedExcerpt).not.toContain("END-SECRET");

    // 2) Legacy RunLogStore fallback: decodes NDJSON chunks, preserves UTF-8 split
    // across read boundaries, and marks failed or timed-out log reads truncated.
    const [logRun, missingLogRun, slowLogRun] = await db
      .insert(schema.heartbeatRuns)
      .values([
        {
          companyId: co.id,
          agentId: agent.id,
          status: "succeeded",
          runtimeMode: "legacy",
          driverKind: "codex",
          logStore: "local_file",
          logRef: "utf8-and-quotes.ndjson",
        },
        {
          companyId: co.id,
          agentId: agent.id,
          status: "succeeded",
          runtimeMode: "legacy",
          driverKind: "codex",
          logStore: "local_file",
          logRef: "missing.ndjson",
        },
        {
          companyId: co.id,
          agentId: agent.id,
          status: "succeeded",
          runtimeMode: "legacy",
          driverKind: "codex",
          logStore: "local_file",
          logRef: "slow.ndjson",
        },
      ])
      .returning();

    const ndjsonBytes = Buffer.from(
      `${JSON.stringify({ ts: "2026-11-25T00:00:00Z", stream: "stderr", chunk: 'prefix café 🚀 say "quoted"\n' })}\n` +
        `${JSON.stringify({ ts: "2026-11-25T00:00:01Z", stream: "stderr", chunk: "tail line" })}\n`,
      "utf8",
    );

    const makeFakeStore = (mode: "utf8" | "missing" | "slow"): RunLogStore => ({
      begin: async () => ({ store: "local_file", logRef: "unused" }),
      append: async () => 0,
      finalize: async () => ({ bytes: 0, compressed: false }),
      read: async (handle, opts) => {
        if (handle.logRef === "utf8-and-quotes.ndjson" && mode === "utf8") {
          const offset = opts?.offset ?? 0;
          // Force a tiny 45-byte page that cuts straight through multibyte UTF-8 / JSON.
          const step = Math.min(45, opts?.limitBytes ?? 45);
          const slice = ndjsonBytes.subarray(offset, offset + step);
          const nextOffset = offset + slice.length < ndjsonBytes.length ? offset + slice.length : undefined;
          return { content: slice.toString("utf8"), nextOffset };
        }
        if (handle.logRef === "missing.ndjson") {
          throw new Error("ENOENT: log missing after pod roll");
        }
        if (handle.logRef === "slow.ndjson" && mode === "slow") {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return { content: "" };
      },
    });

    // UTF-8 split & JSON-escaped quotes match cleanly when log is readable.
    const utf8Only = await searchCustomerSuccessRuns(
      db,
      {
        operation: "runs.search",
        companyId: co.id,
        patterns: ['café 🚀 say "quoted"'],
      },
      {
        logStore: {
          ...makeFakeStore("utf8"),
          read: async (handle, opts) =>
            handle.logRef === "utf8-and-quotes.ndjson"
              ? makeFakeStore("utf8").read(handle, opts)
              : { content: "" },
        },
      },
    );
    expect(utf8Only.truncated).toBe(false);
    expect(utf8Only.patterns[0]!.matchedRuns).toBe(1);
    expect(utf8Only.patterns[0]!.sampleRuns[0]!.runId).toBe(logRun.id);

    // Failed log read sets truncated: true rather than reporting a clean negative.
    const missingResult = await searchCustomerSuccessRuns(
      db,
      {
        operation: "runs.search",
        companyId: co.id,
        patterns: ["never-matches-anything"],
      },
      { logStore: makeFakeStore("missing") },
    );
    expect(missingResult.truncated).toBe(true);
    expect(missingLogRun.id).toBeTruthy();

    // Slow log read is aborted by wallBudgetMs and sets truncated: true promptly.
    const started = Date.now();
    const slowResult = await searchCustomerSuccessRuns(
      db,
      {
        operation: "runs.search",
        companyId: co.id,
        patterns: ["never-matches-anything"],
      },
      { logStore: makeFakeStore("slow"), wallBudgetMs: 200 },
    );
    expect(slowResult.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(slowLogRun.id).toBeTruthy();

    // 3) Truncated search (limit: 1 with >1 runs in window) MUST still load redactors
    // and redact registered secrets from fallback RunLogStore excerpts — including a
    // secret split across two paged log chunks on both left and right edges!
    const leftEdgeSecret = "sk-left-edge-secret-aaaa1111bbbb2222";
    const rightEdgeSecret = "sk-right-edge-secret-cccc3333dddd4444";
    const [newestLogRun] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId: co.id,
        agentId: agent.id,
        status: "succeeded",
        runtimeMode: "legacy",
        driverKind: "codex",
        logStore: "local_file",
        logRef: "truncated-secret.ndjson",
        createdAt: new Date(Date.now() + 60_000),
      })
      .returning();
    await redactions.register(co.id, newestLogRun.id, leftEdgeSecret);
    await redactions.register(co.id, newestLogRun.id, rightEdgeSecret);
    // Split both secrets across separate NDJSON chunk records and page reads!
    const secretNdjsonBytes = Buffer.from(
      `${JSON.stringify({ ts: "2026-11-25T00:00:00Z", stream: "stderr", chunk: "sk-left-edge-" })}\n` +
        `${JSON.stringify({ ts: "2026-11-25T00:00:01Z", stream: "stderr", chunk: "secret-aaaa1111bbbb2222 TRUNCATED_MARKER sk-right-edge-" })}\n` +
        `${JSON.stringify({ ts: "2026-11-25T00:00:02Z", stream: "stderr", chunk: "secret-cccc3333dddd4444 end\n" })}\n`,
      "utf8",
    );
    const truncatedRedacted = await searchCustomerSuccessRuns(
      db,
      {
        operation: "runs.search",
        companyId: co.id,
        patterns: ["TRUNCATED_MARKER"],
        limit: 1,
        includeExcerpts: true,
      },
      {
        logStore: {
          begin: async () => ({ store: "local_file", logRef: "unused" }),
          append: async () => 0,
          finalize: async () => ({ bytes: 0, compressed: false }),
          read: async (handle, opts) => {
            if (handle.logRef !== "truncated-secret.ndjson") return { content: "" };
            const offset = opts?.offset ?? 0;
            // Read one NDJSON line per page (~110 bytes) so left & right secrets cross page edges!
            const step = Math.min(115, opts?.limitBytes ?? 115);
            const slice = secretNdjsonBytes.subarray(offset, offset + step);
            const nextOffset = offset + slice.length < secretNdjsonBytes.length ? offset + slice.length : undefined;
            return { content: slice.toString("utf8"), nextOffset };
          },
        },
      },
    );
    expect(truncatedRedacted.truncated).toBe(true);
    expect(truncatedRedacted.patterns[0]!.matchedRuns).toBe(1);
    const truncExcerpt = truncatedRedacted.patterns[0]!.sampleRuns[0]!.excerpt ?? "";
    expect(truncExcerpt).toContain("TRUNCATED_MARKER");
    expect(truncExcerpt).not.toContain("sk-left-edge");
    expect(truncExcerpt).not.toContain("aaaa1111");
    expect(truncExcerpt).not.toContain("sk-right-edge");
    expect(truncExcerpt).not.toContain("cccc3333");

    // 4) Matches after early JSON-key-only hits (e.g. searching "output" when early
    // events have key "aggregatedOutput" without "output" in their values) are found
    // consistently both with and without includeExcerpts.
    const [lateMatchRun] = await db
      .insert(schema.heartbeatRuns)
      .values({
        companyId: co.id,
        agentId: agent.id,
        status: "succeeded",
        runtimeMode: "native",
        driverKind: "codex",
        createdAt: new Date(Date.now() + 120_000),
      })
      .returning();
    await db.insert(schema.heartbeatRunEvents).values([
      ...Array.from({ length: 5 }, (_, idx) => ({
        companyId: co.id,
        runId: lateMatchRun.id,
        agentId: agent.id,
        seq: idx + 1,
        eventType: "item.completed",
        stream: "system",
        payload: { aggregatedOutput: `benign line ${idx}` },
      })),
      {
        companyId: co.id,
        runId: lateMatchRun.id,
        agentId: agent.id,
        seq: 6,
        eventType: "item.completed",
        stream: "system",
        payload: { aggregatedOutput: "real output match on event 6" },
      },
    ]);
    const withoutExcerpts = await searchCustomerSuccessRuns(db, {
      operation: "runs.search",
      companyId: co.id,
      patterns: ["output"],
      limit: 1,
      includeExcerpts: false,
    });
    const withExcerpts = await searchCustomerSuccessRuns(db, {
      operation: "runs.search",
      companyId: co.id,
      patterns: ["output"],
      limit: 1,
      includeExcerpts: true,
    });
    expect(withoutExcerpts.patterns[0]!.matchedRuns).toBe(1);
    expect(withExcerpts.patterns[0]!.matchedRuns).toBe(1);
    expect(withExcerpts.patterns[0]!.sampleRuns[0]!.excerpt).toContain("real output match on event 6");
  });
  it("the operation contract has no writes, credentials or unknown parameters", () => {
    for (const value of [
      { operation: "write", companyId },
      { operation: "list", resource: "secrets", companyId },
      { operation: "get", resource: "agents", companyId, resourceId: agentId, key: "replacement" },
      {
        operation: "assets.content",
        companyId,
        resourceId: agentId,
        range: { start: 0, end: 1048576 },
      },
    ])
      expect(() => parseInspectionQuery(value)).toThrow();
  });
});
