import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, documentRevisions, documents, executionWorkspaces, heartbeatRuns, issueDocuments, issues, issueWorkProducts, workspaceRuntimeServices } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { parse, stringify } from "yaml";
import { portabilityIssueDocumentManifestEntrySchema, portabilityIssueWorkProductManifestEntrySchema } from "@paperclipai/shared/validators/company-portability";
import { companyPortabilityService } from "../services/company-portability.js";
import { documentService } from "../services/documents.js";
import { workProductService } from "../services/work-products.js";
import type { ImportIssueDocumentRow, ImportIssueWorkProductRow } from "../services/import-write-types.js";
import { isLowTrustQuarantined, LOW_TRUST_QUARANTINED_BODY, redactQuarantinedBodyForHigherTrust } from "../services/source-trust.js";
import { retainTaskProviderOutputPolicy, taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const quarantine = { preset: "low_trust_review", disposition: "quarantined" } as const;
const include = { company: true, agents: false, projects: false, issues: true, skills: false };
type Scope = { companyId: string; issueId: string };
type Kind = "document" | "work_product";

function historicalTrust(kind: Kind, disposition: "quarantined" | "promoted") {
  return { preset: "low_trust_review" as const, disposition, sourceIssueId: randomUUID(), sourceRunId: randomUUID(),
    sourceAgentId: randomUUID(), promotedFrom: { artifactKind: kind, artifactId: randomUUID(), issueId: randomUUID() },
    promotedByActorType: "user" as const, promotedByActorId: "synthetic-historical-user", promotedAt: "2026-05-04T12:00:00.000Z" };
}

function documentRow(scope: Scope, sourceTrust: unknown = null): ImportIssueDocumentRow {
  return { ...scope, key: "report", title: "Synthetic retained document", format: "markdown", body: "Synthetic retained body",
    createdByAgentId: null, createdByUserId: null, createdByRunId: null, sourceTrust } as ImportIssueDocumentRow;
}

function productRow(scope: Scope, sourceTrust: unknown = null): ImportIssueWorkProductRow {
  return { ...scope, projectId: null, type: "artifact", provider: "paperclip", externalId: null,
    title: "Synthetic retained product", url: null, status: "active", reviewState: "none", isPrimary: false,
    healthStatus: "unknown", summary: "Synthetic retained summary", metadata: null,
    executionWorkspaceId: null, runtimeServiceId: null, createdByRunId: null, sourceTrust } as ImportIssueWorkProductRow;
}

describePostgres("imported document and work-product source trust", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-import-artifact-trust-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function fixture(): Promise<Scope> {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic artifact history", issuePrefix: `H${companyId.slice(0, 8)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic destination" });
    await retainTaskProviderOutputPolicy(db, { companyId, issueId, disposition: "ordinary" });
    return { companyId, issueId };
  }
  async function write(kind: Kind, scope: Scope, sourceTrust: unknown, database = db) {
    if (kind === "document") await documentService(database).createIssueDocumentsForImport([documentRow(scope, sourceTrust)]);
    else await workProductService(database).createManyForImport([productRow(scope, sourceTrust)]);
  }
  async function read(kind: Kind, scope: Scope) {
    return kind === "document"
      ? (await documentService(db).getIssueDocumentByKey(scope.issueId, "report"))!
      : (await workProductService(db).listForIssue(scope.issueId, { refreshPullRequests: false }))[0]!;
  }
  for (const kind of ["document", "work_product"] as const) {
    it.each(["quarantined", "promoted"] as const)(`${kind} normalizes %s history without live source or promotion authority`, async disposition => {
      const scope = await fixture(), untouched = await fixture();
      await write(kind, scope, historicalTrust(kind, disposition));
      expect((await read(kind, scope)).sourceTrust).toEqual(quarantine);
      expect(isLowTrustQuarantined((await read(kind, scope)).sourceTrust)).toBe(true);
      if (kind === "document") {
        const saved = await documentService(db).getIssueDocumentByKey(scope.issueId, "report");
        expect(redactQuarantinedBodyForHigherTrust(saved!).body).toBe(LOW_TRUST_QUARANTINED_BODY);
      }
      expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
      expect(await taskForbidsProviderOutput(db, untouched)).toBe(false);
    });

    it.each(["invalid", { preset: "low_trust_review", disposition: "ordinary" },
      { preset: "standard", disposition: "promoted" }, { ...quarantine, sourceRunId: "invalid" }])(
      `${kind} rejects invalid trust before a valid-prefix write: %j`, async sourceTrust => {
        const scope = await fixture();
        const operation = kind === "document"
          ? documentService(db).createIssueDocumentsForImport([documentRow(scope, quarantine), { ...documentRow(scope, sourceTrust), key: "second" }])
          : workProductService(db).createManyForImport([productRow(scope, quarantine), productRow(scope, sourceTrust)]);
        await expect(operation).rejects.toMatchObject({ status: 422 });
        expect(await documentService(db).listIssueDocuments(scope.issueId)).toHaveLength(0);
        expect(await workProductService(db).listForIssue(scope.issueId, { refreshPullRequests: false })).toHaveLength(0);
        expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
      });

    it(`${kind} leaves unknown origin unclassified but denies provider output`, async () => {
      const scope = await fixture();
      await write(kind, scope, null);
      expect((await read(kind, scope)).sourceTrust).toBeNull();
      expect(await taskForbidsProviderOutput(db, scope)).toBe(true);
    });

    it(`${kind} rolls back trust and output denial with its caller`, async () => {
      const scope = await fixture();
      await expect(db.transaction(async tx => {
        await write(kind, scope, historicalTrust(kind, "promoted"), tx as unknown as typeof db);
        throw new Error("Synthetic caller rollback");
      })).rejects.toThrow("Synthetic caller rollback");
      expect(await documentService(db).listIssueDocuments(scope.issueId)).toHaveLength(0);
      expect(await workProductService(db).listForIssue(scope.issueId, { refreshPullRequests: false })).toHaveLength(0);
      expect(await taskForbidsProviderOutput(db, scope)).toBe(false);
    });

    it.each(["quarantined", "promoted"] as const)(`${kind} exports and parses %s history without importing a promotion`, async disposition => {
      const scope = await fixture();
      await write(kind, scope, null);
      const sourceTrust = historicalTrust(kind, disposition);
      if (kind === "document") {
        const [link] = await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, scope.issueId));
        await db.update(documents).set({ sourceTrust }).where(eq(documents.id, link.documentId));
      } else await db.update(issueWorkProducts).set({ sourceTrust }).where(eq(issueWorkProducts.issueId, scope.issueId));
      const service = companyPortabilityService(db);
      const exported = await service.exportBundle(scope.companyId, { include });
      const entry = kind === "document" ? exported.manifest.issues[0]!.documents![0]! : exported.manifest.issues[0]!.workProducts![0]!;
      expect(entry).toHaveProperty("sourceTrust", quarantine);
      expect((kind === "document" ? portabilityIssueDocumentManifestEntrySchema : portabilityIssueWorkProductManifestEntrySchema).parse(entry))
        .toHaveProperty("sourceTrust", quarantine);
      const extension = String(exported.files[".paperclip.yaml"]);
      for (const value of [sourceTrust.sourceIssueId, sourceTrust.sourceRunId, sourceTrust.sourceAgentId,
        sourceTrust.promotedFrom.artifactId, sourceTrust.promotedByActorId]) expect(extension).not.toContain(value);
      const preview = await service.previewImport({ source: { type: "inline", files: exported.files }, include, target: { mode: "new_company" } });
      const parsed = kind === "document" ? preview.manifest.issues[0]!.documents![0]! : preview.manifest.issues[0]!.workProducts![0]!;
      expect(parsed).toHaveProperty("sourceTrust", quarantine);
      expect(preview.errors).toContainEqual(expect.stringContaining("Task-content import is unavailable"));
      const destination = await fixture();
      await write(kind, destination, (parsed as { sourceTrust?: unknown }).sourceTrust);
      await db.delete(issues).where(eq(issues.id, scope.issueId));
      expect((await read(kind, destination)).sourceTrust).toEqual(quarantine);
      expect(await taskForbidsProviderOutput(db, destination)).toBe(true);
    });

    it(`${kind} normalizes caller-edited historical declarations while public apply remains held`, async () => {
      const scope = await fixture();
      await write(kind, scope, null);
      const service = companyPortabilityService(db);
      const exported = await service.exportBundle(scope.companyId, { include });
      const files = { ...exported.files }, extension = parse(String(files[".paperclip.yaml"]));
      const task = Object.values(extension.tasks as Record<string, Record<string, Array<Record<string, unknown>>>>)[0];
      task[kind === "document" ? "documents" : "workProducts"][0].sourceTrust = historicalTrust(kind, "promoted");
      files[".paperclip.yaml"] = stringify(extension);
      const input = { source: { type: "inline" as const, files }, include, target: { mode: "new_company" as const } };
      const preview = await service.previewImport(input);
      const entry = kind === "document" ? preview.manifest.issues[0]!.documents![0]! : preview.manifest.issues[0]!.workProducts![0]!;
      expect(entry).toHaveProperty("sourceTrust", quarantine);
      await expect(service.importBundle(input, "synthetic-board")).rejects.toMatchObject({ status: 422 });
    });
  }

  it.each(["same-company", "foreign-company"])("does not reuse %s execution/resource identities even when they exist", async ownership => {
    const scope = await fixture(), source = ownership === "same-company" ? scope : await fixture();
    const agentId = randomUUID(), runId = randomUUID(), workspaceId = randomUUID(), serviceId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: source.companyId, name: "Synthetic historical author", role: "engineer" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: source.companyId, agentId, issueId: source.issueId,
      invocationSource: "manual", status: "succeeded" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: source.companyId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Synthetic historical workspace" });
    await db.insert(workspaceRuntimeServices).values({ id: serviceId, companyId: source.companyId,
      executionWorkspaceId: workspaceId, issueId: source.issueId, scopeType: "issue", scopeId: source.issueId,
      serviceName: "Synthetic historical service", status: "stopped", lifecycle: "persistent", provider: "local" });
    await documentService(db).createIssueDocumentsForImport([{ ...documentRow(scope, quarantine), createdByRunId: runId }]);
    await workProductService(db).createManyForImport([{ ...productRow(scope, quarantine), createdByRunId: runId,
      executionWorkspaceId: workspaceId, runtimeServiceId: serviceId }]);
    const [link] = await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, scope.issueId));
    const [revision] = await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, link.documentId));
    expect(revision.createdByRunId).toBeNull();
    expect(await read("work_product", scope)).toMatchObject({ createdByRunId: null, executionWorkspaceId: null, runtimeServiceId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).toHaveLength(1);
    expect(await db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.id, serviceId))).toHaveLength(1);
  });

  it("does not bind imported documents to an alleged historical execution", async () => {
    const scope = await fixture();
    await documentService(db).createIssueDocumentsForImport([{ ...documentRow(scope, quarantine), createdByRunId: randomUUID() }]);
    const [link] = await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, scope.issueId));
    const [revision] = await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, link.documentId));
    expect(revision.createdByRunId).toBeNull();
  });

  it("does not bind imported work products to alleged runtime resources", async () => {
    const scope = await fixture();
    await workProductService(db).createManyForImport([{ ...productRow(scope, quarantine), createdByRunId: randomUUID(),
      executionWorkspaceId: randomUUID(), runtimeServiceId: randomUUID() }]);
    expect(await read("work_product", scope)).toMatchObject({ createdByRunId: null, executionWorkspaceId: null, runtimeServiceId: null });
  });
});
