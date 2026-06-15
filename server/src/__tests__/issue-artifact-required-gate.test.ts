import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documents,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueDocuments,
  issueInboxArchives,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  findUnsatisfiedArtifactKeys,
  issueService,
  parseArtifactRequiredKeys,
} from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describe("parseArtifactRequiredKeys", () => {
  it("returns an empty list when the description is empty or missing", () => {
    expect(parseArtifactRequiredKeys(null)).toEqual([]);
    expect(parseArtifactRequiredKeys(undefined)).toEqual([]);
    expect(parseArtifactRequiredKeys("")).toEqual([]);
    expect(parseArtifactRequiredKeys("Nothing to see here")).toEqual([]);
  });

  it("extracts a single artifact_required key from a plain body", () => {
    const body = `## Dogfood

artifact_required: merged_sha_on_canon_master_at_close

The ticket carries its own gate.`;
    expect(parseArtifactRequiredKeys(body)).toEqual(["merged_sha_on_canon_master_at_close"]);
  });

  it("recognizes the declaration inside a fenced code block", () => {
    // BEAAA-5440 declares the key inside a code fence — that form must work.
    const body = "Setup:\n\n```\nartifact_required: merged_sha_on_canon_master_at_close\n```\n";
    expect(parseArtifactRequiredKeys(body)).toEqual(["merged_sha_on_canon_master_at_close"]);
  });

  it("is case-insensitive on both the keyword and the key, and lowercases the stored key", () => {
    expect(parseArtifactRequiredKeys("Artifact_Required: APPROVAL_SHA")).toEqual(["approval_sha"]);
    expect(parseArtifactRequiredKeys("Artifact_Required: approval_sha")).toEqual(["approval_sha"]);
  });

  it("dedupes repeated declarations", () => {
    const body = "artifact_required: foo\nartifact_required: bar\nartifact_required: foo\n";
    expect(parseArtifactRequiredKeys(body)).toEqual(["foo", "bar"]);
  });

  it("tolerates leading whitespace and markdown blockquote / list markers", () => {
    expect(parseArtifactRequiredKeys("> artifact_required: x_key")).toEqual(["x_key"]);
    expect(parseArtifactRequiredKeys("  - artifact_required: y_key")).toEqual(["y_key"]);
  });

  it("rejects keys with invalid characters (must be snake_case starting with a letter)", () => {
    expect(parseArtifactRequiredKeys("artifact_required: 1key")).toEqual([]);
    expect(parseArtifactRequiredKeys("artifact_required: with-dash")).toEqual([]);
  });
});

