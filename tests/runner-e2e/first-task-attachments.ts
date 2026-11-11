import type { RunnerApi } from "./api.js";
import { createHash } from "node:crypto";
import type { Row } from "./first-task-scoring.js";
import { sanitizeJson } from "./redaction.js";

/** Read persisted task attachments; a filename or a model's completion claim is not output evidence. */
export async function captureFirstTaskAttachments(api: RunnerApi, tasks: Row[], secrets: readonly string[]): Promise<Row[]> {
  return (await Promise.all(tasks.map(async task => {
    const rows = await api.get<Row[]>(`/api/issues/${encodeURIComponent(task.id)}/attachments`);
    return Promise.all(rows.map(async row => {
      const attachment: Row = { ...row, issueId: task.id };
      if (!/^text\/(?:plain|markdown)(?:;|$)/i.test(row.contentType ?? "") ||
          !Number.isFinite(row.byteSize) || row.byteSize > 262_144) return attachment;
      const response = await api.request.get(`/api/attachments/${encodeURIComponent(row.id)}/content`);
      if (!response.ok()) throw new Error(`Attachment content unavailable: ${row.id} (${response.status()})`);
      const bytes = await response.body();
      if (bytes.length !== row.byteSize) throw new Error(`Attachment size mismatch: ${row.id}`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== row.sha256) throw new Error(`Attachment hash mismatch: ${row.id}`);
      const safe = sanitizeJson({ body: bytes.toString("utf8") }, secrets) as { body: string };
      return { ...attachment, body: safe.body, contentVerified: true, contentSha256: createHash("sha256").update(safe.body).digest("hex") };
    }));
  }))).flat();
}
