// Mirror-import passthrough — pins down the linkedLinearIssue branch in
// allocateFromLinear that PR1 added.
//
// Without this branch, post-cutover the Linear plugin's webhook/import
// flow would call ctx.issues.create on a linear-provider company, which
// runs the allocator's IssueCreate GraphQL call and mints a brand-new
// Linear issue — duplicating the one the webhook fired about. This test
// asserts: when linkedLinearIssue is supplied, the allocator
//   1. does NOT call Linear,
//   2. returns the supplied identifier verbatim with the parsed suffix,
//   3. sets createdLinearSideIssue=false so the issues-create caller
//      suppresses the compensating Linear-delete on tx rollback.
//
// What this test does NOT pin down:
//   - The downstream linear_issue_links insert (covered at the
//     services/issues.ts integration layer in a follow-up).
//   - Paperclip-provider companies receiving linkedLinearIssue (the
//     allocator ignores it; allocateFromPaperclip never reads it).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { companies, createDb, plugins } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { allocateIdentifier } from "../services/identifier-allocator.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("allocateFromLinear (linkedLinearIssue passthrough)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fetchSpy: any = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-allocate-linked-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    await db.delete(plugins);
    await db.delete(companies);
  });

  async function seedLinearProviderCompany() {
    const [company] = await db
      .insert(companies)
      .values({
        name: `linked-passthrough ${randomUUID()}`,
        issuePrefix: `LP${randomUUID().slice(0, 6).toUpperCase()}`,
        identifierProvider: "linear",
      })
      .returning();
    return company;
  }

  it("returns the supplied identifier without calling Linear", async () => {
    const company = await seedLinearProviderCompany();

    const result = await allocateIdentifier({
      db,
      companyId: company.id,
      title: "irrelevant title — should not reach Linear",
      linkedLinearIssue: {
        id: "linear-uuid-existing-1234",
        identifier: "BLO-2562",
      },
    });

    expect(result.source).toBe("linear");
    expect(result.identifier).toBe("BLO-2562");
    expect(result.issueNumber).toBe(2562);
    expect(result.externalIssueId).toBe("linear-uuid-existing-1234");
    expect(result.createdLinearSideIssue).toBe(false);

    // The whole point: no IssueCreate call, no duplicate Linear issue.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed identifiers that lack the numeric suffix", async () => {
    const company = await seedLinearProviderCompany();

    await expect(
      allocateIdentifier({
        db,
        companyId: company.id,
        title: "doesn't matter",
        linkedLinearIssue: {
          id: "linear-uuid-x",
          identifier: "no-suffix-here",
        },
      }),
    ).rejects.toThrow(/Unexpected Linear identifier format/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores linkedLinearIssue on paperclip-provider companies (allocator returns paperclip id)", async () => {
    // allocateFromPaperclip doesn't read linkedLinearIssue; the caller
    // (services/issues.ts) writes the link row with the supplied values
    // separately. Pin the contract: passing linkedLinearIssue does not
    // suddenly force the allocator down the Linear path on a paperclip
    // company, and createdLinearSideIssue stays false.
    const [company] = await db
      .insert(companies)
      .values({
        name: `linked-paperclip ${randomUUID()}`,
        issuePrefix: `PP${randomUUID().slice(0, 6).toUpperCase()}`,
        identifierProvider: "paperclip",
      })
      .returning();

    const result = await allocateIdentifier({
      db,
      companyId: company.id,
      title: "paperclip co",
      linkedLinearIssue: {
        id: "linear-uuid-mirror",
        identifier: "BLO-9000",
      },
    });

    expect(result.source).toBe("paperclip");
    expect(result.identifier).toMatch(/^PP[A-Z0-9]+-1$/);
    expect(result.issueNumber).toBe(1);
    expect(result.externalIssueId).toBeUndefined();
    expect(result.createdLinearSideIssue).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
