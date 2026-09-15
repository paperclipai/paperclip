import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  authUsers,
  cases,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "../middleware/auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres tenant provisioning tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SERVER_TOKEN = "test-server-token";

function tenantHeaders(input: { stackId: string; userId: string; companyName?: string }) {
  const headers: Record<string, string> = {
    "x-paperclip-cloud-tenant-token": SERVER_TOKEN,
    "x-paperclip-cloud-user-id": input.userId,
    "x-paperclip-cloud-user-email": `${input.userId}@example.com`,
    "x-paperclip-cloud-stack-id": input.stackId,
    "x-paperclip-cloud-stack-role": "owner",
  };
  if (input.companyName) headers["x-paperclip-cloud-paperclip-company-name"] = input.companyName;
  return cloudActorHeaderSourceFromHeaders(headers);
}

/**
 * The prefix a pre-name-derivation build wrote. Pinned here on purpose: the
 * repair detects legacy rows by this exact value, so it must keep matching
 * what those builds produced.
 */
function legacyProvisionedPrefix(stackId: string) {
  return `PC${createHash("sha256").update(stackId).digest("hex").slice(0, 4).toUpperCase()}`;
}

function legacyProvisionedDescription(stackId: string) {
  return `Provisioned by Paperclip Cloud for stack ${stackId}.`;
}

