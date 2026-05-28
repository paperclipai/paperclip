import { and, desc, eq, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  consultReportArtifacts,
  documents,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import type { CreateConsultReportArtifact } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

type IssueSnapshot = Pick<typeof issues.$inferSelect, "id" | "companyId" | "parentId">;

type CreateArtifactInput = CreateConsultReportArtifact & {
  sourceIssue: IssueSnapshot;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
};

const sourceIssues = alias(issues, "consult_report_source_issue");
const accountableIssues = alias(issues, "consult_report_accountable_issue");
const nextOwnerIssues = alias(issues, "consult_report_next_owner_issue");
const nextOwnerAgents = alias(agents, "consult_report_next_owner_agent");

const artifactSelect = {
  id: consultReportArtifacts.id,
  companyId: consultReportArtifacts.companyId,
  sourceIssueId: consultReportArtifacts.sourceIssueId,
  accountableIssueId: consultReportArtifacts.accountableIssueId,
  sourceType: consultReportArtifacts.sourceType,
  sourceCommentId: consultReportArtifacts.sourceCommentId,
  sourceDocumentId: consultReportArtifacts.sourceDocumentId,
  sourceDocumentKey: consultReportArtifacts.sourceDocumentKey,
  decision: consultReportArtifacts.decision,
  evidence: consultReportArtifacts.evidence,
  risk: consultReportArtifacts.risk,
  nextOwnerText: consultReportArtifacts.nextOwnerText,
  nextOwnerAgentId: consultReportArtifacts.nextOwnerAgentId,
  nextOwnerUserId: consultReportArtifacts.nextOwnerUserId,
  nextOwnerIssueId: consultReportArtifacts.nextOwnerIssueId,
  reportNeeded: consultReportArtifacts.reportNeeded,
  reportReason: consultReportArtifacts.reportReason,
  createdByAgentId: consultReportArtifacts.createdByAgentId,
  createdByUserId: consultReportArtifacts.createdByUserId,
  createdAt: consultReportArtifacts.createdAt,
  updatedAt: consultReportArtifacts.updatedAt,
  sourceIssueIdentifier: sourceIssues.identifier,
  sourceIssueTitle: sourceIssues.title,
  sourceIssueStatus: sourceIssues.status,
  accountableIssueIdentifier: accountableIssues.identifier,
  accountableIssueTitle: accountableIssues.title,
  accountableIssueStatus: accountableIssues.status,
  nextOwnerIssueIdentifier: nextOwnerIssues.identifier,
  nextOwnerIssueTitle: nextOwnerIssues.title,
  nextOwnerIssueStatus: nextOwnerIssues.status,
  nextOwnerAgentName: nextOwnerAgents.name,
};

function issueSummary(row: {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
}) {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
  };
}

type ArtifactSelectRow = {
  id: string;
  companyId: string;
  sourceIssueId: string;
  accountableIssueId: string;
  sourceType: string;
  sourceCommentId: string | null;
  sourceDocumentId: string | null;
  sourceDocumentKey: string | null;
  decision: string;
  evidence: string;
  risk: string;
  nextOwnerText: string;
  nextOwnerAgentId: string | null;
  nextOwnerUserId: string | null;
  nextOwnerIssueId: string | null;
  reportNeeded: boolean;
  reportReason: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  sourceIssueIdentifier: string | null;
  sourceIssueTitle: string;
  sourceIssueStatus: string;
  accountableIssueIdentifier: string | null;
  accountableIssueTitle: string;
  accountableIssueStatus: string;
  nextOwnerIssueIdentifier: string | null;
  nextOwnerIssueTitle: string | null;
  nextOwnerIssueStatus: string | null;
  nextOwnerAgentName: string | null;
};

