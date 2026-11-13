import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { assets, companies, completionContracts, documents, documentRevisions, heartbeatRuns, issueDocuments, issueAttachments, issues, issueThreadInteractions, issueWorkProducts, mcpAttachmentUploads, dotRunnerAssignments, type Db } from "@paperclipai/db";
import { projectHumanInteractionResponse } from "../execution-continuation.js";

export class NativeDeliverableEvidenceError extends Error {}

function evidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" && typeof entry.ref === "string") return [entry.ref];
    return [];
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

type NativePublicationEvidence = {
  disposition: unknown;
  artifacts: string[];
  refs: string[];
};

function publicationEvidence(value: unknown): NativePublicationEvidence {
  const result = record(value);
  const artifacts = evidenceRefs(result.artifacts);
  const criteria = record(result.completionClaim).criteria;
  return { disposition: result.reportedWorkDisposition, artifacts,
    refs: [...evidenceRefs(result.evidence), ...artifacts,
      ...(Array.isArray(criteria) ? criteria.flatMap(entry => evidenceRefs(record(entry).evidenceRefs)) : [])] };
}

async function hasCurrentPublicationReceipt(db: Db, companyId: string, receipts: unknown, attachment: {
  id: string; originatingRunId: string | null; filename: string | null; byteSize: number; sha256: string;
}, lockSources = false): Promise<boolean> {
  for (const value of Object.values(record(receipts))) {
    const receipt = record(value);
    const input = record(receipt.input);
    const result = record(receipt.result);
    if ((result.disposition !== "applied" && result.disposition !== "duplicate") ||
        !Array.isArray(result.entityRefs) || result.entityRefs[0] !== attachment.id) continue;
    if (receipt.operationId === "publish_external_deliverable" && result.source === "authenticated_upload"
      && result.commandId === `deliverable-uploaded:${attachment.id}` && typeof input.uploadId === "string"
      && typeof input.workSessionId === "string" && attachment.originatingRunId && attachment.filename
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.uploadId)
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.workSessionId)
      && input.filename === attachment.filename
      && input.byteSize === attachment.byteSize && input.sha256 === attachment.sha256) {
      const query = db.select({ id: mcpAttachmentUploads.id }).from(mcpAttachmentUploads)
        .innerJoin(dotRunnerAssignments, and(eq(dotRunnerAssignments.id, mcpAttachmentUploads.workSessionId),
          eq(dotRunnerAssignments.companyId, companyId)))
        .where(and(eq(mcpAttachmentUploads.id, input.uploadId), eq(mcpAttachmentUploads.companyId, companyId),
          eq(mcpAttachmentUploads.workSessionId, input.workSessionId), eq(mcpAttachmentUploads.attachmentId, attachment.id),
          eq(dotRunnerAssignments.runId, attachment.originatingRunId), eq(mcpAttachmentUploads.originalFilename, attachment.filename),
          eq(mcpAttachmentUploads.byteSize, attachment.byteSize), eq(mcpAttachmentUploads.sha256, attachment.sha256))).limit(1);
      const [upload] = await (lockSources ? query.for("share", { of: [mcpAttachmentUploads, dotRunnerAssignments], noWait: true }) : query);
      if (upload) return true;
    }
    if (receipt.operationId === "register_deliverable" &&
        result.commandId === `deliverable-prepared:${attachment.id}` &&
        typeof input.filename === "string" && input.filename.trim() === attachment.filename &&
        input.byteSize === attachment.byteSize &&
        typeof input.sha256 === "string" && input.sha256.trim().toLowerCase() === attachment.sha256.toLowerCase()) return true;
    if (receipt.operationId !== "reuse_chat_attachment" ||
        result.commandId !== `chat-attachment-reused:${attachment.id}`) continue;
    const prepared = record(result.prepared);
    const source = record(result.source);
    if (prepared.attachmentId !== attachment.id ||
        source.attachmentId !== input.attachmentId || source.commentId !== input.sourceCommentId ||
        typeof prepared.sha256 !== "string" || prepared.sha256.toLowerCase() !== attachment.sha256.toLowerCase() ||
        typeof source.sha256 !== "string" || source.sha256.toLowerCase() !== attachment.sha256.toLowerCase()) continue;
    if ("filename" in prepared || "byteSize" in prepared) {
      if (prepared.filename === attachment.filename && prepared.byteSize === attachment.byteSize) return true;
      continue;
    }
    // Older committed reuse receipts contain the authenticated source and hash,
    // but not its filename/size. Only an intact, matching source can supply those
    // missing facts; this does not authorize a new reuse or bypass its tool gate.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    if (typeof source.attachmentId !== "string" || !uuid.test(source.attachmentId) ||
        typeof source.commentId !== "string" || !uuid.test(source.commentId)) continue;
    const query = db.select({ filename: assets.originalFilename, byteSize: assets.byteSize, sha256: assets.sha256 })
      .from(issueAttachments).innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, companyId)))
      .where(and(eq(issueAttachments.id, source.attachmentId), eq(issueAttachments.companyId, companyId),
        eq(issueAttachments.issueCommentId, source.commentId))).limit(1);
    const [original] = await (lockSources ? query.for("share", { of: [issueAttachments, assets], noWait: true }) : query);
    if (original?.filename === attachment.filename && original.byteSize === attachment.byteSize &&
        original.sha256.toLowerCase() === attachment.sha256.toLowerCase()) return true;
  }
  return false;
}

