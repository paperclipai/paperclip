import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, projects, projectWorkspaces } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project workspace provisioning tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("projectService workspace provisioning", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof projectService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempRoot!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-workspace-");
    db = createDb(tempDb.connectionString);
    svc = projectService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = "";
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace Project",
      status: "backlog",
    });

    return { companyId, projectId };
  }

  it("creates the local workspace directory when a project workspace is created", async () => {
    const { projectId } = await seedProject();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-project-workspace-create-"));
    const cwd = path.join(tempRoot, "new-workspace");

    const created = await svc.createWorkspace(projectId, {
      cwd,
      sourceType: "local_path",
      isPrimary: true,
    });

    expect(created?.cwd).toBe(cwd);
    await expect(fs.stat(cwd)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("creates the new local workspace directory when cwd is updated", async () => {
    const { projectId } = await seedProject();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-project-workspace-update-"));
    const firstCwd = path.join(tempRoot, "first-workspace");
    const nextCwd = path.join(tempRoot, "second-workspace");

    const created = await svc.createWorkspace(projectId, {
      cwd: firstCwd,
      sourceType: "local_path",
      isPrimary: true,
    });

    expect(created).not.toBeNull();
    const updated = await svc.updateWorkspace(projectId, created!.id, {
      cwd: nextCwd,
    });

    expect(updated?.cwd).toBe(nextCwd);
    await expect(fs.stat(nextCwd)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("rejects create when the local workspace directory cannot be provisioned", async () => {
    const { projectId } = await seedProject();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-project-workspace-fail-create-"));
    const cwd = path.join(tempRoot, "blocked-workspace");
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockRejectedValueOnce(new Error("permission denied"));

    await expect(
      svc.createWorkspace(projectId, {
        cwd,
        sourceType: "local_path",
        isPrimary: true,
      }),
    ).resolves.toBeNull();

    const persisted = await db.select().from(projectWorkspaces);
    expect(persisted).toHaveLength(0);

    mkdirSpy.mockRestore();
  });
});