function mapArtifactRow(row: ArtifactSelectRow) {
  const nextOwnerIssue = row.nextOwnerIssueId && row.nextOwnerIssueTitle && row.nextOwnerIssueStatus
    ? issueSummary({
        id: row.nextOwnerIssueId,
        identifier: row.nextOwnerIssueIdentifier,
        title: row.nextOwnerIssueTitle,
        status: row.nextOwnerIssueStatus,
      })
    : null;

  return {
    id: row.id,
    companyId: row.companyId,
    sourceType: row.sourceType,
    sourceIssueId: row.sourceIssueId,
    accountableIssueId: row.accountableIssueId,
    sourceCommentId: row.sourceCommentId,
    sourceDocumentId: row.sourceDocumentId,
    sourceDocumentKey: row.sourceDocumentKey,
    decision: row.decision,
    evidence: row.evidence,
    risk: row.risk,
    nextOwnerText: row.nextOwnerText,
    nextOwnerAgentId: row.nextOwnerAgentId,
    nextOwnerUserId: row.nextOwnerUserId,
    nextOwnerIssueId: row.nextOwnerIssueId,
    reportNeeded: row.reportNeeded,
    reportReason: row.reportReason,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: {
      type: row.sourceType,
      issue: issueSummary({
        id: row.sourceIssueId,
        identifier: row.sourceIssueIdentifier,
        title: row.sourceIssueTitle,
        status: row.sourceIssueStatus,
      }),
      commentId: row.sourceCommentId,
      document: row.sourceDocumentId || row.sourceDocumentKey
        ? {
            id: row.sourceDocumentId,
            key: row.sourceDocumentKey,
          }
        : null,
    },
    accountableIssue: issueSummary({
      id: row.accountableIssueId,
      identifier: row.accountableIssueIdentifier,
      title: row.accountableIssueTitle,
      status: row.accountableIssueStatus,
    }),
    nextOwner: {
      text: row.nextOwnerText,
      agent: row.nextOwnerAgentId
        ? {
            id: row.nextOwnerAgentId,
            name: row.nextOwnerAgentName,
          }
        : null,
      userId: row.nextOwnerUserId,
      issue: nextOwnerIssue,
    },
  };
}

type ArtifactReadModel = ReturnType<typeof mapArtifactRow>;

async function assertIssueInCompany(
  db: Db,
  issueId: string,
  companyId: string,
  label: string,
) {
  const issue = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      parentId: issues.parentId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);

  if (!issue) throw unprocessable(`${label} issue not found`);
  if (issue.companyId !== companyId) throw unprocessable(`${label} issue must belong to the same company`);
  return issue;
}

async function assertNextOwnerLinksInCompany(
  db: Db,
  input: Pick<CreateArtifactInput, "nextOwnerAgentId" | "nextOwnerIssueId" | "nextOwnerUserId">,
  companyId: string,
) {
  if (input.nextOwnerAgentId) {
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.nextOwnerAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw unprocessable("nextOwnerAgentId must belong to the same company");
  }

  if (input.nextOwnerIssueId) {
    await assertIssueInCompany(db, input.nextOwnerIssueId, companyId, "nextOwner");
  }

  if (input.nextOwnerUserId) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.nextOwnerUserId),
        eq(companyMemberships.status, "active"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!membership) throw unprocessable("nextOwnerUserId must have active membership in the same company");
  }
}

async function resolveSourceLink(db: Db, input: CreateArtifactInput) {
  const companyId = input.sourceIssue.companyId;
  if (input.sourceType === "issue") {
    return {
      sourceCommentId: null,
      sourceDocumentId: null,
      sourceDocumentKey: null,
    };
  }

  if (input.sourceType === "comment") {
    const comment = await db
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        companyId: issueComments.companyId,
      })
      .from(issueComments)
      .where(eq(issueComments.id, input.sourceCommentId ?? ""))
      .then((rows) => rows[0] ?? null);

    if (!comment || comment.companyId !== companyId || comment.issueId !== input.sourceIssue.id) {
      throw unprocessable("Source comment must belong to the source issue and company");
    }

    return {
      sourceCommentId: comment.id,
      sourceDocumentId: null,
      sourceDocumentKey: null,
    };
  }

  const conditions = [
    eq(issueDocuments.companyId, companyId),
    eq(issueDocuments.issueId, input.sourceIssue.id),
  ];
  if (input.sourceDocumentId) {
    conditions.push(eq(issueDocuments.documentId, input.sourceDocumentId));
  }
  if (input.sourceDocumentKey) {
    conditions.push(eq(issueDocuments.key, input.sourceDocumentKey));
  }

  const document = await db
    .select({
      id: documents.id,
      companyId: documents.companyId,
      key: issueDocuments.key,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(...conditions))
    .then((rows) => rows[0] ?? null);

  if (!document || document.companyId !== companyId) {
    throw unprocessable("Source document must belong to the source issue and company");
  }

  return {
    sourceCommentId: null,
    sourceDocumentId: document.id,
    sourceDocumentKey: document.key,
  };
}

