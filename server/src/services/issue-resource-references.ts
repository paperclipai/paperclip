import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueDocuments, issueWorkProducts, issues } from "@paperclipai/db";
import {
  extractIssueResourceLinks,
  type ExtractedIssueResourceLink,
  type IssueResourceReference,
  type IssueWorkProductReviewState,
} from "@paperclipai/shared";

type IssueRow = {
  id: string;
  identifier: string | null;
  title: string;
};

export function issueResourceReferenceService(db: Db) {
  async function resolveIssuePathIds(
    companyId: string,
    issuePathIds: readonly string[],
  ) {
    const normalized = [...new Set(issuePathIds.map((value) => value.trim()).filter(Boolean))];
    if (normalized.length === 0) return new Map<string, IssueRow>();

    const uuidLikeIds = normalized.filter((value) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value));
    const identifiers = normalized.filter((value) => !uuidLikeIds.includes(value));
    const identifierCondition = identifiers.length > 0 ? inArray(issues.identifier, identifiers) : null;
    const uuidCondition = uuidLikeIds.length > 0 ? inArray(issues.id, uuidLikeIds) : null;
    const pathCondition = identifierCondition && uuidCondition
      ? or(identifierCondition, uuidCondition)
      : identifierCondition ?? uuidCondition;
    if (!pathCondition) return new Map<string, IssueRow>();
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), pathCondition));

    const byPathId = new Map<string, IssueRow>();
    for (const row of rows) {
      byPathId.set(row.id, row);
      if (row.identifier) byPathId.set(row.identifier, row);
    }
    return byPathId;
  }

  async function resolveForText(input: {
    companyId: string;
    text: string | null | undefined;
    fallbackIssuePathId?: string | null;
  }): Promise<IssueResourceReference[]> {
    const [resolved] = await resolveForTexts([input]);
    return resolved ?? [];
  }

  async function resolveForTexts(inputs: Array<{
    companyId: string;
    text: string | null | undefined;
    fallbackIssuePathId?: string | null;
  }>): Promise<IssueResourceReference[][]> {
    const extractedPerInput = inputs.map((input) => extractIssueResourceLinks(input.text, {
      fallbackIssuePathId: input.fallbackIssuePathId ?? null,
    }));
    const companyId = inputs[0]?.companyId ?? null;
    if (!companyId || extractedPerInput.every((items) => items.length === 0)) {
      return inputs.map(() => []);
    }
    const extracted = extractedPerInput.flat();
    const issueByPathId = await resolveIssuePathIds(
      companyId,
      extracted.map((item) => item.issuePathId).filter((value): value is string => Boolean(value)),
    );
    const targetIssueIds = [...new Set(
      extracted
        .map((item) => issueByPathId.get(item.issuePathId ?? "")?.id ?? null)
        .filter((value): value is string => Boolean(value)),
    )];
    if (targetIssueIds.length === 0) return inputs.map(() => []);

    const documentRows = await db
      .select({
        issueId: issueDocuments.issueId,
        documentKey: issueDocuments.key,
        documentTitle: documents.title,
        latestRevisionNumber: documents.latestRevisionNumber,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(inArray(issueDocuments.issueId, targetIssueIds));
    const workProductRows = await db
      .select({
        id: issueWorkProducts.id,
        issueId: issueWorkProducts.issueId,
        title: issueWorkProducts.title,
        type: issueWorkProducts.type,
        status: issueWorkProducts.status,
        reviewState: issueWorkProducts.reviewState,
      })
      .from(issueWorkProducts)
      .where(inArray(issueWorkProducts.issueId, targetIssueIds));

    const documentMap = new Map<string, (typeof documentRows)[number]>();
    for (const row of documentRows) {
      documentMap.set(`${row.issueId}:${row.documentKey}`, row);
    }
    const workProductMap = new Map<string, (typeof workProductRows)[number]>();
    for (const row of workProductRows) {
      workProductMap.set(`${row.issueId}:${row.id}`, row);
    }

    const resolveOne = (items: ExtractedIssueResourceLink[]) => {
      const resolved: IssueResourceReference[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        const issue = item.issuePathId ? issueByPathId.get(item.issuePathId) ?? null : null;
        if (!issue) continue;
        if (item.target.kind === "issue_document") {
          const document = documentMap.get(`${issue.id}:${item.target.documentKey}`);
          if (!document) continue;
          const dedupeKey = `doc:${issue.id}:${document.documentKey}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          resolved.push({
            kind: "issue_document",
            href: item.href,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            documentKey: document.documentKey,
            documentTitle: document.documentTitle ?? null,
            latestRevisionNumber: document.latestRevisionNumber ?? null,
          });
          continue;
        }
        const workProduct = workProductMap.get(`${issue.id}:${item.target.workProductId}`);
        if (!workProduct) continue;
        const dedupeKey = `wp:${issue.id}:${workProduct.id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        resolved.push({
          kind: "work_product",
          href: item.href,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          issueTitle: issue.title,
          workProductId: workProduct.id,
          workProductTitle: workProduct.title,
          workProductType: workProduct.type,
          workProductStatus: workProduct.status,
          reviewState: workProduct.reviewState as IssueWorkProductReviewState,
        });
      }
      return orderLikeExtraction(items, resolved, issueByPathId);
    };

    return extractedPerInput.map(resolveOne);
  }

  function orderLikeExtraction(
    extracted: ExtractedIssueResourceLink[],
    resolved: IssueResourceReference[],
    issueByPathId: Map<string, IssueRow>,
  ) {
    const rank = new Map<string, number>();
    extracted.forEach((item, index) => {
      const issue = item.issuePathId ? issueByPathId.get(item.issuePathId) ?? null : null;
      if (!issue) return;
      if (item.target.kind === "issue_document") {
        const key = `doc:${issue.id}:${item.target.documentKey}`;
        if (!rank.has(key)) rank.set(key, index);
        return;
      }
      const key = `wp:${issue.id}:${item.target.workProductId}`;
      if (!rank.has(key)) rank.set(key, index);
    });
    return [...resolved].sort((left, right) => {
      const leftKey = left.kind === "issue_document"
        ? `doc:${left.issueId}:${left.documentKey}`
        : `wp:${left.issueId}:${left.workProductId}`;
      const rightKey = right.kind === "issue_document"
        ? `doc:${right.issueId}:${right.documentKey}`
        : `wp:${right.issueId}:${right.workProductId}`;
      return (rank.get(leftKey) ?? Number.MAX_SAFE_INTEGER) - (rank.get(rightKey) ?? Number.MAX_SAFE_INTEGER);
    });
  }

  return {
    resolveForText,
    resolveForTexts,
  };
}
