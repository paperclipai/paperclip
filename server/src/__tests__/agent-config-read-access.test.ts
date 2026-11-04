import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents, agentApiKeys, authUsers, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("agent configuration read access", () => {
  it("authenticates a scoped read-only key, redacts reads, denies writes, and rechecks revocation", async () => {
    const database = await startEmbeddedPostgresTestDatabase("agent-config-read-access-");
    const db = createDb(database.connectionString);
    const previousHome = process.env.PAPERCLIP_HOME;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-read-home-"));
    process.env.PAPERCLIP_HOME = home;
    try {
      const companyId = randomUUID(), foreignCompanyId = randomUUID(), actorId = randomUUID(), targetId = randomUUID(), otherId = randomUUID(), foreignId = randomUUID(), userId = randomUUID();
      const plaintext = "config-read-secret-must-not-leak";
      const token = randomUUID();
      const root = resolveManagedInstructionsRoot({ id: targetId, companyId, name: "Target", adapterConfig: {} });
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "AGENTS.md"), "Peer operating instructions");
      await db.insert(companies).values([
        { id: companyId, name: "Config read", issuePrefix: "CRA" },
        { id: foreignCompanyId, name: "Foreign", issuePrefix: "CRB" },
      ]);
      await db.insert(authUsers).values({ id: userId, name: "Read owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(agents).values([
        { id: actorId, companyId, name: "Reader" },
        { id: targetId, companyId, name: "Target", adapterConfig: {
          env: { GENERIC_NAME: { type: "plain", value: plaintext } },
          instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md",
        } },
        { id: otherId, companyId, name: "Outside grant" },
        { id: foreignId, companyId: foreignCompanyId, name: "Foreign target" },
      ]);
      await db.insert(companyMemberships).values([
        { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
        { companyId, principalType: "agent", principalId: actorId, membershipRole: "member" },
      ]);
      await db.insert(principalPermissionGrants).values([
        { companyId, principalType: "agent", principalId: actorId, permissionKey: "agents:read", scope: { agentIds: [targetId] } },
        { companyId, principalType: "user", principalId: userId, permissionKey: "agents:read" },
      ]);
      await db.insert(agentApiKeys).values({ companyId, agentId: actorId, name: "Reader", responsibleUserId: userId,
        keyHash: createHash("sha256").update(token).digest("hex") });
      const app = express();
      app.use(express.json());
      app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      const get = (url: string) => request(app).get(`/api${url}`).set("Authorization", `Bearer ${token}`);
      const configuration = `/agents/${targetId}/configuration`;

      const read = await get(configuration);
      expect(read.status).toBe(200);
      expect(JSON.stringify(read.body)).not.toContain(plaintext);
      expect(read.body.adapterConfig.env.GENERIC_NAME.value).toBe("***REDACTED***");
      expect((await get(`/agents/${targetId}/skills`)).status).toBe(200);
      expect((await get(`/agents/${targetId}/config-revisions`)).status).toBe(200);
      const instructions = await get(`/agents/${targetId}/instructions-bundle/file?path=AGENTS.md`);
      expect(instructions.status).toBe(200);
      expect(instructions.body.content).toBe("Peer operating instructions");
      expect((await get(`/agents/${otherId}/configuration`)).status).toBe(403);
      expect((await get(`/agents/${foreignId}/configuration`)).status).toBe(404);
      expect((await get(`/companies/${companyId}/agent-configurations`)).status).toBe(403);

      const write = await request(app).patch(`/api/agents/${targetId}`).set("Authorization", `Bearer ${token}`).send({ title: "Denied edit" });
      expect(write.status).toBe(403);
      const rollback = await request(app).post(`/api/agents/${targetId}/config-revisions/${randomUUID()}/rollback`).set("Authorization", `Bearer ${token}`).send({});
      expect(rollback.status).toBe(403);
      expect((await db.select({ title: agents.title }).from(agents).where(eq(agents.id, targetId)))[0]!.title).toBeNull();

      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, actorId));
      expect((await get(configuration)).status).toBe(403);
      expect((await get(`/agents/${actorId}/configuration`)).status).toBe(200);
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: actorId, permissionKey: "agents:read" });
      await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalId, userId)));
      const humanRevoked = await get(configuration);
      expect(humanRevoked.status).toBe(403);
      expect(humanRevoked.body.code).toBe("RESPONSIBLE_USER_UNAUTHORIZED");
      expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("Peer operating instructions");
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      await database.cleanup();
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});
