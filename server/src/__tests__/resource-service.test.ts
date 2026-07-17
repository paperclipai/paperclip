import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, resources } from "@paperclipai/db";
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
    expect(await svc.list(companyId)).toEqual([]);
    expect((await svc.list(companyId, true)).map((resource) => resource.status)).toEqual(["archived"]);
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
});
