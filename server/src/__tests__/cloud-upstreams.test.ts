import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, cloudUpstreamConnections, cloudUpstreamRuns, companySkills, createDb } from "@paperclipai/db";

import { HttpError } from "../errors.js";
import {
  cloudUpstreamRemoteFailureReport,
  cloudUpstreamService,
  reconcileCloudUpstreamRunsOnStartup,
  sealCloudUpstreamCredential,
  unsealCloudUpstreamCredential,
} from "../services/cloud-upstreams.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cloud upstream tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("cloud upstream remote failures", () => {
  it("preserves the cloud response body and message on run reports", () => {
    const body = {
      error: "bad_request",
      message: "entities[42].body must be an object",
      errors: [{ path: "entities[42].body" }],
    };

    expect(cloudUpstreamRemoteFailureReport(new HttpError(400, "bad_request", body))).toEqual({
      error: "bad_request",
      errorMessage: "entities[42].body must be an object",
      details: body,
    });
  });

  it("falls back to the thrown error message for non-remote failures", () => {
    expect(cloudUpstreamRemoteFailureReport(new Error("network failed"))).toEqual({
      error: "network failed",
    });
  });
});

describe("cloud upstream credential storage", () => {
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  afterEach(() => {
    if (previousMasterKey === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    }
  });

  it("stores new credentials as encrypted envelopes and preserves legacy plaintext reads", async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    const sealed = await sealCloudUpstreamCredential("cloud-access-token");

    expect(sealed).toMatch(/^paperclip-cloud-credential:/);
    expect(sealed).not.toContain("cloud-access-token");
    await expect(unsealCloudUpstreamCredential(sealed)).resolves.toBe("cloud-access-token");
    await expect(unsealCloudUpstreamCredential("legacy-plaintext-token")).resolves.toBe("legacy-plaintext-token");
  });
});

