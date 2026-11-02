import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  agents,
  agentApiKeys,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  toolApplications,
  toolConnections,
  connectionGrants,
  chatEndpoints,
  chatGitHubRegistrations,
  type Db,
} from "@paperclipai/db";
import { setCloudRuntimeConfigSnapshot } from "../services/cloud-runtime-config-snapshot.js";
import { actorMiddleware } from "../middleware/auth.js";
import {
  idleAdmissionMiddleware,
  trackIdleRequestHandlers,
} from "../middleware/idle-admission.js";
import { errorHandler } from "../middleware/error-handler.js";
import { companyRoutes } from "../routes/companies.js";
import { agentService } from "../services/agents.js";
import { boardAuthService } from "../services/board-auth.js";
import { readIdleSleepSafety } from "../services/idle-sleep-safety.js";
import {
  readIdleIncomingWakeProof,
  incomingWakeFingerprint,
} from "../services/idle-incoming-wake.js";
import { registerConnectionEventWake } from "../services/connection-event-wake.js";
import { idleApiActivity } from "../services/idle-api-activity.js";
import { startTaskDrain, stopTaskDrain } from "../services/task-admission.js";
import {
  verifyCloudControlAssertion,
  CLOUD_CONTROL_AUDIENCE,
  CLOUD_CONTROL_JWS_TYPE,
  CLOUD_RUNTIME_IDENTITY_ISSUER,
} from "../services/cloud-runtime-identity.js";
import type {
  IdleIncomingWakeCapability,
  VerifiedIdleCapabilities,
} from "../services/idle-incoming-wake-capability.js";

