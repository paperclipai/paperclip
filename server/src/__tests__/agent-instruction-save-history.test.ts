import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentFileStore, snapshotAgentFiles } from "../services/agent-file-store.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import type { AuthorizationActor } from "../services/authorization.js";

describe("instruction save history", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof agentInstructionRevisionService>;
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let companyId: string, agentId: string, userId: string, actorId: string, root: string;
  const entryFile = "AGENTS.md";
  async function writer() {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: actorId, invocationSource: "on_demand", responsibleUserId: userId });
    return { runId, actor: { type: "agent", companyId, agentId: actorId, runId, source: "agent_jwt" } as AuthorizationActor };
  }
  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-save-history-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("instruction-save-history-db-");
    db = createDb(database.connectionString);
    service = agentInstructionRevisionService(db);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); actorId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Save history", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } },
      { id: actorId, companyId, name: "Writer" },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: actorId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } },
      { companyId, principalType: "agent", principalId: actorId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } },
    ]);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, entryFile), "# Original\n");
  });
  const target = () => ({ companyId, agentId });

  it("accepts the latest save from history as the base of the next edit", async () => {
    const { actor } = await writer();
    const first = (await service.readCurrent(target(), actor))!;
    await service.commit({ ...target(), entryFile, content: "# Saved\n", baseRevisionId: first.revision.id, source: "tool" }, actor);
    const [latest] = (await service.history({ ...target(), entryFile }, actor)).revisions;
    const read = await service.readRevision({ ...target(), entryFile, revisionId: latest!.id }, actor);
    expect(read).toMatchObject({ content: "# Saved\n", revision: { id: latest!.id } });
    const edited = await service.commit({ ...target(), entryFile, content: "# Edited\n", baseRevisionId: read.revision.id, source: "tool" }, actor);
    expect(edited).toMatchObject({ changed: true, content: "# Edited\n" });
  });

  it("keeps the first run as the writer when a later run collects the same bytes", async () => {
    const baseline = await snapshotAgentFiles(root);
    const runs = [await writer(), await writer()];
    const store = agentFileStore(db);
    for (const run of runs) {
      const sourceDir = path.join(home, `run-${run.runId}`);
      await fs.cp(root, sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, entryFile), "# Same edit from two runs\n");
      await store.apply({ companyId, agentId, sourceDir, baseline }, run.actor);
    }
    const { revisions } = await service.history({ ...target(), entryFile }, runs[0]!.actor);
    expect(revisions).toEqual([expect.objectContaining({ actorAgentId: actorId, sourceRunId: runs[0]!.runId })]);
    expect((await service.readCurrent(target(), runs[0]!.actor))!.revision).toMatchObject({ sourceRunId: runs[0]!.runId });
  });
});