/** Recognize explicit output requests, not incidental mentions of source files.
 * The current server-bound objective is authoritative; summaries cannot invent
 * an output requirement or erase a user's request for a file.
 */
export function explicitlyRequestsFileOutput(objective: string): boolean {
  return deliverableLabelNamesFile(objective) || explicitlyRequestsFileOutputBySentence(objective);
}

function deliverableLabelNamesFile(objective: string): boolean {
  const lines = objective.replaceAll("\\_", "_").split(/\r?\n/u);
  const named = /(?:^|[\s(`'"*:])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[^\s/()`'"*:,;]+\.(?:html?|css|md|txt|json|pdf|docx?|xlsx?|csv|pptx?|png|jpe?g|svg|zip))\b/giu;
  const repositoryChange = /\b(?:[Rr]epo(?:sitory)?|[Pp]ull [Rr]equest|PR|[Cc]ommit|[Bb]ranch)\b/u;
  const inputReference = /\b(?:of|about|from|using|reading|comparing|between|no|without)\s+(?:(?:the|a|an|this|that)\s+)?[`'"*]*(?:[^\s,;]+[`'"*]*(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or|vs\.?|versus)\s+)(?:(?:the|a|an|this|that)\s+)?[`'"*]*)*$/iu;
  const inlineDestination = /\b(?:inline|(?:in|within|inside|as|into)\s+(?:(?:a|an|the|my|your|our|final|plain|markdown|chat|fenced)\s+)*(?:chat|response|reply|message|comment|text|code block))\b/iu;
  const noFiles = /\b(?:(?:do not|don['’]t|never)\s+(?:create|make|write|save|produce)\s+(?:any\s+)?(?:new\s+)?files?|(?:no|without(?:\s+(?:any|creating(?:\s+any)?))?)\s+(?:new\s+)?files?)\b/iu;
  const negated = /\b(?:do not|don['’]t|never|no need to)\s+(?:\w+\s+)?$/iu;
  const forbiddenFile = /\b(?:do not|don['’]t|never|no need to)\s+(?:create|make|write|save|produce|generate|build|export|prepare|attach|upload|publish)\s+(?:(?:a|an|the|any|new|separate|extra|additional)\s+)*[`'"*]*$/iu;
  const editedFile = /\b(?:update|edit|modify|fix|change|refactor|patch)\s+(?:(?:the|existing|current)\s+)*[`'"*]*$/iu;
  const publicationVerb = /\b(?:publish|attach|export|upload|send|share|deliver|register)\b/giu;
  const conjunction = /\b(?:and|plus|then|alongside|as well as|with)\b/giu;
  const sameOutput = /^\s*(?:(?:its|their|the)\s+(?:full\s+)?(?:contents?|source|code|markup|text)|it|them)\s*$/iu;
  const namesFile = (text: string) => {
    const matches = [...text.matchAll(named)];
    if (matches.length === 0 || noFiles.test(text) || repositoryChange.test(text.replace(named, " "))) return false;
    const publishes = (name: string) => {
      const object = new RegExp(`^\\s+(?:(?:it|them|both)\\b|(?:(?:the|a|an|updated|edited|new|final)\\s+)*(?:files?\\b|[\`'"*]*${name.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}))`, "iu");
      return [...text.matchAll(publicationVerb)].some(verb => !negated.test(text.slice(0, verb.index))
        && object.test(text.slice(verb.index! + verb[0].length)));
    };
    const ownsInline = (between: string) => {
      const last = [...between.matchAll(conjunction)].at(-1);
      const rest = between.slice(last ? last.index! + last[0].length : 0);
      return !last || sameOutput.test(rest) || [...rest.matchAll(named)].length > 0;
    };
    return matches.some(match => {
      const start = match.index! + match[0].indexOf(match[1]!);
      const before = text.slice(0, start);
      if (inputReference.test(before) || forbiddenFile.test(before)) return false;
      if (editedFile.test(before) && !publishes(match[1]!)) return false;
      const end = start + match[1]!.length;
      const clauseStart = Math.max(text.lastIndexOf(",", start), text.lastIndexOf(";", start)) + 1;
      const next = text.slice(end).search(/[,;]/u);
      const clauseEnd = next < 0 ? text.length : end + next;
      const after = inlineDestination.exec(text.slice(end, clauseEnd));
      if (after && ownsInline(text.slice(end, end + after.index))) return false;
      const lead = text.slice(clauseStart, start);
      const leading = [...lead.matchAll(new RegExp(inlineDestination.source, "giu"))].at(-1);
      return !(leading && ownsInline(lead.slice(leading.index! + leading[0].length)));
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const label = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:requested\s+)?deliverables?(?:\*\*|__)?\s*(?::(?:\*\*|__)?\s*(.*)|(?:\*\*|__)?\s*)$/iu.exec(lines[index]!);
    if (!label) continue;
    if (namesFile(label[1] ?? "")) return true;
    for (let item = index + 1; item < lines.length; item += 1) {
      if (!lines[item]!.trim()) continue;
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(lines[item]!);
      if (!bullet) break;
      if (namesFile(bullet[1]!)) return true;
    }
  }
  return false;
}

function explicitlyRequestsFileOutputBySentence(objective: string): boolean {
  const sentences = objective.replaceAll("\\_", "_").split(/(?:[.!?](?:\s|$)|\n)/iu);
  let precedingFileOutput = false;
  return sentences.some((sentence, index) => {
    const file = /\b(?:files?|attachments?|downloads?|pdf|spreadsheets?|workbooks?|slide decks?|powerpoints?|docx|xlsx|csv)\b|\b[^\s/]+\.(?:md|txt|json|pdf|docx?|xlsx?|csv|pptx?|png|jpe?g|svg|zip)\b/giu;
    const outputs = sentence.split(/(?:[;,]|\bbut\b)/iu).flatMap(clause => {
      const creates = [...clause.matchAll(/\b(?:create|make|write|save|export|attach|send|generate|produce|prepare|provide|give|return|build|publish)\b/giu)];
      return creates.flatMap((create, createIndex) => {
        const before = clause.slice(0, create.index);
        if (/\b(?:do not|don['’]t|never|no need to)\s*$/iu.test(before)) return [];
        const negation = /\b(?:do not|don['’]t|never|no need to)\b/iu.exec(before);
        if (negation) {
          const rest = before.slice(negation.index + negation[0].length);
          if (!/\binstead\b/iu.test(rest) && /^(?:\s*|[\s\S]*\b(?:and|or|nor)\s*)$/iu.test(rest)) return [];
        }
        // Bind each object to its own verb. A denied write or "create no files"
        // cannot suppress a separate requested report in this same clause.
        const output = clause.slice(create.index + create[0].length, creates[createIndex + 1]?.index);
        // An explicit attachment/export request can refer to the file by
        // pronoun. It still requires publication when its name is omitted.
        const referencesOutput = /^(?:attach|export|send|provide|give|return|publish)$/iu.test(create[0])
          && /^\s+(?:me\s+)?(?:it|them|this|that)\b/iu.test(output);
        const referencedAttachment = referencesOutput && /^(?:attach|export)$/iu.test(create[0]);
        const inlineDestination = /\b(?:inline|(?:in|within|inside|as|into)\s+(?:(?:a|an|the|my|your|our|final|plain|markdown|chat|fenced)\s+)*(?:chat|response|reply|message|comment|text|code block))\b/iu;
        const inline = inlineDestination.test(output) || /\b(?:its|the) contents\b/iu.test(output);
        const downloadable = referencedAttachment || (!/\b(?:no|without)\s+(?:downloadable|attached)/iu.test(output)
          && /\b(?:downloadable|attached)\s+(?:file|report|document|checklist|draft)\b/iu.test(output));
        const inlineOnly = inlineDestination.test(output.split(/\s+(?:and|then)\s+/iu, 1)[0]) && !downloadable && !/^(?:attach|export|publish)$/iu.test(create[0])
          && !/\bas (?:an? )?attachment\b/iu.test(output);
        const objects = [...output.matchAll(file)].filter(match => {
          const prefix = output.slice(0, match.index);
          const suffix = output.slice(match.index + match[0].length);
          // "Create no files" is a prohibition, even though it contains a creation
          // verb. Negate this object only; another explicit output can still count.
          if (/\b(?:no|zero|without(?:\s+(?:any|a|an))?)\s+(?:(?:new|temporary|downloadable|attached|additional)\s+)*$/iu.test(prefix)) return false;
          // "Write a summary of this PDF" names input, not a requested file.
          // Explicit export destinations still count after such input references.
          const json = /\.json$/iu.test(match[0]);
          const inputReference = /\b(?:of|about|on|from|using|for|with)\b/iu;
          const destinationMatch = (json
            ? /\b(as|into|to|named|called)\s+(?:(?:a|an|the|new|separate|markdown|word|excel)\s+)*["'`*]*(?:[^\s]*\/)?$/iu
            : /\b(?:as|into|to)\s+(?:(?:a|an|the|new|separate|markdown|word|excel)\s+)*$/iu).exec(prefix);
          const beforeDestination = prefix.slice(0, destinationMatch?.index ?? 0);
          const destination = destinationMatch !== null && (!json || !/^(?:to|named|called)$/iu.test(destinationMatch[1])
            || !inputReference.test(beforeDestination));
          if (json) {
            const directObject = /^\s*(?:(?:a|an|the|my|your|our|their|his|her|its|this|that)\s+(?:(?:new|separate|downloadable|attached)\s+)*([\p{L}\p{N}_-]+\s+)?|(?:(?:new|separate|downloadable|attached)\s+)*)["'`*]*(?:[^\s]*\/)?$/iu.exec(prefix);
            if (!destination && (!directObject || inputReference.test(directObject[1] ?? ""))) return false;
          } else if (!destination && inputReference.test(prefix)) return false;
          if (/^files?$/iu.test(match[0]) && /^\s+(?:tools?|permissions?|systems?|formats?|names?|paths?|types?|sizes?|descriptors?)\b/iu.test(suffix)) return false;
          return true;
        });
        const publication = /\b(?:downloadable|attached|attach|export|send|provide|return|give|publish)\b/iu.test(create[0] + output);
        const deniedAttempt = create[0].toLowerCase() === "write" && objects.length === 1
          && /\b(?:attempt|try)\s+(?:the\s+)?native\s*$/iu.test(before)
          && /\b(?:must be denied|denial is (?:the )?expected|(?:this|the) negative test)\b/iu.test(objective);
        if (objects.length === 0 && !downloadable && /^\s+(?:no|zero|without)\b/iu.test(output)) return [];
        return [{ namesFile: objects.length > 0, objects: objects.filter(match => !inlineOnly || !/\.json$/iu.test(match[0])).length, downloadable, publication, deniedAttempt,
          referencesOutput, publicationReference: referencesOutput && !inline }];
      });
    });
    // "This ..." qualifies a single requested file in the preceding sentence,
    // even when a later clause checks it. Multiple files cannot share this
    // exception and separate report requests still require publication.
    const internal = outputs.reduce((count, output) => count + output.objects + Number(output.downloadable && output.objects === 0), 0) === 1
      && /^\s*This is (?:an? )?(?:personal memory|internal (?:assertion|verification) file)\b[^.!?]*\bnot a (?:task )?deliverable\b/iu.test(sentences[index + 1] ?? "");
    return outputs.some(output => {
      const publicationReference = output.publicationReference && precedingFileOutput;
      if (!output.referencesOutput) precedingFileOutput = output.namesFile;
      return (output.objects > 0 || output.downloadable || publicationReference)
        && (output.publication || (!internal && !output.deniedAttempt));
    });
  });
}

/** An explicitly requested document on the task must be published there. */
export function explicitlyRequestsTaskDocumentOutput(objective: string): boolean {
  // Keep comma-separated conditions with their imperative. This is a narrow
  // unconditional-output guard, not an interpreter of whether a condition held.
  return objective.split(/(?:[.!?](?:\s|$)|\n|;)/iu).some(statement => {
    // Check conditions before separating contrastive instructions: "create a
    // document, but only if ..." must not become an unconditional requirement.
    if (/\b(?:if|unless|when|once|otherwise|provided that|in case)\b/iu.test(statement)) return false;
    return statement.split(/\bbut\b/iu).some(clause => {
      if (/\boptionally\b/iu.test(clause)) return false;
      const create = /\b(?:create|make|write|save|publish|prepare|provide|attach)\b/iu.exec(clause);
      if (!create) return false;
      const before = clause.slice(0, create.index);
      if (/\b(?:do not|don['’]t|never|no need to|may|could|can)\b/iu.test(before)) return false;
      if (/\b(?:explain|describe|discuss|review)\b/iu.test(before)) return false;
      const output = clause.slice(create.index + create[0].length);
      return [...output.matchAll(/\b(?:document|doc)\b/giu)].some(match => {
        const prefix = output.slice(0, match.index);
        if (/\b(?:of|about|from|using|for|with|without|no|zero)\b/iu.test(prefix)) return false;
        return /^\s+(?:on|to|in|attached to)\s+(?:this|the|current)\s+(?:task|issue)\b/iu.test(output.slice(match.index + match[0].length));
      });
    });
  });
}

async function declinedTaskDocumentNotRequired(db: Db, binding: {
  companyId: string; issueId: string; runId: string; objective: string; lockSources?: boolean;
}): Promise<boolean> {
  if (!/\bif I (?:decline|reject) the action\b/iu.test(binding.objective) ||
      !/\bno (?:briefing|document|doc)(?: document)? is required after a (?:decline|rejection)\b/iu.test(binding.objective)) return false;
  const runQuery = db.select({ context: heartbeatRuns.contextSnapshot, description: issues.description }).from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).where(and(
    eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.nativeIssueId, binding.issueId),
  )).limit(1);
  const [run] = await (binding.lockSources ? runQuery.for("share", { of: [heartbeatRuns, issues], noWait: true }) : runQuery);
  const continuation = record(run?.context?.executionContinuation);
  const trigger = record(continuation.trigger);
  const objectiveSource = record(continuation.objectiveSource);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (run?.description?.trim() !== binding.objective.trim() || continuation.objective !== binding.objective || typeof trigger.interactionId !== "string" ||
      !uuid.test(trigger.interactionId) || typeof trigger.sourceRunId !== "string" || !uuid.test(trigger.sourceRunId) ||
      objectiveSource.kind !== "description" || objectiveSource.id !== binding.issueId ||
      objectiveSource.revision !== createHash("sha256").update(binding.objective.trim()).digest("hex")) return false;
  const query = db.select({ interaction: issueThreadInteractions, sourceContext: heartbeatRuns.contextSnapshot,
    sourceContract: completionContracts.contractJson }).from(issueThreadInteractions)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, issueThreadInteractions.sourceRunId),
      eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.nativeIssueId, binding.issueId), eq(heartbeatRuns.runtimeMode, "native")))
    .innerJoin(completionContracts, and(eq(completionContracts.id, heartbeatRuns.completionContractId),
      eq(completionContracts.companyId, binding.companyId), eq(completionContracts.issueId, binding.issueId)))
    .where(and(eq(issueThreadInteractions.id, trigger.interactionId), eq(issueThreadInteractions.companyId, binding.companyId),
      eq(issueThreadInteractions.issueId, binding.issueId), eq(issueThreadInteractions.sourceRunId, trigger.sourceRunId))).limit(1);
  const [saved] = await (binding.lockSources ? query.for("share", { of: [issueThreadInteractions, heartbeatRuns, completionContracts], noWait: true }) : query);
  if (!saved || saved.interaction.kind !== "request_confirmation" || saved.interaction.dismissedAt ||
      projectHumanInteractionResponse(saved.interaction)?.status !== "rejected" ||
      Object.keys(record(record(saved.interaction.payload).toolAction)).length === 0) return false;
  const source = record(saved.sourceContext?.executionContinuation);
  const originalSource = record(source.objectiveSource);
  const originalCriteria = record(saved.sourceContract).criteria;
  return source.objective === binding.objective &&
    originalSource.kind === objectiveSource.kind && originalSource.id === objectiveSource.id &&
    originalSource.revision === objectiveSource.revision &&
    Array.isArray(originalCriteria) && originalCriteria.some(value => record(value).requirement === binding.objective);
}

/** Current attached revisions with server-owned publication proof. Joining the
 * revision to its originating run preserves completed work across continuations
 * without accepting stale, foreign-task, or provider-invented document refs.
 */
export async function publishedTaskDocuments(db: Db, binding: { companyId: string; issueId: string; lockSources?: boolean }) {
  const query = db.select({ id: documents.id, revisionId: documents.latestRevisionId,
    key: issueDocuments.key, resultJson: heartbeatRuns.resultJson,
    issuePrefix: companies.issuePrefix, issueIdentifier: issues.identifier })
    .from(issueDocuments)
    .innerJoin(issues, and(eq(issues.id, issueDocuments.issueId), eq(issues.companyId, binding.companyId)))
    .innerJoin(companies, eq(companies.id, issues.companyId))
    .innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, binding.companyId)))
    .innerJoin(documentRevisions, and(eq(documentRevisions.id, documents.latestRevisionId),
      eq(documentRevisions.documentId, documents.id), eq(documentRevisions.companyId, binding.companyId)))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, documentRevisions.createdByRunId),
      eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.nativeIssueId, binding.issueId),
      eq(heartbeatRuns.runtimeMode, "native")))
    .where(and(eq(issueDocuments.companyId, binding.companyId), eq(issueDocuments.issueId, binding.issueId)));
  const saved = await (binding.lockSources ? query.for("share", { of: [issueDocuments, documents, documentRevisions, heartbeatRuns], noWait: true }) : query);
  return saved.filter(document => Object.values(record(document.resultJson?.semanticToolReceipts)).some(value => {
    const receipt = record(value), result = record(receipt.result), published = record(result.document);
    return receipt.operationId === "write_document" && ["applied", "duplicate"].includes(String(result.disposition))
      && published.id === document.id && published.latestRevisionId === document.revisionId;
  })).map(({ id, revisionId, key, issuePrefix, issueIdentifier }) => ({ id, revisionId, key,
    href: `/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(issueIdentifier ?? binding.issueId)}#document-${encodeURIComponent(key)}` }));
}

/** A parent that delegated a file to a child links the child's delivered file
 * instead of publishing a copy, because native register_deliverable is bound to
 * its current task. A completed direct child's attachment is a valid citation,
 * but not this run's publication of a file that the parent itself requests.
 */
async function completedChildAttachment(db: Db, binding: { companyId: string; issueId: string; lockSources?: boolean }, id: string): Promise<boolean> {
  const query = db.select({ id: issueAttachments.id }).from(issueAttachments)
    .innerJoin(issues, and(eq(issues.id, issueAttachments.issueId), eq(issues.companyId, binding.companyId),
      eq(issues.parentId, binding.issueId), eq(issues.status, "done")))
    .where(and(eq(issueAttachments.id, id), eq(issueAttachments.companyId, binding.companyId))).limit(1);
  const [attachment] = await (binding.lockSources ? query.for("share", { of: [issueAttachments, issues], noWait: true }) : query);
  return attachment !== undefined;
}

/** Files cited as completed output must be reachable outside the agent workspace. */
export async function validateNativeDeliverableEvidence(
  db: Db,
  binding: { companyId: string; issueId: string; runId: string; objective: string; semanticToolReceipts: unknown; lockSources?: boolean; authoritativeDone?: true },
  result: unknown,
): Promise<void> {
  const evidence = publicationEvidence(result);
  if (!binding.authoritativeDone && evidence.disposition !== "done") return;
  const fileRequested = explicitlyRequestsFileOutput(binding.objective);
  const taskDocumentRequested = explicitlyRequestsTaskDocumentOutput(binding.objective) &&
    !await declinedTaskDocumentNotRequired(db, binding);
  const artifactRefs = new Set(evidence.artifacts);
  const refs = new Set(evidence.refs);
  const citesTaskDocument = [...refs].some(ref => /^\/[^/?#]+\/issues\/[^/?#]+#document-[^/?#]+$/u.test(ref.trim()));
  const publishedDocuments = taskDocumentRequested || citesTaskDocument ? await publishedTaskDocuments(db, binding) : [];
  const publishedTaskDocument = taskDocumentRequested && publishedDocuments.length > 0;
  const documentHrefs = new Set(publishedDocuments.map(document => document.href));
  let registeredAttachment = false;
  for (const value of refs) {
    if (typeof value !== "string") continue;
    const ref = value.trim();
    if (documentHrefs.has(ref)) continue;
    const attachmentPath = /^\/api\/attachments\/([^/?#]+)\/content(?:[?#].*)?$/u.exec(ref);
    if (ref.startsWith("deliverable:") || attachmentPath) {
      const id = attachmentPath?.[1] ?? ref.slice("deliverable:".length);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
      const query = db.select({ id: issueAttachments.id, originatingRunId: issueAttachments.originatingRunId,
            filename: assets.originalFilename, byteSize: assets.byteSize, sha256: assets.sha256 }).from(issueAttachments)
            .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, binding.companyId)))
            .where(and(eq(issueAttachments.id, id), eq(issueAttachments.companyId, binding.companyId), eq(issueAttachments.issueId, binding.issueId)))
            .limit(1);
      const [attachment] = uuid.test(id)
        ? await (binding.lockSources ? query.for("share", { of: [issueAttachments, assets], noWait: true }) : query) : [];
      if (!attachment) {
        if (uuid.test(id) && await completedChildAttachment(db, binding, id)) continue;
        throw new NativeDeliverableEvidenceError("Completion cites no registered attachment on this task or its completed child tasks. Use register_deliverable for the requested file and cite deliverable:<attachmentId> from its receipt. No human completion approval was created.");
      }
      // A prior output (or user input) can be useful context, but does not prove
      // this run published the newly requested output. The receipt survives a
      // controller restart of this run; a replacement can re-register preserved
      // workspace bytes internally rather than asking the user to confirm them.
      if ((fileRequested || taskDocumentRequested) && attachment.originatingRunId !== binding.runId) continue;
      if ((fileRequested || taskDocumentRequested) && !await hasCurrentPublicationReceipt(db, binding.companyId, binding.semanticToolReceipts, attachment, binding.lockSources)) {
        throw new NativeDeliverableEvidenceError("This attachment has no matching verified publication receipt for this run's requested output. Inspect any preserved file and use register_deliverable to verify its current filename, size, and SHA-256, then cite the new receipt. No human completion approval was created.");
      }
      registeredAttachment = true;
      continue;
    }
    // URLs and typed durable refs are not workspace paths. Verification commands
    // belong in verification; do not scan prose or upload files named by a model.
    const localFile = /^(?:file:|\.{0,2}\/|[a-z]:[\\/])/iu.test(ref)
      || (!/^[a-z][a-z0-9+.-]*:/iu.test(ref) && /^[^\r\n]+\.[a-z0-9]{1,16}(?::\d+(?::\d+)?)?$/iu.test(ref));
    if (localFile && taskDocumentRequested && !publishedTaskDocument) {
      throw new NativeDeliverableEvidenceError("The requested task document is only a workspace file. Publish it on this task with write_document, or attach the verified file with register_deliverable and cite deliverable:<attachmentId>. Reuse completed work; do not request a new completion approval.");
    }
    if (localFile && (fileRequested || artifactRefs.has(value))) {
      throw new NativeDeliverableEvidenceError("Completion cites a workspace-only file that the user cannot download. Before finishing, use register_deliverable for requested file outputs and cite deliverable:<attachmentId> from the receipt, with /api/attachments/<attachmentId>/content as the download link. For repository changes, cite an accessible PR or registered work product instead. No human completion approval was created.");
    }
  }
  if (taskDocumentRequested && !publishedTaskDocument && !registeredAttachment) {
    throw new NativeDeliverableEvidenceError("The requested document has not been published on this task. Use write_document, or register_deliverable with its verified attachment receipt. A workspace path or final message alone is not the requested task document. Reuse completed work without requesting a new completion approval.");
  }
  if (fileRequested && !registeredAttachment) {
    const query = db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, binding.companyId), eq(issueWorkProducts.issueId, binding.issueId),
      eq(issueWorkProducts.createdByRunId, binding.runId),
    ));
    const products = refs.size ? await (binding.lockSources ? query.for("share", { noWait: true }) : query) : [];
    const accessibleProduct = products.some(product => {
      if (product.createdByRunId !== binding.runId) return false;
      if (["failed", "cancelled", "archived"].includes(product.status)) return false;
      // A workspace_file resource is only a locator: registration neither checks
      // its current bytes nor keeps them alive after workspace cleanup. Requested
      // files need a published URL or the verified attachment receipt above.
      const accessible = typeof product.url === "string" && /^https?:\/\//iu.test(product.url);
      return accessible && [product.url, `work_product:${product.id}`, `work-product:${product.id}`, `artifact:${product.id}`]
        .some(ref => typeof ref === "string" && refs.has(ref));
    });
    if (!accessibleProduct) throw new NativeDeliverableEvidenceError("The requested file has no accessible delivery evidence. Use register_deliverable and cite deliverable:<attachmentId>, or cite an accessible work product registered by this run for this task. Empty evidence, prior-run output, and a verification result cannot substitute for the requested file. Continue publishing or report a concrete blocker; no human completion approval was created.");
  }
}