describe("findUnsatisfiedArtifactKeys", () => {
  const description = "artifact_required: merged_sha_on_canon_master_at_close\n";

  it("returns the declared key when no comment carries the artifact", () => {
    expect(findUnsatisfiedArtifactKeys(description, [])).toEqual([
      "merged_sha_on_canon_master_at_close",
    ]);
    expect(findUnsatisfiedArtifactKeys(description, ["unrelated note"])).toEqual([
      "merged_sha_on_canon_master_at_close",
    ]);
  });

  it("treats `<key>: <non-empty value>` in any comment as satisfaction", () => {
    expect(findUnsatisfiedArtifactKeys(description, [
      "merged_sha_on_canon_master_at_close: deadbeefcafebabe1234567890abcdef12345678",
    ])).toEqual([]);
  });

  it("accepts the satisfaction line inside a code fence", () => {
    const comment = "Closing:\n```\nmerged_sha_on_canon_master_at_close: abc1234\n```\n";
    expect(findUnsatisfiedArtifactKeys(description, [comment])).toEqual([]);
  });

  it("does NOT treat a redeclaration `artifact_required: <key>` as satisfaction", () => {
    // A comment that simply echoes the declaration must not clear the gate.
    expect(findUnsatisfiedArtifactKeys(description, [
      "artifact_required: merged_sha_on_canon_master_at_close",
    ])).toEqual(["merged_sha_on_canon_master_at_close"]);
  });

  it("requires a non-empty value after the colon", () => {
    expect(findUnsatisfiedArtifactKeys(description, [
      "merged_sha_on_canon_master_at_close: ",
    ])).toEqual(["merged_sha_on_canon_master_at_close"]);
  });

  it("returns missing keys for partially-satisfied multi-artifact declarations", () => {
    const multi = "artifact_required: foo\nartifact_required: bar\n";
    expect(findUnsatisfiedArtifactKeys(multi, ["foo: yes"])).toEqual(["bar"]);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres artifact_required gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.update — artifact_required close gate (BEAAA-5440 / -5287)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-artifact-required-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueDocuments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(documents);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Backbond",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("refuses to mark an issue done when its own artifact_required is unsatisfied (dogfood)", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "BEAAA-5440 dogfood",
      identifier: "T-5440",
      description: "artifact_required: merged_sha_on_canon_master_at_close\n",
      status: "in_progress",
      priority: "high",
    });

    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "ARTIFACT_REQUIRED_MISSING",
        missingArtifacts: expect.arrayContaining([
          expect.objectContaining({
            issueId,
            missingKeys: ["merged_sha_on_canon_master_at_close"],
          }),
        ]),
      }),
    });

    // The issue must remain in_progress — the failed PATCH must not partially apply.
    const [after] = await db.select().from(issues).where(sql`${issues.id} = ${issueId}`);
    expect(after.status).toBe("in_progress");
    expect(after.completedAt).toBeNull();
  });

  it("allows close once a comment supplies the required artifact", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "BEAAA-5440 dogfood (satisfied)",
      identifier: "T-5440",
      description: "artifact_required: merged_sha_on_canon_master_at_close\n",
      status: "in_progress",
      priority: "high",
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      body: "Landed on master: merged_sha_on_canon_master_at_close: deadbeef1234567890abcdef\n",
      authorType: "user",
      authorUserId: "founder",
    });

    const updated = await svc.update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("refuses parent→done when a still-open child has unsatisfied artifact_required (BEAAA-5287 cascade)", async () => {
    const companyId = await seedCompany();
    const parentId = randomUUID();
    const childWithGateId = randomUUID();
    const childCleanId = randomUUID();

    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent epic",
        identifier: "T-PARENT",
        description: "Epic with mixed children",
        status: "in_progress",
        priority: "high",
      },
      {
        id: childWithGateId,
        companyId,
        parentId,
        title: "Implementation child",
        identifier: "T-CHILD-IMPL",
        description: "artifact_required: merged_sha_on_canon_master_at_close\n",
        status: "in_review",
        priority: "high",
      },
      {
        id: childCleanId,
        companyId,
        parentId,
        title: "Sibling without gate",
        identifier: "T-CHILD-DOC",
        description: "Plain doc child",
        status: "todo",
        priority: "medium",
      },
    ]);

    await expect(svc.update(parentId, { status: "done" })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "ARTIFACT_REQUIRED_MISSING",
        missingArtifacts: expect.arrayContaining([
          expect.objectContaining({
            issueId: childWithGateId,
            issueIdentifier: "T-CHILD-IMPL",
            missingKeys: ["merged_sha_on_canon_master_at_close"],
          }),
        ]),
      }),
    });

    const [parentAfter] = await db.select().from(issues).where(sql`${issues.id} = ${parentId}`);
    expect(parentAfter.status).toBe("in_progress");
  });

  it("does not gate done-children of the parent transition (they were gated at their own close)", async () => {
    const companyId = await seedCompany();
    const parentId = randomUUID();
    const doneChildId = randomUUID();

    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent epic — children all done",
        identifier: "T-PARENT-OK",
        description: "Plain parent",
        status: "in_progress",
        priority: "high",
      },
      {
        // A child that closed long ago carrying an unmet artifact_required
        // must not retroactively block the parent — its own close was already
        // gated. This is the "no retroactive enforcement" rule from §Out of scope.
        id: doneChildId,
        companyId,
        parentId,
        title: "Already-closed child",
        identifier: "T-CHILD-DONE",
        description: "artifact_required: merged_sha_on_canon_master_at_close\n",
        status: "done",
        priority: "medium",
      },
    ]);

    const updated = await svc.update(parentId, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("does not gate transitions to cancelled (cancel is an explicit override)", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancel even with unmet artifact",
      identifier: "T-CANCEL",
      description: "artifact_required: some_key\n",
      status: "in_progress",
      priority: "low",
    });

    const updated = await svc.update(issueId, { status: "cancelled" });
    expect(updated?.status).toBe("cancelled");
  });

  it("does not gate issues without any artifact_required declaration", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Plain issue, no gate",
      identifier: "T-PLAIN",
      description: "Just a plain description.",
      status: "in_progress",
      priority: "low",
    });

    const updated = await svc.update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("refuses gate-strip: stripping the declaration in the same PATCH that closes does not bypass the gate", async () => {
    // Attack: caller PATCHes description (removing artifact_required) AND
    // status (→ done) in one call, hoping the new clean description means no
    // gate applies. The guard must use the UNION of pre-update + patched
    // description so the old declaration still blocks the close.
    const companyId = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Gate-strip attempt",
      identifier: "T-STRIP",
      description: "artifact_required: merged_sha_on_canon_master_at_close\nSome body.",
      status: "in_progress",
      priority: "high",
    });

    await expect(
      svc.update(issueId, {
        description: "Some body.", // declaration removed
        status: "done",
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "ARTIFACT_REQUIRED_MISSING",
      }),
    });
  });

  it("refuses late-add: adding a declaration in the same PATCH that closes still gates", async () => {
    // Attack from the other direction: caller adds a new artifact_required in
    // the same PATCH that closes. The guard must check the union, so the new
    // declaration applies even though it wasn't in the pre-update description.
    const companyId = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Late-add attempt",
      identifier: "T-LATE",
      description: "Plain body, no gate yet.",
      status: "in_progress",
      priority: "high",
    });

    await expect(
      svc.update(issueId, {
        description: "Plain body, no gate yet.\nartifact_required: merged_sha_on_canon_master_at_close",
        status: "done",
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "ARTIFACT_REQUIRED_MISSING",
      }),
    });
  });

  it("batches comment queries across the subject + open children (no N+1)", async () => {
    // Functional check that the batched-fetch refactor still produces the same
    // pass/fail outcomes as the per-issue loop. We don't measure query count
    // here (vitest setup doesn't expose drizzle telemetry cleanly), but we do
    // assert that a parent with multiple gated children that are ALL satisfied
    // by comments succeeds, and a single missing satisfaction surfaces only
    // the failing child in the error.
    const companyId = await seedCompany();
    const parentId = randomUUID();
    const childA = randomUUID();
    const childB = randomUUID();
    const childC = randomUUID();

    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent with three gated children",
        identifier: "T-MULTI-PARENT",
        description: "Plain parent",
        status: "in_progress",
        priority: "high",
      },
      {
        id: childA,
        companyId,
        parentId,
        title: "Child A",
        identifier: "T-MULTI-A",
        description: "artifact_required: merged_sha_on_canon_master_at_close",
        status: "in_review",
        priority: "high",
      },
      {
        id: childB,
        companyId,
        parentId,
        title: "Child B",
        identifier: "T-MULTI-B",
        description: "artifact_required: merged_sha_on_canon_master_at_close",
        status: "in_review",
        priority: "high",
      },
      {
        id: childC,
        companyId,
        parentId,
        title: "Child C",
        identifier: "T-MULTI-C",
        description: "artifact_required: merged_sha_on_canon_master_at_close",
        status: "in_review",
        priority: "high",
      },
    ]);

    // Satisfy A and B but not C.
    await db.insert(issueComments).values([
      {
        id: randomUUID(),
        companyId,
        issueId: childA,
        body: "merged_sha_on_canon_master_at_close: aaaa1111",
        authorType: "user",
        authorUserId: "founder",
      },
      {
        id: randomUUID(),
        companyId,
        issueId: childB,
        body: "merged_sha_on_canon_master_at_close: bbbb2222",
        authorType: "user",
        authorUserId: "founder",
      },
    ]);

    await expect(svc.update(parentId, { status: "done" })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "ARTIFACT_REQUIRED_MISSING",
        missingArtifacts: [
          expect.objectContaining({
            issueId: childC,
            issueIdentifier: "T-MULTI-C",
            missingKeys: ["merged_sha_on_canon_master_at_close"],
          }),
        ],
      }),
    });
  });
});
