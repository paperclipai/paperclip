import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/** Lock the real Runner after the task lock and upload body verification.
 * Publication runs only after the stored attachment matches those bytes. The
 * caller holds the transfer's current work-session/grant transaction throughout. */
export async function prepareExternalDeliverablePublication(db: Db, input: {
  companyId: string; issueId: string; runId: string; agentId: string;
  uploadId: string; workSessionId: string;
  filename: string; byteSize: number; sha256: string;
}) {
  const [run] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.driverKind, "grok_bot_mcp"),
      eq(heartbeatRuns.status, "running"))).for("update");
  if (!run) throw new Error("external_deliverable_work_session_unavailable");
  const resultJson = run.resultJson ?? {};
  const receipts = { ...resultJson.semanticToolReceipts as Record<string, unknown> | undefined };
  const key = `external-upload:${input.uploadId}`;
  return async (attachmentId: string) => {
    const publication = {
      commandId: `deliverable-uploaded:${attachmentId}`, disposition: "applied",
      source: "authenticated_upload", attachmentId,
      entityRefs: [attachmentId], evidenceRef: `deliverable:${attachmentId}`,
      contentPath: `/api/attachments/${attachmentId}/content`,
      downloadPath: `/api/attachments/${attachmentId}/content?download=1`,
    };
    const receiptInput = { uploadId: input.uploadId, workSessionId: input.workSessionId,
      filename: input.filename, byteSize: input.byteSize, sha256: input.sha256 };
    const prior = receipts[key] as { operationId?: string; input?: Record<string, unknown>; result?: Record<string, unknown> } | undefined;
    if (prior) {
      if (prior.operationId !== "publish_external_deliverable" || prior.result?.commandId !== publication.commandId
        || Object.entries(receiptInput).some(([name, value]) => prior.input?.[name] !== value)) {
        throw new Error("external_deliverable_publication_conflict");
      }
    } else {
      receipts[key] = { operationId: "publish_external_deliverable", input: receiptInput, result: publication };
      await db.update(heartbeatRuns).set({ resultJson: { ...resultJson, semanticToolReceipts: receipts }, updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, input.runId));
    }
    return publication;
  };
}

/** A lost HTTP response can recover the committed proof without republishing. */
export async function readExternalDeliverablePublication(db: Db, input: {
  companyId: string; issueId: string; runId: string; agentId: string;
  uploadId: string; workSessionId: string; attachmentId: string;
}) {
  const [run] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.driverKind, "grok_bot_mcp"), eq(heartbeatRuns.status, "running")));
  const receipts = run?.resultJson?.semanticToolReceipts as Record<string, unknown> | undefined;
  const receipt = receipts?.[`external-upload:${input.uploadId}`] as {
    operationId?: string; input?: Record<string, unknown>; result?: Record<string, unknown>;
  } | undefined;
  if (receipt?.operationId !== "publish_external_deliverable" || receipt.input?.workSessionId !== input.workSessionId
    || receipt.result?.commandId !== `deliverable-uploaded:${input.attachmentId}`) return undefined;
  return receipt.result;
}
