import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySecrets, createDb, resources } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resourceService } from "../services/resources.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("resourceService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resource-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(resources);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates, lists, updates, and archives company resources", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Resource Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const svc = resourceService(db);
    const created = await svc.create(companyId, {
      key: "platform_code",
      type: "git",
      repository: "/tmp/platform",
      sourcePath: null,
      defaultRef: "main",
      mountPath: "platform_code",
      credentialRef: null,
      labels: { purpose: "code" },
    });

    expect(created.status).toBe("active");
    expect((await svc.list(companyId)).map((resource) => resource.key)).toEqual(["platform_code"]);
    expect((await svc.update(created.id, { defaultRef: "develop" }))?.defaultRef).toBe("develop");
    expect((await svc.archive(created.id))?.status).toBe("archived");
    await expect(svc.create(companyId, {
      key: "platform_code",
      type: "git",
      repository: "/tmp/platform-next",
      sourcePath: null,
      defaultRef: "main",
      mountPath: "platform_code",
      credentialRef: null,
      labels: { purpose: "replacement" },
    })).resolves.toMatchObject({ key: "platform_code", mountPath: "platform_code", status: "active" });
    expect((await svc.list(companyId)).map((resource) => resource.key)).toEqual(["platform_code"]);
    expect((await svc.list(companyId, true)).map((resource) => resource.status)).toEqual(["active", "archived"]);
  });

  it("keeps resource keys company-scoped", async () => {
    const firstCompanyId = randomUUID();
    const secondCompanyId = randomUUID();
    await db.insert(companies).values([
      {
        id: firstCompanyId,
        name: "First",
        issuePrefix: `F${firstCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: secondCompanyId,
        name: "Second",
        issuePrefix: `S${secondCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    const svc = resourceService(db);
    const input = {
      key: "shared_name",
      type: "git" as const,
      repository: "/tmp/repo",
      sourcePath: null,
      defaultRef: "main",
      mountPath: "shared_name",
      credentialRef: null,
      labels: {},
    };
    await svc.create(firstCompanyId, input);
    await expect(svc.create(secondCompanyId, input)).resolves.toMatchObject({ companyId: secondCompanyId });
  });

  it("allows clearing a credential reference whose secret no longer exists", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Credential Cleanup Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const created = await resourceService(db).create(companyId, {
      key: "credentialed",
      type: "git",
      repository: "/tmp/repo",
      sourcePath: null,
      defaultRef: "main",
      mountPath: "credentialed",
      credentialRef: null,
      labels: {},
    });
    await db.update(resources).set({ credentialRef: randomUUID() }).where(eq(resources.id, created.id));

    await expect(resourceService(db).update(created.id, { defaultRef: "develop" })).resolves.toMatchObject({ defaultRef: "develop" });
    await expect(resourceService(db).update(created.id, { credentialRef: null })).resolves.toMatchObject({ credentialRef: null });
  });

  it("rejects credential-backed SSH repositories at save time", async () => {
    const companyId = randomUUID();
    const credentialRef = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Credential Validation Co",
      issuePrefix: `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companySecrets).values({
      id: credentialRef,
      companyId,
      name: "GitHub token",
    });

    await expect(resourceService(db).create(companyId, {
      key: "ssh-repo",
      type: "git",
      repository: "git@github.com:acme/repo.git",
      sourcePath: null,
      defaultRef: "main",
      mountPath: "ssh-repo",
      credentialRef,
      labels: {},
    })).rejects.toThrow("Credential-backed Resources require an HTTPS Git repository");
  });
});