describeEmbeddedPostgres("cloud tenant company provisioning", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tenant-provisioning-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = SERVER_TOKEN;
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(cases);
    await db.delete(issues);
    await db.delete(companies);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function readCompany(companyId: string) {
    return db
      .select({
        name: companies.name,
        issuePrefix: companies.issuePrefix,
        description: companies.description,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function readIdentifiers(companyId: string) {
    const issueRows = await db
      .select({ identifier: issues.identifier })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    const caseRows = await db
      .select({ identifier: cases.identifier })
      .from(cases)
      .where(eq(cases.companyId, companyId));
    return {
      issues: issueRows.map((row) => row.identifier).sort(),
      cases: caseRows.map((row) => row.identifier).sort(),
    };
  }

  describe("claim time", () => {
    it("derives the issue prefix from the company name and writes no placeholder description", async () => {
      const actor = await resolveCloudTenantActor(
        db,
        tenantHeaders({ stackId: "stack-claim-1", userId: "user-claim-1", companyName: "Acme Robotics" }),
      );

      const companyId = actor!.companyIds![0]!;
      await expect(readCompany(companyId)).resolves.toEqual({
        name: "Acme Robotics",
        issuePrefix: "ACM",
        description: null,
      });
    });

    it("derives the prefix from the humanized stack slug when no company name header is sent", async () => {
      const actor = await resolveCloudTenantActor(
        db,
        tenantHeaders({ stackId: "paperclip-stack-borealis", userId: "user-claim-2" }),
      );

      const companyId = actor!.companyIds![0]!;
      await expect(readCompany(companyId)).resolves.toMatchObject({
        name: "Borealis",
        issuePrefix: "BOR",
        description: null,
      });
    });

    it("suffixes the derived prefix when another company already holds it", async () => {
      await db.insert(companies).values({ name: "Acme Holdings", issuePrefix: "ACM" });

      const actor = await resolveCloudTenantActor(
        db,
        tenantHeaders({ stackId: "stack-claim-3", userId: "user-claim-3", companyName: "Acme Robotics" }),
      );

      const companyId = actor!.companyIds![0]!;
      await expect(readCompany(companyId)).resolves.toMatchObject({
        name: "Acme Robotics",
        issuePrefix: "ACMA",
      });
    });
  });

  describe("legacy provisioning repair", () => {
    /**
     * Claims the company through the normal path, then rewrites it into the
     * shape a pre-name-derivation build left behind.
     */
    async function seedLegacyCompany(input: {
      stackId: string;
      claimUserId: string;
      companyName: string;
      issuePrefix?: string;
      description?: string | null;
    }) {
      const actor = await resolveCloudTenantActor(
        db,
        tenantHeaders({
          stackId: input.stackId,
          userId: input.claimUserId,
          companyName: input.companyName,
        }),
      );
      const companyId = actor!.companyIds![0]!;
      const issuePrefix = input.issuePrefix ?? legacyProvisionedPrefix(input.stackId);
      await db
        .update(companies)
        .set({
          issuePrefix,
          description: input.description === undefined
            ? legacyProvisionedDescription(input.stackId)
            : input.description,
        })
        .where(eq(companies.id, companyId));
      await db.insert(issues).values([
        { companyId, title: "First", issueNumber: 1, identifier: `${issuePrefix}-1` },
        { companyId, title: "Second", issueNumber: 20, identifier: `${issuePrefix}-20` },
      ]);
      await db.insert(cases).values({
        companyId,
        caseNumber: 4,
        identifier: `${issuePrefix}-C4`,
        caseType: "decision",
        title: "A case",
      });
      return { companyId, issuePrefix };
    }

    it("re-derives the prefix, clears the placeholder, and re-keys both identifier tables", async () => {
      const stackId = "stack-repair-1";
      const { companyId, issuePrefix: legacyPrefix } = await seedLegacyCompany({
        stackId,
        claimUserId: "user-repair-seed-1",
        companyName: "Acme Robotics",
      });

      await resolveCloudTenantActor(
        db,
        tenantHeaders({ stackId, userId: "user-repair-1", companyName: "Acme Robotics" }),
      );

      await expect(readCompany(companyId)).resolves.toEqual({
        name: "Acme Robotics",
        issuePrefix: "ACM",
        description: null,
      });
      await expect(readIdentifiers(companyId)).resolves.toEqual({
        issues: ["ACM-1", "ACM-20"],
        cases: ["ACM-C4"],
      });

      const logged = await db
        .select({ details: activityLog.details })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "company.updated"),
        ));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        details: {
          source: "cloud_tenant_auth",
          reason: "legacy_provision_defaults_repair",
          previousIssuePrefix: legacyPrefix,
          issuePrefix: "ACM",
          descriptionCleared: true,
          issuesRekeyed: 2,
          casesRekeyed: 1,
        },
      });
    });

    it("is a no-op on a second pass", async () => {
      const stackId = "stack-repair-2";
      const { companyId } = await seedLegacyCompany({
        stackId,
        claimUserId: "user-repair-seed-2",
        companyName: "Acme Robotics",
      });

      await resolveCloudTenantActor(
        db,
        tenantHeaders({ stackId, userId: "user-repair-2a", companyName: "Acme Robotics" }),
      );
      const afterFirstPass = await readCompany(companyId);

      await resolveCloudTenantActor(
        db,
        tenantHeaders({ stackId, userId: "user-repair-2b", companyName: "Acme Robotics" }),
      );

      await expect(readCompany(companyId)).resolves.toEqual(afterFirstPass);
      await expect(readIdentifiers(companyId)).resolves.toEqual({
        issues: ["ACM-1", "ACM-20"],
        cases: ["ACM-C4"],
      });
      // The repair logged once, on the pass that actually changed the row.
      const logged = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "company.updated"),
        ));
      expect(logged).toHaveLength(1);
    });

    it("clears only the placeholder description when the prefix is not the legacy hash", async () => {
      const stackId = "stack-repair-3";
      const { companyId } = await seedLegacyCompany({
        stackId,
        claimUserId: "user-repair-seed-3",
        companyName: "Acme Robotics",
        // A prefix the operator already re-derived or chose.
        issuePrefix: "ZEN",
      });

      await resolveCloudTenantActor(
        db,
        tenantHeaders({ stackId, userId: "user-repair-3", companyName: "Acme Robotics" }),
      );

      await expect(readCompany(companyId)).resolves.toEqual({
        name: "Acme Robotics",
        issuePrefix: "ZEN",
        description: null,
      });
      // Nothing was re-keyed, so the identifiers keep the prefix they had.
      await expect(readIdentifiers(companyId)).resolves.toEqual({
        issues: ["ZEN-1", "ZEN-20"],
        cases: ["ZEN-C4"],
      });
      const logged = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(eq(activityLog.companyId, companyId));
      expect(logged).toHaveLength(0);
    });

    it("leaves an operator-written description alone while it re-derives the prefix", async () => {
      const stackId = "stack-repair-4";
      const { companyId } = await seedLegacyCompany({
        stackId,
        claimUserId: "user-repair-seed-4",
        companyName: "Acme Robotics",
        description: "We build robots.",
      });

      await resolveCloudTenantActor(
        db,
        tenantHeaders({ stackId, userId: "user-repair-4", companyName: "Acme Robotics" }),
      );

      await expect(readCompany(companyId)).resolves.toEqual({
        name: "Acme Robotics",
        issuePrefix: "ACM",
        description: "We build robots.",
      });
    });
  });
});
