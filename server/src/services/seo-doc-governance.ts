import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, documents, issueComments, issueDocuments, issues, seoDocRegistryEntries } from "@paperclipai/db";
import { asString, buildAgentMentionHref, isFrontmatterPlainRecord, parseFrontmatterMarkdown } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export type SeoDocCadence = "weekly" | "biweekly" | "monthly";
export type SeoDocStatus = "active" | "stale" | "deprecated";
export type SeoDocClass =
  | "strategy"
  | "implementation"
  | "runbook"
  | "incident"
  | "experimentation"
  | "architecture"
  | "governance";

export interface SeoDocDependencyRef {
  type: "issue_document" | "issue";
  target: string;
  role: "source_strategy" | "implementation_handoff" | "related";
}

export interface ParsedSeoDocGovernanceMeta {
  owner: string;
  lastUpdated: Date;
  updateCadence: SeoDocCadence;
  status: SeoDocStatus;
  dependencies: SeoDocDependencyRef[];
  documentClass: SeoDocClass;
  criticality: "normal" | "critical";
}

export interface SeoDocViolation {
  code:
    | "missing_frontmatter"
    | "missing_owner"
    | "missing_update_cadence"
    | "invalid_dependency_target"
    | "implementation_missing_source_strategy"
    | "strategy_missing_handoff_issue";
  docKey: string;
  message: string;
}

export interface SeoDocAuditResult {
  scanned: number;
  staleDocKeys: string[];
  escalatedDocKeys: string[];
  violations: SeoDocViolation[];
}

type SeoDocGovernanceWakeup = {
  source: "automation";
  triggerDetail: "system";
  reason: "issue_comment_mentioned";
  payload: {
    issueId: string;
    commentId: string;
  };
  requestedByActorType: "system";
  contextSnapshot: {
    issueId: string;
    taskId: string;
    commentId: string;
    wakeCommentId: string;
    wakeReason: "issue_comment_mentioned";
    source: "comment.mention";
    responsibleUserId?: string;
  };
};

type SeoDocGovernanceDeps = {
  enqueueWakeup?: (agentId: string, wakeup: SeoDocGovernanceWakeup) => Promise<unknown> | unknown;
};

type ValidationErrorCode = "missing_owner" | "missing_update_cadence" | "missing_frontmatter";

const CADENCE_TO_MS: Record<SeoDocCadence, number> = {
  weekly: 7 * 24 * 60 * 60 * 1_000,
  biweekly: 14 * 24 * 60 * 60 * 1_000,
  monthly: 31 * 24 * 60 * 60 * 1_000,
};

function normalizeIssueIdentifier(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeDocumentKey(key: string): string {
  return key.trim().toLowerCase();
}

function issuePathFromIdentifier(identifier: string): string {
  const normalized = normalizeIssueIdentifier(identifier);
  const prefix = normalized.split("-")[0] ?? normalized;
  return `/${prefix}/issues/${normalized}`;
}

function isCadence(value: string): value is SeoDocCadence {
  return value === "weekly" || value === "biweekly" || value === "monthly";
}

function isDocStatus(value: string): value is SeoDocStatus {
  return value === "active" || value === "stale" || value === "deprecated";
}

function isDocClass(value: string): value is SeoDocClass {
  return (
    value === "strategy" ||
    value === "implementation" ||
    value === "runbook" ||
    value === "incident" ||
    value === "experimentation" ||
    value === "architecture" ||
    value === "governance"
  );
}

function isDependencyType(value: string): value is SeoDocDependencyRef["type"] {
  return value === "issue_document" || value === "issue";
}

function isDependencyRole(value: string): value is SeoDocDependencyRef["role"] {
  return value === "source_strategy" || value === "implementation_handoff" || value === "related";
}

function parseGovernanceDate(value: string): Date | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function normalizeDependencies(value: unknown): SeoDocDependencyRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!isFrontmatterPlainRecord(entry)) return null;
      const type = asString(entry.type);
      const target = asString(entry.target);
      const role = asString(entry.role);
      if (!type || !target || !role) return null;
      if (!isDependencyType(type) || !isDependencyRole(role)) return null;
      return { type, target, role };
    })
    .filter((entry): entry is SeoDocDependencyRef => entry !== null);
}

function parseGovernanceRecord(body: string): Record<string, unknown> | null {
  const parsed = parseFrontmatterMarkdown(body);
  if (!parsed.hasFrontmatter) return null;
  const raw = parsed.frontmatter["seo_governance"];
  return isFrontmatterPlainRecord(raw) ? raw : null;
}

