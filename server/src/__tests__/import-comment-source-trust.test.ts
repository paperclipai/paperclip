import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { parse, stringify } from "yaml";
import { portabilityIssueCommentManifestEntrySchema } from "@paperclipai/shared/validators/company-portability";
import { companyPortabilityService } from "../services/company-portability.js";
import { issueService } from "../services/issues.js";
import type { ImportIssueCommentRow } from "../services/import-write-types.js";
import { LOW_TRUST_QUARANTINED_BODY, sanitizeQuarantinedCommentForHigherTrust } from "../services/source-trust.js";
import { retainTaskProviderOutputPolicy, taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const quarantine = { preset: "low_trust_review", disposition: "quarantined" } as const;
const include = { company: true, agents: false, projects: false, issues: true, skills: false };

function row(scope: { companyId: string; issueId: string }, sourceTrust?: unknown): ImportIssueCommentRow {
  return { ...scope, id: randomUUID(), body: "Synthetic quarantined source body", authorType: "system",
    authorAgentId: null, authorUserId: null, presentation: null, metadata: null, createdAt: null,
    sourceTrust } as ImportIssueCommentRow;
}

function historicalTrust(disposition: "quarantined" | "promoted") {
  return { preset: "low_trust_review" as const, disposition, sourceIssueId: randomUUID(), sourceRunId: randomUUID(),
    sourceAgentId: randomUUID(), promotedFrom: { artifactKind: "comment" as const, artifactId: randomUUID(), issueId: randomUUID() },
    promotedByActorType: "user" as const, promotedByActorId: "synthetic-historical-user", promotedAt: "2026-05-04T12:00:00.000Z" };
}

describePostgres("imported comment source-trust retention", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-import-comment-trust-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic comment history", issuePrefix: `H${companyId.slice(0, 8)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic destination" });
    await retainTaskProviderOutputPolicy(db, { companyId, issueId, disposition: "ordinary" });
    return { companyId, issueId };
  }

  for (const disposition of ["quarantined", "promoted"] as const) {
    it.each(["system", "user", "agent"] as const)(`${disposition} history stays quarantined with %s display authorship`, async authorType => {
      const scope = await fixture(), untouched = await fixture();
      const input = { ...row(scope, historicalTrust(disposition)), authorType };
      await issueService(db).addImportedComments([input]);
      const [saved] = await issueService(db).listComments(scope.issueId);
      expect(saved.sourceTrust).toEqual(quarantine);
      expect(saved.createdByRunId).toBeNull();
      expect(saved.authorType).toBe(authorType);
      expect(saved.body).toBe(input.body);
      const sanitized = sanitizeQuarantinedCommentForHigherTrust(saved);
      expect(sanitized.body).toBe(LOW_TRUST_QUARANTINED_BODY);
      expect(sanitized.presentation).toBeNull();
      expect(sanitized.metadata).toBeNull();
      expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
      expect(await taskForbidsProviderOutput(db, untouched)).toBe(false);
    });
  }

  it.each(["invalid", { preset: "low_trust_review", disposition: "ordinary" },
    { preset: "standard", disposition: "promoted" }, { ...quarantine, sourceRunId: "invalid" }])(
    "rejects unsupported source trust without a valid-prefix write: %j", async sourceTrust => {
      const scope = await fixture();
      await expect(issueService(db).addImportedComments([row(scope, quarantine), row(scope, sourceTrust)]))
        .rejects.toMatchObject({ status: 422 });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).toHaveLength(0);
      expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
    });

  it.each([null, undefined])("does not invent a low-trust origin for unmarked content: %s", async sourceTrust => {
    const scope = await fixture();
    await issueService(db).addImportedComments([row(scope, sourceTrust)]);
    const [saved] = await issueService(db).listComments(scope.issueId);
    expect(saved.sourceTrust).toBeNull();
    expect(saved.createdByRunId).toBeNull();
    expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
  });

  it("rolls back comment trust and output denial with the caller transaction", async () => {
    const scope = await fixture();
    await expect(db.transaction(async tx => {
      await issueService(tx as unknown as typeof db).addImportedComments([row(scope, quarantine)]);
      expect((await tx.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId)))[0].sourceTrust).toEqual(quarantine);
      throw new Error("Synthetic caller rollback");
    })).rejects.toThrow("Synthetic caller rollback");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, scope.issueId))).toHaveLength(0);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
  });

  it("reconstructs quarantine without needing historical source records", async () => {
    const scope = await fixture();
    await issueService(db).addImportedComments([row(scope, historicalTrust("quarantined"))]);
    const [saved] = await issueService(db).listComments(scope.issueId);
    expect(saved.sourceTrust).toEqual(quarantine);
    expect(sanitizeQuarantinedCommentForHigherTrust(saved).body).toBe(LOW_TRUST_QUARANTINED_BODY);
    expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
  });

  it.each(["quarantined", "promoted"] as const)("exports %s history without foreign live identity or promotion assertions", async disposition => {
    const scope = await fixture();
    const sourceTrust = historicalTrust(disposition);
    await db.insert(issueComments).values({ ...scope, body: "Synthetic retained source", authorType: "system", sourceTrust });
    const service = companyPortabilityService(db);
    const exported = await service.exportBundle(scope.companyId, { include });
    const comment = exported.manifest.issues[0]!.comments[0]!;
    expect(comment).toHaveProperty("sourceTrust", quarantine);
    const extension = String(exported.files[".paperclip.yaml"]);
    for (const value of [sourceTrust.sourceIssueId, sourceTrust.sourceRunId, sourceTrust.sourceAgentId,
      sourceTrust.promotedFrom.artifactId, sourceTrust.promotedByActorId]) expect(extension).not.toContain(value);
    expect(portabilityIssueCommentManifestEntrySchema.parse(comment)).toHaveProperty("sourceTrust", quarantine);
    const preview = await service.previewImport({ source: { type: "inline", files: exported.files }, include,
      target: { mode: "new_company" } });
    expect(preview.manifest.issues[0]!.comments[0]).toHaveProperty("sourceTrust", quarantine);
    expect(preview.errors).toContainEqual(expect.stringContaining("Task-content import is unavailable"));
  });

  it("keeps normalized quarantine through parsed bulk copy, source deletion and re-export", async () => {
    const source = await fixture(), destination = await fixture();
    await issueService(db).addImportedComments([row(source, historicalTrust("promoted"))]);
    const service = companyPortabilityService(db);
    const exported = await service.exportBundle(source.companyId, { include });
    const preview = await service.previewImport({ source: { type: "inline", files: exported.files }, include,
      target: { mode: "new_company" } });
    const comment = preview.manifest.issues[0]!.comments[0]!;
    await issueService(db).addImportedComments([{ ...row(destination, comment.sourceTrust), body: comment.body }]);
    await db.delete(issues).where(eq(issues.id, source.issueId));
    const copied = await companyPortabilityService(db).exportBundle(destination.companyId, { include });
    expect(copied.manifest.issues[0]!.comments[0]).toMatchObject({ body: comment.body, sourceTrust: quarantine });
    expect(await taskForbidsProviderOutput(db, destination)).toBe(true);
    expect(sanitizeQuarantinedCommentForHigherTrust((await issueService(db).listComments(destination.issueId))[0]).body)
      .toBe(LOW_TRUST_QUARANTINED_BODY);
  });

  it.each(["quarantined", "promoted"] as const)("normalizes a caller-edited %s declaration before preview, without treating it as release", async disposition => {
    const scope = await fixture();
    await issueService(db).addComment(scope.issueId, "Synthetic source", { userId: "synthetic-board" });
    const exported = await companyPortabilityService(db).exportBundle(scope.companyId, { include });
    const files = { ...exported.files };
    const extension = parse(String(files[".paperclip.yaml"]));
    const task = Object.values(extension.tasks as Record<string, { comments: Array<{ sourceTrust?: unknown }> }>)[0];
    task.comments[0].sourceTrust = historicalTrust(disposition);
    files[".paperclip.yaml"] = stringify(extension);
    expect(files[".paperclip.yaml"]).toContain(`disposition: ${disposition}`);
    const service = companyPortabilityService(db);
    const input = { source: { type: "inline" as const, files }, include, target: { mode: "new_company" as const } };
    const preview = await service.previewImport(input);
    expect(preview.manifest.issues[0]!.comments[0]).toHaveProperty("sourceTrust", quarantine);
    await expect(service.importBundle(input, "synthetic-board")).rejects.toMatchObject({ status: 422 });
    expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
  });
});