export function consultReportArtifactService(db: Db) {
  async function getById(id: string) {
    const row = await db
      .select(artifactSelect)
      .from(consultReportArtifacts)
      .innerJoin(sourceIssues, eq(consultReportArtifacts.sourceIssueId, sourceIssues.id))
      .innerJoin(accountableIssues, eq(consultReportArtifacts.accountableIssueId, accountableIssues.id))
      .leftJoin(nextOwnerIssues, eq(consultReportArtifacts.nextOwnerIssueId, nextOwnerIssues.id))
      .leftJoin(nextOwnerAgents, eq(consultReportArtifacts.nextOwnerAgentId, nextOwnerAgents.id))
      .where(eq(consultReportArtifacts.id, id))
      .then((rows) => rows[0] ?? null);

    return row ? mapArtifactRow(row) : null;
  }

  return {
    getById,

    create: async (input: CreateArtifactInput) => {
      const companyId = input.sourceIssue.companyId;
      const sourceIssue = await assertIssueInCompany(db, input.sourceIssue.id, companyId, "Source");
      const accountableIssueId = input.accountableIssueId ?? sourceIssue.parentId ?? sourceIssue.id;
      await assertIssueInCompany(db, accountableIssueId, companyId, "Accountable");
      await assertNextOwnerLinksInCompany(db, input, companyId);
      const sourceLink = await resolveSourceLink(db, input);

      const [inserted] = await db
        .insert(consultReportArtifacts)
        .values({
          companyId,
          sourceIssueId: sourceIssue.id,
          accountableIssueId,
          sourceType: input.sourceType,
          ...sourceLink,
          decision: input.decision,
          evidence: input.evidence,
          risk: input.risk,
          nextOwnerText: input.nextOwnerText,
          nextOwnerAgentId: input.nextOwnerAgentId ?? null,
          nextOwnerUserId: input.nextOwnerUserId ?? null,
          nextOwnerIssueId: input.nextOwnerIssueId ?? null,
          reportNeeded: input.reportNeeded,
          reportReason: input.reportReason ?? null,
          createdByAgentId: input.createdByAgentId ?? null,
          createdByUserId: input.createdByUserId ?? null,
        })
        .returning({ id: consultReportArtifacts.id });

      if (!inserted) throw notFound("Consult report artifact not found after creation");
      const artifact = await getById(inserted.id);
      if (!artifact) throw notFound("Consult report artifact not found after creation");
      return artifact;
    },

    listForIssue: async (issueId: string, companyId: string): Promise<ArtifactReadModel[]> => {
      const rows = await db
        .select(artifactSelect)
        .from(consultReportArtifacts)
        .innerJoin(sourceIssues, eq(consultReportArtifacts.sourceIssueId, sourceIssues.id))
        .innerJoin(accountableIssues, eq(consultReportArtifacts.accountableIssueId, accountableIssues.id))
        .leftJoin(nextOwnerIssues, eq(consultReportArtifacts.nextOwnerIssueId, nextOwnerIssues.id))
        .leftJoin(nextOwnerAgents, eq(consultReportArtifacts.nextOwnerAgentId, nextOwnerAgents.id))
        .where(and(
          eq(consultReportArtifacts.companyId, companyId),
          or(
            eq(consultReportArtifacts.sourceIssueId, issueId),
            eq(consultReportArtifacts.accountableIssueId, issueId),
          ),
        ))
        .orderBy(desc(consultReportArtifacts.createdAt));

      return rows.map((row) => mapArtifactRow(row));
    },

    listReportNeeded: async (companyId: string): Promise<ArtifactReadModel[]> => {
      const rows = await db
        .select(artifactSelect)
        .from(consultReportArtifacts)
        .innerJoin(sourceIssues, eq(consultReportArtifacts.sourceIssueId, sourceIssues.id))
        .innerJoin(accountableIssues, eq(consultReportArtifacts.accountableIssueId, accountableIssues.id))
        .leftJoin(nextOwnerIssues, eq(consultReportArtifacts.nextOwnerIssueId, nextOwnerIssues.id))
        .leftJoin(nextOwnerAgents, eq(consultReportArtifacts.nextOwnerAgentId, nextOwnerAgents.id))
        .where(and(
          eq(consultReportArtifacts.companyId, companyId),
          eq(consultReportArtifacts.reportNeeded, true),
        ))
        .orderBy(desc(consultReportArtifacts.createdAt));

      return rows.map((row) => mapArtifactRow(row));
    },
  };
}