import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
const url = resolveExternalTestDatabaseUrl(
  "PAPERCLIP_INCOMING_WAKE_TEST_DATABASE_URL",
);
const support = url
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const ownerId = "00000000-0000-4000-8000-000000000001";
const now = Date.now();
const hold = () => ({
  ownerId,
  draining: true,
  startedAt: new Date(now - 1000),
  expiresAt: new Date(now + 300_000),
  activeRuns: 0,
  pendingWakes: 0,
});
const capability: IdleIncomingWakeCapability = {
  version: 1,
  ownerId,
  generation: "a".repeat(64),
  routes: ["tenant-api-http-v1"],
};
function verified(incomingWake = capability): VerifiedIdleCapabilities {
  const pair = generateKeyPairSync("ed25519"),
    kid = randomUUID(),
    issued = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  const header = encode({ alg: "EdDSA", typ: CLOUD_CONTROL_JWS_TYPE, kid });
  const payload = encode({
    v: 1,
    iss: CLOUD_RUNTIME_IDENTITY_ISSUER,
    aud: CLOUD_CONTROL_AUDIENCE,
    sub: "fixture-stack",
    action: "task-drain:read",
    requestId: randomUUID(),
    iat: issued,
    exp: issued + 60,
    idleCapabilities: { incomingWake },
  });
  const token = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), pair.privateKey).toString("base64url")}`;
  return verifyCloudControlAssertion({
    compactJws: token,
    expectedAction: "task-drain:read",
    env: {
      PAPERCLIP_CLOUD_STACK_ID: "fixture-stack",
      PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify({
        keys: [
          {
            ...pair.publicKey.export({ format: "jwk" }),
            kid,
            use: "sig",
            alg: "EdDSA",
          },
        ],
      }),
    },
  }).idleCapabilities as VerifiedIdleCapabilities;
}

(support.supported ? describe : describe.skip)(
  "scoped incoming wake PostgreSQL contract",
  () => {
    let db: Db;
    let database:
      Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
    beforeAll(async () => {
      if (!url)
        database = await startEmbeddedPostgresTestDatabase(
          "idle-incoming-wake-",
        );
      db = createDb(url ?? database!.connectionString, { maxConnections: 4 });
      await db.execute(sql`SELECT 1 FROM agent_api_keys LIMIT 1`); // Coordinator migrates the fresh fixture; no embedded fallback.
      vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "fixture-only");
      setCloudRuntimeConfigSnapshot({ version: 1, revision: 0, config: null });
    });
    afterAll(async () => {
      setCloudRuntimeConfigSnapshot(null);
      stopTaskDrain();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await db?.$client.end({ timeout: 5 });
      await database?.cleanup();
    });
    // The externally supplied database is dedicated to this suite. Preserve all
    // rows during every eligibility scenario, then isolate the next scenario.
    const resetFixture = async () => {
      await db.execute(
        sql`TRUNCATE companies, "user", chat_github_registrations CASCADE`,
      );
    };
    beforeEach(resetFixture);
    afterEach(async () => {
      stopTaskDrain();
      vi.restoreAllMocks();
      await resetFixture();
    });

    const read = (incomingWake?: VerifiedIdleCapabilities) =>
      readIdleSleepSafety(
        db,
        hold,
        () => now,
        ownerId,
        async () => "none",
        undefined,
        undefined,
        false,
        false,
        { incomingWake },
      );
    async function seed() {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        userId = randomUUID(),
        foreignId = randomUUID();
      await db.insert(companies).values([
        {
          id: companyId,
          name: "Incoming fixture",
          issuePrefix: `I${companyId.slice(0, 6)}`,
        },
        {
          id: foreignId,
          name: "Foreign fixture",
          issuePrefix: `F${foreignId.slice(0, 6)}`,
        },
      ]);
      await db
        .insert(authUsers)
        .values({
          id: userId,
          name: "Fixture owner",
          email: `${userId}@example.test`,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      await db
        .insert(companyMemberships)
        .values({
          companyId,
          principalType: "user",
          principalId: userId,
          membershipRole: "owner",
          status: "active",
        });
      await db
        .insert(agents)
        .values({
          id: agentId,
          companyId,
          name: "Fixture agent",
          role: "engineer",
          adapterType: "process",
          status: "idle",
        });
      const board = await boardAuthService(db).createNamedBoardApiKey({
        userId,
        name: "incoming board",
        expiresAt: null,
      });
      const agent = await agentService(db).createApiKey(
        agentId,
        "incoming agent",
        { kind: "standard" },
        { responsibleUserId: userId },
      );
      return { companyId, foreignId, userId, agentId, board, agent };
    }
    it("retains real saved keys and exempts them only for the verified exact owner/profile", async () => {
      const f = await seed();
      expect((await read()).backgroundWork).toBe("present");
      expect(await read(verified())).toMatchObject({
        version: 3,
        backgroundWork: "none",
        incomingWake: capability,
      });
      expect(
        (await read(verified({ ...capability, ownerId: randomUUID() })))
          .backgroundWork,
      ).toBe("unknown");
      expect(
        await db
          .select()
          .from(agentApiKeys)
          .where(eq(agentApiKeys.id, f.agent.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(boardApiKeys)
          .where(eq(boardApiKeys.id, f.board.id)),
      ).toHaveLength(1);
    });
    it("delivers through actual tenant auth/routes, denies current revoked/expired/foreign authority and holds only successful API use", async () => {
      const f = await seed();
      let monotonic = 1;
      vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      let release: (() => void) | undefined, arrived: (() => void) | undefined;
      const app = express();
      // Named Cloud wake boundary: preserve request until the simulated compute handoff finishes.
      app.use(async (_req, _res, next) => {
        if (release) {
          await new Promise<void>((resolve) => {
            release = resolve;
            arrived?.();
          });
        }
        next();
      });
      app.use(idleAdmissionMiddleware);
      app.use(express.json());
      app.use(
        actorMiddleware(db, {
          deploymentMode: "authenticated",
          resolveSession: async () => null,
        }),
      );
      app.use("/api/companies", companyRoutes(db));
      app.use(errorHandler);
      trackIdleRequestHandlers(app);
      expect(idleApiActivity.active()).toBe(false);
      expect(
        (
          await request(app)
            .get(`/api/companies/${f.companyId}`)
            .set("Authorization", "Bearer unknown")
        ).status,
      ).toBe(401);
      expect(idleApiActivity.active()).toBe(false);
      expect(
        (
          await request(app)
            .get(`/api/companies/${f.foreignId}`)
            .set("Authorization", `Bearer ${f.board.token}`)
        ).status,
      ).toBe(403);
      expect(idleApiActivity.active()).toBe(false);
      const own = await request(app)
        .patch(`/api/companies/${f.companyId}`)
        .set("Authorization", `Bearer ${f.board.token}`)
        .send({ name: "Persisted after wake" });
      expect(own.status).toBe(200);
      expect(idleApiActivity.active()).toBe(true);
      expect(
        (
          await db.select().from(companies).where(eq(companies.id, f.companyId))
        )[0]!.name,
      ).toBe("Persisted after wake");
      monotonic += 300_000;
      expect(
        (
          await request(app)
            .get(`/api/companies/${f.companyId}`)
            .set("Authorization", `Bearer ${f.agent.token}`)
        ).status,
      ).toBe(200);
      monotonic += 300_001;
      expect(idleApiActivity.active()).toBe(true);
      monotonic += 299_999;
      expect(idleApiActivity.active()).toBe(false);
      const arrival = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      release = () => {};
      const held = request(app)
        .patch(`/api/companies/${f.companyId}`)
        .set("Authorization", `Bearer ${f.board.token}`)
        .send({ name: "Must not commit" })
        .then((r) => r);
      await arrival;
      await db
        .update(boardApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(boardApiKeys.id, f.board.id));
      release!();
      release = undefined;
      expect((await held).status).toBe(401);
      expect(idleApiActivity.active()).toBe(false);
      const expired = await boardAuthService(db).createNamedBoardApiKey({
        userId: f.userId,
        name: "expired",
        expiresAt: new Date(0),
      });
      expect(
        (
          await request(app)
            .get(`/api/companies/${f.companyId}`)
            .set("Authorization", `Bearer ${expired.token}`)
        ).status,
      ).toBe(401);
      expect(idleApiActivity.active()).toBe(false);
      startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
      expect(
        (
          await request(app)
            .patch(`/api/companies/${f.companyId}`)
            .set("Authorization", `Bearer ${f.agent.token}`)
            .send({ name: "Draining" })
        ).status,
      ).toBe(503);
      expect(idleApiActivity.active()).toBe(false);
      stopTaskDrain();
      expect(
        (
          await db.select().from(companies).where(eq(companies.id, f.companyId))
        )[0]!.name,
      ).toBe("Persisted after wake");
    });
    it("requires current broker instance and exact owner binding, preserving continuity and unsupported transport blockers", async () => {
      const f = await seed();
      const applicationId = randomUUID(),
        connectionId = randomUUID(),
        grantId = randomUUID();
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", "fixture-instance");
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY", "fixture");
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY", "fixture");
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT", "test");
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", "http://127.0.0.1");
      const botConnectionId = randomUUID(),
        endpointId = randomUUID(),
        registration = "b".repeat(43);
      const botApplication = randomUUID();
      await db
        .insert(toolApplications)
        .values({
          id: botApplication,
          companyId: f.companyId,
          name: "GitHub bot",
          type: "chat",
        });
      await db
        .insert(toolConnections)
        .values({
          id: botConnectionId,
          companyId: f.companyId,
          applicationId: botApplication,
          name: "GitHub bot",
          uid: randomUUID(),
          transport: "chat_sdk",
          connectionPurpose: "channel",
          status: "active",
          enabled: true,
          config: { provider: "github" },
        });
      await db
        .insert(chatEndpoints)
        .values({
          id: endpointId,
          companyId: f.companyId,
          connectionId: botConnectionId,
          assignedAgentId: f.agentId,
          provider: "github",
          publicId: "p".repeat(43),
          status: "active",
          activatedAt: new Date(),
          providerAccountId: "fixture-app",
          botExternalId: "fixture-bot",
          setup: {
            step: "complete",
            github: {
              stage: "test",
              registrationStatus: "completed",
              cloudRegistrationId: registration,
            },
          },
        });
      await db
        .insert(chatGitHubRegistrations)
        .values({
          companyId: f.companyId,
          endpointId,
          userId: f.userId,
          stateHash: randomUUID(),
          trustedOrigin: "https://tenant.example.test",
          status: "completed",
          expiresAt: new Date(0),
          handoff: {
            cloudId: registration,
            redemptionId: randomUUID(),
            returnState: randomUUID(),
          },
        });
      const botTuple = [
        `github-app:${registration}`,
        f.companyId,
        f.userId,
        "github.bot",
        `gateway:${registration}`,
        registration,
        registration,
      ];
      const stop = registerConnectionEventWake(db, () => {});
      const botCap: IdleIncomingWakeCapability = {
        ...capability,
        routes: ["github-broker-events-v1", "tenant-api-http-v1"],
        githubBroker: {
          instanceId: "fixture-instance",
          bindingsFingerprint: incomingWakeFingerprint([botTuple]),
        },
      };
      expect((await read(verified())).backgroundWork).toBe("present");
      expect(await read(verified(botCap))).toMatchObject({
        version: 3,
        backgroundWork: "none",
      });
      const botProof = await readIdleIncomingWakeProof(db, {
        capabilities: verified(botCap),
        ownerId,
        receiverOwner: db,
      });
      expect(botProof?.endpointIds).toEqual([endpointId]);
      expect(botProof?.connectionIds).toEqual([botConnectionId]);
      expect(
        await db
          .select()
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpointId)),
      ).toHaveLength(1);

      await db
        .insert(toolApplications)
        .values({
          id: applicationId,
          companyId: f.companyId,
          name: "GitHub",
          type: "mcp_http",
        });
      await db
        .insert(toolConnections)
        .values({
          id: connectionId,
          companyId: f.companyId,
          applicationId,
          name: "GitHub",
          uid: randomUUID(),
          transport: "mcp_remote",
          connectionPurpose: "tool",
          status: "active",
          enabled: true,
          config: {
            sourceTemplateKey: "github",
            oauth: { connectorProfile: "github.code" },
          },
        });
      const github = {
        userId: "42",
        login: "fixture",
        installationCount: 1,
        repositoryCount: 1,
        repositorySelection: "all" as const,
        installationIds: ["123"],
        installationOwnerLogins: ["fixture"],
        lastAccessRefreshAt: new Date().toISOString(),
      };
      await db
        .insert(connectionGrants)
        .values({
          id: grantId,
          companyId: f.companyId,
          connectionId,
          kind: "user",
          subjectUserId: f.userId,
          providerTenant: { github },
          status: "active",
        });
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", "fixture-instance");
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY", "fixture");
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY", "fixture");
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT", "test");
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", "http://127.0.0.1");
      const brokerCap: IdleIncomingWakeCapability = {
        ...capability,
        routes: ["github-broker-events-v1", "tenant-api-http-v1"],
        githubBroker: {
          instanceId: "fixture-instance",
          bindingsFingerprint: incomingWakeFingerprint([
            botTuple,
            [
              `${grantId}_123`,
              f.companyId,
              f.userId,
              "github.code",
              "123",
              connectionId,
              grantId,
            ],
          ]),
        },
      };
      try {
        const proof = await readIdleIncomingWakeProof(db, {
          capabilities: verified(brokerCap),
          ownerId,
          receiverOwner: db,
        });
        expect(proof?.requiredContinuityConnectionIds).toEqual([connectionId]);
        expect(proof?.connectionIds).toEqual([botConnectionId]);
        expect((await read(verified(brokerCap))).backgroundWork).toBe(
          "present",
        ); // transport alone never discharges real credential deadline
        await db
          .update(connectionGrants)
          .set({
            providerTenant: {
              github: {
                ...github,
                bindingSync: { id: randomUUID(), removeInstallationIds: [] },
              },
            },
          })
          .where(eq(connectionGrants.id, grantId));
        expect((await read(verified(brokerCap))).backgroundWork).toBe(
          "unknown",
        );
        await db
          .update(connectionGrants)
          .set({ status: "revoked" })
          .where(eq(connectionGrants.id, grantId));
        expect((await read(verified(brokerCap))).backgroundWork).toBe(
          "unknown",
        );
        await db
          .update(toolConnections)
          .set({ transport: "local_stdio" })
          .where(eq(toolConnections.id, connectionId));
        expect((await read(verified())).backgroundWork).toBe("present");
      } finally {
        stop();
      }
    });
  },
);
