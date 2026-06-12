// Pin the host-side `issueService.getByLinearIssueId` lookup that the
// Linear plugin's webhook create handler depends on for dedup against
// host-allocator-written mirrors.
//
// Background (2026-05-03 cutover incident): under
// `companies.identifier_provider='linear'`, a paperclip issue created
// via any non-plugin path (originKind='manual', 'harness_liveness_escalation',
// etc.) goes through the allocator → mints a Linear issue + writes a
// linear_issue_links row → fires a Linear webhook back to the plugin.
// The plugin's existing dedup chain (sync.getLinkByLinear, inFlightCreates,
// existingByOrigin filtered to originKind='plugin:paperclip-plugin-linear')
// MISSED that row because the originKind is wrong. The plugin proceeded
// to create a second mirror, mint another Linear issue, fire another
// webhook — runaway loop produced 305 Linear noise issues + 161 paperclip
// rows in ~2 minutes before it was caught.
//
// This test pins the new lookup so a future refactor of the linear_issue_links
// schema or query path can't silently regress the dedup gap fix.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { companies, createDb, issues, linearIssueLinks } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueService.getByLinearIssueId (linear_issue_links lookup)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-getbylinear-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(linearIssueLinks);
    await db.delete(issues);
    await db.delete(companies);
  });

  async function seedCompany() {
    const [c] = await db
      .insert(companies)
      .values({
        name: `getbylinear ${randomUUID()}`,
        issuePrefix: `GL${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    return c;
  }

  it("returns the linked paperclip issue when a linear_issue_links row exists", async () => {
    const company = await seedCompany();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: "BLO-2569",
        issueNumber: 2569,
        title: "manual create with allocator-side Linear linkage",
        originKind: "manual",
      })
      .returning();
    const linearIssueUuid = randomUUID();
    await db.insert(linearIssueLinks).values({
      companyId: company.id,
      paperclipIssueId: issue.id,
      linearIssueId: linearIssueUuid,
      linearIdentifier: "BLO-2569",
    });

    const found = await svc.getByLinearIssueId(company.id, linearIssueUuid);
    expect(found?.id).toBe(issue.id);
    expect(found?.identifier).toBe("BLO-2569");
    expect(found?.originKind).toBe("manual");
  });

  it("returns null when no linear_issue_links row exists for that linearIssueId", async () => {
    const company = await seedCompany();
    await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: "BLO-1",
        issueNumber: 1,
        title: "no link row",
        originKind: "manual",
      })
      .returning();

    expect(await svc.getByLinearIssueId(company.id, randomUUID())).toBeNull();
  });

  // Note: there is no test here for "link row points to missing
  // paperclip issue" because the schema's `paperclip_issue_id REFERENCES
  // issues(id) ON DELETE CASCADE` makes that state unreachable —
  // attempting to insert such a link row fails the FK constraint at the
  // DB layer. The defensive `console.error` branch in
  // `getByLinearIssueId` is belt + suspenders insurance against a
  // future schema change that drops the FK; it can only be exercised
  // by integration tests that bypass the FK (not feasible here).

  it("scopes lookup to the company — same Linear UUID linked under company A is invisible to company B", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const [issueA] = await db
      .insert(issues)
      .values({
        companyId: companyA.id,
        identifier: "BLO-50",
        issueNumber: 50,
        title: "company A's mirror",
        originKind: "manual",
      })
      .returning();
    const linearIssueUuid = randomUUID();
    await db.insert(linearIssueLinks).values({
      companyId: companyA.id,
      paperclipIssueId: issueA.id,
      linearIssueId: linearIssueUuid,
      linearIdentifier: "BLO-50",
    });

    expect((await svc.getByLinearIssueId(companyA.id, linearIssueUuid))?.id).toBe(issueA.id);
    expect(await svc.getByLinearIssueId(companyB.id, linearIssueUuid)).toBeNull();
  });

  it("linkLinearIssue binds an existing Paperclip issue to an existing Linear issue", async () => {
    const company = await seedCompany();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: "BLO-60",
        issueNumber: 60,
        title: "Paperclip issue mirrored to Linear by plugin",
        originKind: "manual",
      })
      .returning();
    const linearIssueUuid = randomUUID();

    await svc.linkLinearIssue(company.id, {
      issueId: issue.id,
      linearIssueId: linearIssueUuid,
      linearIdentifier: "BLO-5431",
    });

    expect((await svc.getByLinearIssueId(company.id, linearIssueUuid))?.id).toBe(issue.id);

    await expect(svc.linkLinearIssue(company.id, {
      issueId: issue.id,
      linearIssueId: linearIssueUuid,
      linearIdentifier: "BLO-5431",
    })).resolves.toBeUndefined();
  });

  it("linkLinearIssue refreshes a stale Linear identifier for the same Paperclip issue and Linear UUID", async () => {
    const company = await seedCompany();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: "BLO-61",
        issueNumber: 61,
        title: "Paperclip issue with stale Linear identifier",
        originKind: "manual",
      })
      .returning();
    const linearIssueUuid = randomUUID();

    await svc.linkLinearIssue(company.id, {
      issueId: issue.id,
      linearIssueId: linearIssueUuid,
      linearIdentifier: "PCL-2093",
    });

    await expect(svc.linkLinearIssue(company.id, {
      issueId: issue.id,
      linearIssueId: linearIssueUuid,
      linearIdentifier: "BLO-1005",
    })).resolves.toBeUndefined();

    const [row] = await db
      .select({
        paperclipIssueId: linearIssueLinks.paperclipIssueId,
        linearIssueId: linearIssueLinks.linearIssueId,
        linearIdentifier: linearIssueLinks.linearIdentifier,
      })
      .from(linearIssueLinks);
    expect(row).toMatchObject({
      paperclipIssueId: issue.id,
      linearIssueId: linearIssueUuid,
      linearIdentifier: "BLO-1005",
    });
  });

  it("linkLinearIssue rejects conflicting Linear links", async () => {
    const company = await seedCompany();
    const [issueA, issueB] = await db
      .insert(issues)
      .values([
        {
          companyId: company.id,
          identifier: "BLO-70",
          issueNumber: 70,
          title: "first issue",
          originKind: "manual",
        },
        {
          companyId: company.id,
          identifier: "BLO-71",
          issueNumber: 71,
          title: "second issue",
          originKind: "manual",
        },
      ])
      .returning();
    const linearIssueUuid = randomUUID();

    await svc.linkLinearIssue(company.id, {
      issueId: issueA.id,
      linearIssueId: linearIssueUuid,
      linearIdentifier: "BLO-5432",
    });

    await expect(svc.linkLinearIssue(company.id, {
      issueId: issueB.id,
      linearIssueId: linearIssueUuid,
      linearIdentifier: "BLO-5432",
    })).rejects.toMatchObject({ status: 409 });
  });
});
