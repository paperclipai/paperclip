import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  projects,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { disableAllRoutinesInConfig } from "../commands/routines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routines CLI tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function writeTestConfig(configPath: string, tempRoot: string, connectionString: string) {
  const config = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "doctor" as const,
    },
    database: {
      mode: "postgres" as const,
      connectionString,
      embeddedPostgresDataDir: path.join(tempRoot, "embedded-db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: false,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(tempRoot, "backups"),
      },
    },
    logging: {
      mode: "file" as const,
      logDir: path.join(tempRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted" as const,
      exposure: "private" as const,
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: false,
    },
    auth: {
      baseUrlMode: "auto" as const,
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk" as const,
      localDisk: {
        baseDir: path.join(tempRoot, "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted" as const,
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(tempRoot, "secrets", "master.key"),
      },
    },
  };

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

describeEmbeddedPostgres("disableAllRoutinesInConfig", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempRoot = "";
  let configPath = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-cli-db-");
    db = createDb(tempDb.connectionString);
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-routines-cli-config-"));
    configPath = path.join(tempRoot, "config.json");
    writeTestConfig(configPath, tempRoot, tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("pauses only non-archived routines for the selected company", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const activeRoutineId = randomUUID();
    const pausedRoutineId = randomUUID();
    const archivedRoutineId = randomUUID();
    const otherCompanyRoutineId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other company",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Coder",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Other coder",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(projects).values([
      {
        id: projectId,
        companyId,
        name: "Project",
        status: "in_progress",
      },
      {
        id: otherProjectId,
        companyId: otherCompanyId,
        name: "Other project",
        status: "in_progress",
      },
    ]);

    await db.insert(routines).values([
      {
        id: activeRoutineId,
        companyId,
        projectId,
        assigneeAgentId: agentId,
        title: "Active routine",
        status: "active",
      },
      {
        id: pausedRoutineId,
        companyId,
        projectId,
        assigneeAgentId: agentId,
        title: "Paused routine",
        status: "paused",
      },
      {
        id: archivedRoutineId,
        companyId,
        projectId,
        assigneeAgentId: agentId,
        title: "Archived routine",
        status: "archived",
      },
      {
        id: otherCompanyRoutineId,
        companyId: otherCompanyId,
        projectId: otherProjectId,
        assigneeAgentId: otherAgentId,
        title: "Other company routine",
        status: "active",
      },
    ]);

    const result = await disableAllRoutinesInConfig({
      config: configPath,
      companyId,
    });

    expect(result).toMatchObject({
      companyId,
      totalRoutines: 3,
      pausedCount: 1,
      alreadyPausedCount: 1,
      archivedCount: 1,
    });

    const companyRoutines = await db
      .select({
        id: routines.id,
        status: routines.status,
      })
      .from(routines)
      .where(eq(routines.companyId, companyId));
    const statusById = new Map(companyRoutines.map((routine) => [routine.id, routine.status]));

    expect(statusById.get(activeRoutineId)).toBe("paused");
    expect(statusById.get(pausedRoutineId)).toBe("paused");
    expect(statusById.get(archivedRoutineId)).toBe("archived");

    const otherCompanyRoutine = await db
      .select({
        status: routines.status,
      })
      .from(routines)
      .where(eq(routines.id, otherCompanyRoutineId));
    expect(otherCompanyRoutine[0]?.status).toBe("active");
  });
});
