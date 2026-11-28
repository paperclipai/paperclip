import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  projectWorkspaces,
  projects as projectsTable,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project runtime exposure tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("project workspace runtime service exposure", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-runtime-exposure-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceRuntimeServices);
    await db.delete(projectWorkspaces);
    await db.delete(projectsTable);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns the saved exposure on project workspace runtime services", async () => {
    const [company] = await db.insert(companies).values({ name: "Exposure Co", issuePrefix: "EXP" }).returning();
    const projects = projectService(db);
    const project = await projects.create(company!.id, { name: "Exposed" });
    const [workspace] = await db
      .insert(projectWorkspaces)
      .values({ companyId: company!.id, projectId: project.id, name: "Primary", cwd: "/repo", isPrimary: true })
      .returning();
    const exposure = {
      provider: "tailscale_https" as const,
      state: "ready" as const,
      publicUrl: "https://node.example.ts.net:8443",
      hostname: "node.example.ts.net",
      listeners: [],
      brokerRef: null,
      lastError: null,
      updatedAt: null,
    };
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId: company!.id,
      projectId: project.id,
      projectWorkspaceId: workspace!.id,
      scopeType: "project_workspace",
      scopeId: workspace!.id,
      serviceName: "web",
      status: "running",
      lifecycle: "shared",
      command: "pnpm dev --bind loopback",
      cwd: "/repo",
      port: 50123,
      provider: "local_process",
      exposure,
    });

    const [listed] = await projects.listWorkspaces(project.id);

    expect(listed?.runtimeServices).toHaveLength(1);
    expect(listed?.runtimeServices?.[0]?.exposure).toEqual(exposure);
  });
});
