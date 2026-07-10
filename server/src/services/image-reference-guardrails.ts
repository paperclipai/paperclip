import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  assets,
  issueAttachments,
  issueComments,
  issues,
} from "@paperclipai/db";

const MAX_ISSUE_ANCESTOR_DEPTH = 10;
const IMAGE_SOURCE_PATH_RE = /\/api\/(attachments|assets)\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/content\b/gi;

export type IssueImageReferenceGuardrail = {
  required: boolean;
  issueScopeIds: string[];
  boardText: string;
  candidateAttachmentIds: string[];
  candidateAssetIds: string[];
};

function uniqueInOrder(values: Iterable<string>) {
  return Array.from(new Set(values));
}

export function extractImageSourceIds(text: string) {
  const attachmentIds: string[] = [];
  const assetIds: string[] = [];
  for (const match of text.matchAll(IMAGE_SOURCE_PATH_RE)) {
    const kind = match[1]?.toLowerCase();
    const id = match[2]?.toLowerCase();
    if (!id) continue;
    if (kind === "attachments") attachmentIds.push(id);
    if (kind === "assets") assetIds.push(id);
  }
  return {
    attachmentIds: uniqueInOrder(attachmentIds),
    assetIds: uniqueInOrder(assetIds),
  };
}

export function textRequiresActualImageReference(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;

  const hasImageTask =
    /\b(?:gpt[- ]?image|imagegen|image generation|image model|generate|regenerate|recreate|edit|modify|transform|replace|correct|fix|remake)\b.{0,140}\b(?:image|photo|portrait|picture|creative|graphic|post|face|character)\b/i.test(normalized) ||
    /\b(?:image|photo|portrait|picture|creative|graphic|post|face|character)\b.{0,140}\b(?:generate|regenerate|recreate|edit|modify|transform|replace|correct|fix|remake|model)\b/i.test(normalized);
  const hasReferenceRequirement =
    /\b(?:actual|visual|image)\s+(?:input|reference)\b/i.test(normalized) ||
    /\b(?:reference|attachment)\b.{0,120}\b(?:image|photo|portrait|picture|face|character|model|input)\b/i.test(normalized) ||
    /\b(?:use|using|include|pass|provide|give)\b.{0,120}\b(?:attachment|image|photo|portrait|picture)\b.{0,120}\b(?:reference|input|model|gpt[- ]?image|imagegen)\b/i.test(normalized) ||
    /\b(?:do not|don't|dont|not)\b.{0,100}\b(?:prompt[- ]?only|text[- ]?only|pure text|text[- ]?to[- ]?image|extract(?:ing)? (?:it )?(?:as|into) (?:a )?prompt)\b/i.test(normalized);

  return hasImageTask && hasReferenceRequirement;
}

export async function resolveIssueImageReferenceGuardrail(
  db: Db,
  input: { issueId: string; companyId: string },
): Promise<IssueImageReferenceGuardrail> {
  type IssueScopeRow = {
    id: string;
    parentId: string | null;
    title: string;
    description: string | null;
    createdByUserId: string | null;
  };
  const issueScope: IssueScopeRow[] = [];
  let currentIssueId: string | null = input.issueId;

  for (let depth = 0; currentIssueId && depth < MAX_ISSUE_ANCESTOR_DEPTH; depth += 1) {
    const row: IssueScopeRow | null = await db
      .select({
        id: issues.id,
        parentId: issues.parentId,
        title: issues.title,
        description: issues.description,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(eq(issues.id, currentIssueId), eq(issues.companyId, input.companyId)))
      .then((resultRows) => resultRows[0] ?? null);
    if (!row || issueScope.some((entry) => entry.id === row.id)) break;
    issueScope.push(row);
    currentIssueId = row.parentId;
  }

  const issueScopeIds = issueScope.map((issue) => issue.id);
  if (issueScopeIds.length === 0) {
    return {
      required: false,
      issueScopeIds: [],
      boardText: "",
      candidateAttachmentIds: [],
      candidateAssetIds: [],
    };
  }

  const userComments = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, input.companyId),
      inArray(issueComments.issueId, issueScopeIds),
      isNotNull(issueComments.authorUserId),
    ))
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id));

  const boardTextParts = [
    ...issueScope
      .filter((issue) => Boolean(issue.createdByUserId))
      .flatMap((issue) => [issue.title, issue.description ?? ""]),
    ...userComments.map((comment) => comment.body),
  ].filter((part) => part.trim().length > 0);
  const boardText = boardTextParts.join("\n\n");
  const linkedSources = extractImageSourceIds(boardText);
  const required = textRequiresActualImageReference(boardText);
  const boardAttachmentCondition = linkedSources.attachmentIds.length > 0
    ? or(
        isNotNull(assets.createdByUserId),
        inArray(issueAttachments.id, linkedSources.attachmentIds),
      )
    : isNotNull(assets.createdByUserId);

  const imageAttachmentRows = required
    ? await db
        .select({
          id: issueAttachments.id,
          issueId: issueAttachments.issueId,
          createdAt: issueAttachments.createdAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(and(
          eq(issueAttachments.companyId, input.companyId),
          inArray(issueAttachments.issueId, issueScopeIds),
          sql`lower(${assets.contentType}) like 'image/%'`,
          boardAttachmentCondition,
        ))
        .orderBy(
          sql`case when ${issueAttachments.issueId} = ${input.issueId} then 0 else 1 end`,
          asc(issueAttachments.createdAt),
          asc(issueAttachments.id),
        )
    : [];

  return {
    required,
    issueScopeIds,
    boardText,
    candidateAttachmentIds: uniqueInOrder([
      ...linkedSources.attachmentIds,
      ...imageAttachmentRows.map((attachment) => attachment.id),
    ]),
    candidateAssetIds: linkedSources.assetIds,
  };
}

export async function hasReferenceBackedImageGenerationEvidence(
  db: Db,
  input: { issueId: string; companyId: string },
) {
  const childIds = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.parentId, input.issueId)))
    .then((rows) => rows.map((row) => row.id));
  const evidenceIssueIds = [input.issueId, ...childIds];
  const evidence = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.action, "issue.image_generation_created"),
      eq(activityLog.entityType, "issue"),
      inArray(activityLog.entityId, evidenceIssueIds),
      sql`${activityLog.details} ->> 'generationMode' = 'reference_backed'`,
      sql`jsonb_array_length(coalesce(${activityLog.details} -> 'actualImageInputsBound', '[]'::jsonb)) > 0`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(evidence);
}