function isStale(entry: { updateCadence: SeoDocCadence; lastUpdated: Date }, now: Date): boolean {
  const thresholdMs = CADENCE_TO_MS[entry.updateCadence] + 60_000;
  return now.getTime() - entry.lastUpdated.getTime() > thresholdMs;
}

function escalationBody(docKey: string, cmoMention: string): string {
  return [
    "SEO governance escalation: critical document is stale.",
    "",
    `- Document: ${docKey}`,
    "- Action required: update governance metadata/body and refresh `last_updated`.",
    `- Escalation: ${cmoMention}`,
  ].join("\n");
}

function buildValidationError(code: ValidationErrorCode, docKey: string): Error & { details: unknown } {
  const field = code === "missing_owner"
    ? "seo_governance.owner"
    : code === "missing_update_cadence"
      ? "seo_governance.update_cadence"
      : "seo_governance";
  const message = code === "missing_owner"
    ? "owner is required"
    : code === "missing_update_cadence"
      ? "update_cadence is required"
      : "invalid or incomplete seo_governance frontmatter";
  const error = new Error(code) as Error & { details: unknown };
  error.details = {
    code,
    docKey,
    fields: [{ field, message }],
  };
  return error;
}

export function seoDocGovernanceService(db: Db, deps: SeoDocGovernanceDeps = {}) {
  const log = logger.child({ service: "seo-doc-governance" });

  async function findCompanyCmo(companyId: string) {
    return db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, "cmo")))
      .orderBy(asc(agents.createdAt), asc(agents.id))
      .then((rows) => rows[0] ?? null);
  }

  async function validateDependencies(docKey: string, dependencies: SeoDocDependencyRef[]): Promise<SeoDocViolation[]> {
    const violations: SeoDocViolation[] = [];

    for (const dep of dependencies) {
      if (dep.type === "issue") {
        const targetIdentifier = normalizeIssueIdentifier(dep.target);
        const targetIssue = await db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.identifier, targetIdentifier))
          .then((rows) => rows[0] ?? null);
        if (!targetIssue) {
          violations.push({
            code: "invalid_dependency_target",
            docKey,
            message: `Dependency target issue does not exist: ${dep.target}`,
          });
        }
        continue;
      }

      const match = dep.target.match(/^([A-Z]+-\d+)#document-([a-z0-9][a-z0-9\-_]*)$/i);
      if (!match) {
        violations.push({
          code: "invalid_dependency_target",
          docKey,
          message: `Dependency target is not a valid issue document reference: ${dep.target}`,
        });
        continue;
      }

      const issueIdentifier = normalizeIssueIdentifier(match[1] ?? "");
      const documentKey = normalizeDocumentKey(match[2] ?? "");
      const issueDocument = await db
        .select({ id: issueDocuments.id })
        .from(issueDocuments)
        .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
        .where(and(eq(issues.identifier, issueIdentifier), eq(issueDocuments.key, documentKey)))
        .then((rows) => rows[0] ?? null);
      if (!issueDocument) {
        violations.push({
          code: "invalid_dependency_target",
          docKey,
          message: `Dependency target issue document does not exist: ${dep.target}`,
        });
      }
    }

    return violations;
  }

  return {
    parseGovernanceFrontmatter(body: string): ParsedSeoDocGovernanceMeta | null {
      const record = parseGovernanceRecord(body);
      if (!record) return null;

      const owner = asString(record.owner);
      const updateCadence = asString(record.update_cadence);
      const lastUpdatedRaw = asString(record.last_updated);
      const status = asString(record.status);
      const documentClass = asString(record.document_class);
      const criticality = asString(record.criticality);

      if (!owner || !updateCadence || !lastUpdatedRaw || !status || !documentClass || !criticality) return null;
      if (!isCadence(updateCadence) || !isDocStatus(status) || !isDocClass(documentClass)) return null;
      if (criticality !== "normal" && criticality !== "critical") return null;
      const lastUpdated = parseGovernanceDate(lastUpdatedRaw);
      if (!lastUpdated) return null;

      return {
        owner,
        lastUpdated,
        updateCadence,
        status,
        dependencies: normalizeDependencies(record.dependencies),
        documentClass,
        criticality,
      };
    },

    buildDocKey(issueIdentifier: string, issueDocumentKey: string): string {
      return `${normalizeIssueIdentifier(issueIdentifier)}#document-${normalizeDocumentKey(issueDocumentKey)}`;
    },

    async syncRegistryEntryFromIssueDocument(input: {
      issueId: string;
      issueIdentifier: string;
      issueDocumentKey: string;
      title: string | null;
      body: string;
      now?: Date;
    }): Promise<void> {
      const record = parseGovernanceRecord(input.body);
      if (!record) return;

      const docKey = this.buildDocKey(input.issueIdentifier, input.issueDocumentKey);
      if (!asString(record.owner)) throw buildValidationError("missing_owner", docKey);
      if (!asString(record.update_cadence)) throw buildValidationError("missing_update_cadence", docKey);

      const parsed = this.parseGovernanceFrontmatter(input.body);
      if (!parsed) throw buildValidationError("missing_frontmatter", docKey);

      const issueRow = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issueRow) return;

      const now = input.now ?? new Date();
      const issueLink = issuePathFromIdentifier(input.issueIdentifier);
      const existing = await db
        .select({ id: seoDocRegistryEntries.id, lastUpdated: seoDocRegistryEntries.lastUpdated })
        .from(seoDocRegistryEntries)
        .where(and(eq(seoDocRegistryEntries.companyId, issueRow.companyId), eq(seoDocRegistryEntries.docKey, docKey)))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        const shouldResetEscalation = parsed.lastUpdated.getTime() > existing.lastUpdated.getTime();
        await db
          .update(seoDocRegistryEntries)
          .set({
            issueId: input.issueId,
            issueDocumentKey: normalizeDocumentKey(input.issueDocumentKey),
            title: input.title ?? docKey,
            issueLink,
            owner: parsed.owner,
            lastUpdated: parsed.lastUpdated,
            updateCadence: parsed.updateCadence,
            status: parsed.status,
            dependencies: parsed.dependencies,
            documentClass: parsed.documentClass,
            criticality: parsed.criticality,
            ...(shouldResetEscalation ? { lastEscalatedAt: null } : {}),
            updatedAt: now,
          })
          .where(eq(seoDocRegistryEntries.id, existing.id));
        return;
      }

      await db.insert(seoDocRegistryEntries).values({
        companyId: issueRow.companyId,
        docKey,
        issueId: input.issueId,
        issueDocumentKey: normalizeDocumentKey(input.issueDocumentKey),
        title: input.title ?? docKey,
        issueLink,
        owner: parsed.owner,
        lastUpdated: parsed.lastUpdated,
        updateCadence: parsed.updateCadence,
        status: parsed.status,
        dependencies: parsed.dependencies,
        documentClass: parsed.documentClass,
        criticality: parsed.criticality,
        lastAuditedAt: null,
        lastEscalatedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    },

    async validateRegistryEntry(docKey: string): Promise<SeoDocViolation[]> {
      const entry = await db
        .select()
        .from(seoDocRegistryEntries)
        .where(eq(seoDocRegistryEntries.docKey, docKey))
        .then((rows) => rows[0] ?? null);
      if (!entry) return [];

      const violations: SeoDocViolation[] = [];
      const linkedDocument = await db
        .select({ body: documents.latestBody, format: documents.format })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(and(eq(issueDocuments.issueId, entry.issueId), eq(issueDocuments.key, entry.issueDocumentKey)))
        .then((rows) => rows[0] ?? null);

      if (!linkedDocument || linkedDocument.format !== "markdown" || !parseGovernanceRecord(linkedDocument.body)) {
        violations.push({
          code: "missing_frontmatter",
          docKey,
          message: "Governed document is missing seo_governance frontmatter",
        });
      }

      const dependencies = (entry.dependencies ?? []) as SeoDocDependencyRef[];
      violations.push(...(await validateDependencies(docKey, dependencies)));

      if (entry.documentClass === "implementation" && !dependencies.some((dep) => dep.role === "source_strategy")) {
        violations.push({
          code: "implementation_missing_source_strategy",
          docKey,
          message: "Implementation document must include a source_strategy dependency",
        });
      }

      if (entry.documentClass === "strategy" && !dependencies.some((dep) => dep.role === "implementation_handoff")) {
        violations.push({
          code: "strategy_missing_handoff_issue",
          docKey,
          message: "Strategy document must include an implementation_handoff dependency",
        });
      }

      return violations;
    },

    async auditCompany(companyId: string, now?: Date): Promise<SeoDocAuditResult> {
      const auditNow = now ?? new Date();
      const rows = await db
        .select()
        .from(seoDocRegistryEntries)
        .where(eq(seoDocRegistryEntries.companyId, companyId));

      const result: SeoDocAuditResult = {
        scanned: rows.length,
        staleDocKeys: [],
        escalatedDocKeys: [],
        violations: [],
      };

      for (const row of rows) {
        const nextStatus: SeoDocStatus = row.status === "deprecated"
          ? "deprecated"
          : isStale({ updateCadence: row.updateCadence as SeoDocCadence, lastUpdated: row.lastUpdated }, auditNow)
            ? "stale"
            : "active";

        result.violations.push(...(await this.validateRegistryEntry(row.docKey)));
        if (nextStatus === "stale") result.staleDocKeys.push(row.docKey);

        await db
          .update(seoDocRegistryEntries)
          .set({
            status: nextStatus,
            lastAuditedAt: auditNow,
            updatedAt: auditNow,
          })
          .where(eq(seoDocRegistryEntries.id, row.id));

        const shouldEscalate =
          nextStatus === "stale" &&
          row.criticality === "critical" &&
          row.status !== "deprecated" &&
          (!row.lastEscalatedAt || row.lastEscalatedAt.getTime() < row.lastUpdated.getTime());

        if (!shouldEscalate) continue;

        try {
          const cmoAgent = await findCompanyCmo(companyId);
          if (!cmoAgent) {
            log.warn({ companyId, docKey: row.docKey }, "failed to emit seo governance escalation comment: no CMO agent found");
            continue;
          }

          const [comment] = await db.insert(issueComments).values({
            companyId,
            issueId: row.issueId,
            authorType: "system",
            body: escalationBody(row.docKey, `[@CMO](${buildAgentMentionHref(cmoAgent.id)})`),
          }).returning({ id: issueComments.id });
          await db.update(issues).set({ updatedAt: auditNow }).where(eq(issues.id, row.issueId));
          await db
            .update(seoDocRegistryEntries)
            .set({
              lastEscalatedAt: auditNow,
              updatedAt: auditNow,
            })
            .where(eq(seoDocRegistryEntries.id, row.id));
          result.escalatedDocKeys.push(row.docKey);
          if (deps.enqueueWakeup) {
            try {
              const issueOwner = await db
                .select({
                  responsibleUserId: issues.responsibleUserId,
                  createdByUserId: issues.createdByUserId,
                })
                .from(issues)
                .where(eq(issues.id, row.issueId))
                .then((issueRows) => issueRows[0] ?? null);
              const responsibleUserId = issueOwner?.responsibleUserId ?? issueOwner?.createdByUserId ?? undefined;
              await deps.enqueueWakeup(cmoAgent.id, {
                source: "automation",
                triggerDetail: "system",
                reason: "issue_comment_mentioned",
                payload: {
                  issueId: row.issueId,
                  commentId: comment.id,
                },
                requestedByActorType: "system",
                contextSnapshot: {
                  issueId: row.issueId,
                  taskId: row.issueId,
                  commentId: comment.id,
                  wakeCommentId: comment.id,
                  wakeReason: "issue_comment_mentioned",
                  source: "comment.mention",
                  ...(responsibleUserId ? { responsibleUserId } : {}),
                },
              });
            } catch (error) {
              log.warn(
                { err: error, docKey: row.docKey, issueId: row.issueId },
                "failed to enqueue seo governance escalation wakeup",
              );
            }
          }
        } catch (error) {
          log.warn({ err: error, docKey: row.docKey }, "failed to emit seo governance escalation comment");
        }
      }

      return result;
    },

    async seedFromIssueIdentifiers(companyId: string, identifiers: string[]): Promise<{ synced: number }> {
      let synced = 0;

      for (const rawIdentifier of identifiers) {
        const identifier = normalizeIssueIdentifier(rawIdentifier);
        const issue = await db
          .select({ id: issues.id, identifier: issues.identifier })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.identifier, identifier)))
          .then((rows) => rows[0] ?? null);
        if (!issue) continue;

        const docs = await db
          .select({
            key: issueDocuments.key,
            title: documents.title,
            body: documents.latestBody,
            format: documents.format,
          })
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(eq(issueDocuments.issueId, issue.id));

        for (const doc of docs) {
          if (doc.format !== "markdown") continue;
          const docKey = this.buildDocKey(identifier, doc.key);
          const before = await db
            .select({ id: seoDocRegistryEntries.id })
            .from(seoDocRegistryEntries)
            .where(and(eq(seoDocRegistryEntries.companyId, companyId), eq(seoDocRegistryEntries.docKey, docKey)))
            .then((rows) => rows[0] ?? null);

          try {
            await this.syncRegistryEntryFromIssueDocument({
              issueId: issue.id,
              issueIdentifier: issue.identifier ?? identifier,
              issueDocumentKey: doc.key,
              title: doc.title,
              body: doc.body,
            });
          } catch {
            continue;
          }

          const after = await db
            .select({ id: seoDocRegistryEntries.id })
            .from(seoDocRegistryEntries)
            .where(and(eq(seoDocRegistryEntries.companyId, companyId), eq(seoDocRegistryEntries.docKey, docKey)))
            .then((rows) => rows[0] ?? null);

          if (!before && after) synced += 1;
        }
      }

      return { synced };
    },
  };
}