describeEmbeddedPostgres("cloud upstream persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cloud-upstreams-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(cloudUpstreamRuns);
    await db.delete(cloudUpstreamConnections);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousMasterKey === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    }
    await tempDb?.cleanup();
  });

  it("encrypts stored upstream credentials while keeping connection flows usable", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const tokenUrl = "https://cloud.example.test/oauth/token";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://cloud.example.test/.well-known/paperclip-upstream")) {
        return jsonResponse({
          product: "Paperclip Cloud",
          stack: {
            id: "stack-1",
            companyId: "cloud-company-1",
            origin: "https://cloud.example.test",
            primaryHost: "cloud.example.test",
          },
          transfer: {
            supportedSchemaMajor: 1,
            maxChunkBytes: 8192,
          },
          auth: {
            scopes: ["upstream_import:write"],
            pkce: {
              authorizeUrl: "https://cloud.example.test/oauth/authorize",
              tokenUrl,
            },
          },
        });
      }
      if (url === tokenUrl && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        expect(payload.codeVerifier).toEqual(expect.any(String));
        expect(payload.codeVerifier).not.toContain("paperclip-cloud-credential:");
        return jsonResponse({
          accessToken: "cloud-access-token",
          token: {
            id: "token-1",
            expiresAt: "2026-05-22T13:00:00.000Z",
            globalUserId: "user-1",
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = cloudUpstreamService(db, { instanceId: "test" });
    const started = await service.startConnect({
      companyId,
      remoteUrl: "https://cloud.example.test",
      redirectUri: "http://localhost:3100/callback",
    });
    await service.finishConnect({
      pendingConnectionId: started.pendingConnectionId,
      code: "auth-code",
      state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
    });

    const [row] = await db.select().from(cloudUpstreamConnections);
    expect(row.privateKeyPem).toMatch(/^paperclip-cloud-credential:/);
    expect(row.privateKeyPem).not.toContain("BEGIN PRIVATE KEY");
    expect(row.accessToken).toMatch(/^paperclip-cloud-credential:/);
    expect(row.accessToken).not.toContain("cloud-access-token");
  });

  it("marks orphaned running runs failed during startup reconciliation", async () => {
    const companyId = randomUUID();
    const connectionId = randomUUID();
    const runningRunId = randomUUID();
    const succeededRunId = randomUUID();
    const reconciledAt = new Date("2026-05-22T13:00:00.000Z");
    await seedCompany(companyId);
    await db.insert(cloudUpstreamConnections).values({
      id: connectionId,
      companyId,
      remoteUrl: "https://cloud.example.test",
      sourceInstanceId: "source-1",
      sourceInstanceFingerprint: "sha256:test",
      sourcePublicKey: "public-key",
      privateKeyPem: "legacy-private-key",
      tokenStatus: "connected",
      scopes: ["upstream_import:write"],
      authorizedGlobalUserId: "user-1",
      accessToken: "legacy-token",
      tokenId: "token-1",
      targetStackId: "stack-1",
      targetCompanyId: "cloud-company-1",
      targetOrigin: "https://cloud.example.test",
      targetPrimaryHost: "cloud.example.test",
      targetProduct: "Paperclip Cloud",
      targetSchemaMajor: 1,
      targetMaxChunkBytes: 8192,
    });
    await db.insert(cloudUpstreamRuns).values([
      cloudRunRow({ id: runningRunId, connectionId, companyId, status: "running" }),
      cloudRunRow({ id: succeededRunId, connectionId, companyId, status: "succeeded", completedAt: reconciledAt }),
    ]);

    await expect(reconcileCloudUpstreamRunsOnStartup(db, reconciledAt)).resolves.toEqual({ reconciled: 1 });

    const rows = await db.select().from(cloudUpstreamRuns);
    const running = rows.find((row) => row.id === runningRunId);
    const succeeded = rows.find((row) => row.id === succeededRunId);
    expect(running?.status).toBe("failed");
    expect(running?.completedAt?.toISOString()).toBe(reconciledAt.toISOString());
    expect(running?.events.at(-1)?.message).toContain("server startup");
    expect(running?.report).toMatchObject({
      error: "orphaned_running_run",
      reconciledAt: reconciledAt.toISOString(),
    });
    expect(succeeded?.status).toBe("succeeded");
  });

  it("rejects a new run when the connection already has a running run", async () => {
    const companyId = randomUUID();
    const connectionId = randomUUID();
    const runningRunId = randomUUID();
    await seedCompany(companyId);
    await db.insert(cloudUpstreamConnections).values(cloudConnectionRow({ id: connectionId, companyId }));
    await db.insert(cloudUpstreamRuns).values(
      cloudRunRow({ id: runningRunId, connectionId, companyId, status: "running" }),
    );

    await expect(cloudUpstreamService(db).createRun({ connectionId, companyId })).rejects.toMatchObject({
      status: 409,
      details: { runId: runningRunId },
    });
  });

  it("preserves a cancelled run when an in-flight createRun tries to finish", async () => {
    const companyId = randomUUID();
    const connectionId = randomUUID();
    await seedCompany(companyId);
    await db.insert(cloudUpstreamConnections).values(cloudConnectionRow({ id: connectionId, companyId }));

    const service = cloudUpstreamService(db);
    const remoteCalls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      remoteCalls.push(path);
      if (path.endsWith("/upstream-imports/runs")) {
        return jsonResponse({ run: { id: "remote-run-1" } });
      }
      if (path.endsWith("/chunks")) {
        const run = await db.select().from(cloudUpstreamRuns).then((rows) => rows[0]);
        expect(run?.status).toBe("running");
        await service.cancelRun(connectionId, run.id, companyId);
        return jsonResponse({ ok: true });
      }
      if (path.endsWith("/cancel")) {
        return jsonResponse({ ok: true });
      }
      if (path.endsWith("/apply")) {
        return jsonResponse({ ok: true });
      }
      if (path.endsWith("/events")) {
        return jsonResponse({ events: [] });
      }
      return jsonResponse({ error: "not_found" }, 404);
    }) as typeof fetch;

    const result = await service.createRun({ connectionId, companyId });

    expect(result.status).toBe("cancelled");
    expect(remoteCalls.some((path) => path.endsWith("/apply"))).toBe(false);
    const rows = await db.select().from(cloudUpstreamRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
  });

  async function seedCompany(companyId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function cloudConnectionRow(input: { id: string; companyId: string }) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    id: input.id,
    companyId: input.companyId,
    remoteUrl: "https://cloud.example.test",
    sourceInstanceId: "source-1",
    sourceInstanceFingerprint: "sha256:test",
    sourcePublicKey: "public-key",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    tokenStatus: "connected",
    scopes: ["upstream_import:write"],
    authorizedGlobalUserId: "user-1",
    accessToken: "legacy-token",
    tokenId: "token-1",
    targetStackId: "stack-1",
    targetCompanyId: "cloud-company-1",
    targetOrigin: "https://cloud.example.test",
    targetPrimaryHost: "cloud.example.test",
    targetProduct: "Paperclip Cloud",
    targetSchemaMajor: 1,
    targetMaxChunkBytes: 8192,
  };
}

function cloudRunRow(input: {
  id: string;
  connectionId: string;
  companyId: string;
  status: string;
  completedAt?: Date;
}) {
  return {
    id: input.id,
    connectionId: input.connectionId,
    companyId: input.companyId,
    status: input.status,
    activeStep: "push",
    progressPercent: input.status === "running" ? 45 : 100,
    dryRun: false,
    summary: [],
    warnings: [],
    conflicts: [],
    events: [],
    report: {},
    idempotencyKey: `key-${input.id}`,
    manifestHash: `sha256:${input.id.replace(/-/g, "")}`,
    targetUrl: "https://cloud.example.test",
    completedAt: input.completedAt,
  };
}
