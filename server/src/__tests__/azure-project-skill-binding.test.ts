import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, companies, createDb, projectProviderAuthorizations, projectSkillSources, projectWorkspaces, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { enqueueProjectSkillSource, projectSkillRepository } from "../services/project-skill-source-bindings.js";
import { eq } from "drizzle-orm";

const support = await getEmbeddedPostgresTestSupport();
const repo = (workspace: { repoUrl: string | null; defaultRef?: string | null; repoRef?: string | null; metadata?: unknown }) =>
  projectSkillRepository(workspace as Parameters<typeof projectSkillRepository>[0]);

describe("Azure project skill source binding", () => {
  it("recognizes a valid Azure workspace only with matching provider metadata and exact repository URL", () => {
    expect(repo({ repoUrl: "https://dev.azure.com/Contoso/Platform/_git/paperclip", defaultRef: "main",
      metadata: { repositoryProvider: "azure-devops", repositoryId: "azure-devops:contoso:12345678-1234-1234-1234-1234567890ab" } })).toMatchObject({
      repositoryUrl: "https://dev.azure.com/Contoso/Platform/_git/paperclip", trackingRef: "main",
    });
  });

  it("retains existing GitHub normalization and tracking-ref behavior", () => {
    expect(repo({ repoUrl: "git@github.com:PaperclipAI/Skills.git", defaultRef: null, repoRef: "release" })).toEqual({
      repositoryUrl: "https://github.com/paperclipai/skills", trackingRef: "release",
    });
  });

  it.each([
    "https://user:secret@dev.azure.com/Contoso/Platform/_git/paperclip",
    "https://dev.azure.com/Contoso/Platform/_git/paperclip?token=secret",
    "https://dev.azure.com/Contoso/Platform/_git/paperclip#fragment",
    "https://dev.azure.com/Contoso/Platform/_git/paperclip/extra",
  ])("rejects unsafe or non-exact Azure repository URL %s", repoUrl => {
    expect(repo({ repoUrl, metadata: { repositoryProvider: "azure-devops", repositoryId: "azure-devops:contoso:12345678-1234-1234-1234-1234567890ab" } })).toBeNull();
  });

  it.each([
    { repositoryProvider: "github", repositoryId: "azure-devops:contoso:12345678-1234-1234-1234-1234567890ab" },
    { repositoryProvider: "azure-devops", repositoryId: "azure-devops:other:12345678-1234-1234-1234-1234567890ab" },
    { repositoryProvider: "azure-devops", repositoryId: "azure-devops:contoso:not-a-uuid" },
    { repositoryProvider: "azure-devops", repositoryId: "" },
    { repositoryProvider: "azure-devops" },
  ])("does not bind Azure URL with invalid or missing provider metadata %j", metadata => {
    expect(repo({ repoUrl: "https://dev.azure.com/Contoso/Platform/_git/paperclip", metadata })).toBeNull();
  });

  it("does not bind a missing repository URL", () => {
    expect(repo({ repoUrl: null, metadata: { repositoryProvider: "azure-devops", repositoryId: "azure-devops:contoso:12345678-1234-1234-1234-1234567890ab" } })).toBeNull();
  });
});

describe.skipIf(!support.supported)("Azure skill work waits in the project queue for project authorization", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-azure-project-skill-binding-");
    await applyPendingMigrations(database.connectionString);
    db = createDb(database.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Azure project skills", issuePrefix: "AZSK" });
    const [project] = await db.insert(projects).values({ companyId, name: "Platform" }).returning({ id: projects.id });
    projectId = project!.id;
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId, projectId, name: "paperclip",
      repoUrl: "https://dev.azure.com/Contoso/Platform/_git/paperclip", defaultRef: "main",
      metadata: { repositoryProvider: "azure-devops", repositoryId: "azure-devops:contoso:12345678-1234-1234-1234-1234567890ab" } }).returning({ id: projectWorkspaces.id });
    workspaceId = workspace!.id;
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  it("keeps the automatically bound repository queued without importing before project authorization exists", async () => {
    const [workspace] = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, workspaceId));
    const binding = await enqueueProjectSkillSource(db, workspace!, { refreshUserId: null, refreshAgentId: null,
      refreshLocalTrusted: false, connectionId: null, refreshGrantId: null });
    expect(binding).not.toBeNull();
    const authorizations = await db.select().from(projectProviderAuthorizations).where(eq(projectProviderAuthorizations.projectId, projectId));
    const [saved] = await db.select().from(projectSkillSources).where(eq(projectSkillSources.id, binding!.id));

    expect(authorizations).toHaveLength(0);
    expect(saved).toMatchObject({ active: true, status: "pending", sourceId: null, lastError: null,
      repositoryUrl: "https://dev.azure.com/Contoso/Platform/_git/paperclip", trackingRef: "main" });
  });
});
