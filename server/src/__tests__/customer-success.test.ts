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
  parseInspectionQuery,
  type InspectionQuery,
  type InspectionPermit,
} from "@paperclipai/shared";
import { customerSuccessRunAuthority } from "../services/customer-success-authority.js";
import {
  readCustomerSuccessResource,
  inspectionReaders,
} from "../services/customer-success-inspection.js";
import { customerSuccessRoutes, verifyInspectionPermit } from "../routes/customer-success.js";
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
        fileInventory: [{ path: "SKILL.md", kind: "markdown", sizeBytes: 9, content: "# Example" }],
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
