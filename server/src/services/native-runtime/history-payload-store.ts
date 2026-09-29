import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { loadConfig } from "../../config.js";
import { createStorageProviderFromConfig } from "../../storage/provider-registry.js";
import type { StorageProvider } from "../../storage/types.js";
import { DurableAuthorityStoreError } from "../../vendor/paperclip-runner/index.js";

export interface HistoryPayloadScope { companyId: string; runId: string }
export interface HistoryPayloadReference extends HistoryPayloadScope {
  schema: "paperclip.history-payload.v1";
  provider: StorageProvider["id"];
  objectKey: string;
  byteLength: number;
  sha256: string;
  mediaType: "application/json" | "text/plain; charset=utf-8";
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hex = /^[a-f0-9]{64}$/;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function objectKey(scope: HistoryPayloadScope, sha256: string): string {
  if (!uuid.test(scope.companyId) || !uuid.test(scope.runId) || !hex.test(sha256)) throw new Error("history_payload_scope_invalid");
  return `${scope.companyId}/native-history/${scope.runId}/${sha256.slice(0, 2)}/${sha256}`;
}

/** Immutable content addressed objects. A reference never accepts a caller's
 * path or URL, and every read verifies scope, length and content before use.
 * The caller chooses the per-record allocation limit; there is no history cap. */
export class HistoryPayloadStore {
  constructor(private readonly provider: StorageProvider) {}

  private validate(scope: HistoryPayloadScope, value: unknown, maxBytes: number): HistoryPayloadReference {
    const ref = value as HistoryPayloadReference | null;
    if (!ref || ref.schema !== "paperclip.history-payload.v1" || ref.companyId !== scope.companyId || ref.runId !== scope.runId ||
      ref.provider !== this.provider.id || !Number.isSafeInteger(ref.byteLength) || ref.byteLength <= 0 || ref.byteLength > maxBytes ||
      !["application/json", "text/plain; charset=utf-8"].includes(ref.mediaType) || ref.objectKey !== objectKey(scope, ref.sha256)) {
      throw new Error("history_payload_reference_invalid");
    }
    return ref;
  }

  async put(scope: HistoryPayloadScope, bytes: Buffer, mediaType: HistoryPayloadReference["mediaType"]): Promise<HistoryPayloadReference> {
    if (!bytes.length) throw new Error("history_payload_empty");
    const sha256 = hash(bytes);
    const ref: HistoryPayloadReference = { schema: "paperclip.history-payload.v1", ...scope,
      provider: this.provider.id, objectKey: objectKey(scope, sha256), byteLength: bytes.length, sha256, mediaType };
    try {
      await this.provider.putObject({ objectKey: ref.objectKey, body: Readable.from([bytes]),
        contentType: mediaType, contentLength: bytes.length, sha256 });
    // Publication follows an exact read-back, including on S3-compatible stores
    // which do not implement the AWS checksum header. Lost publication leaves
    // only a reusable immutable orphan, never a dangling database reference.
      await this.read(scope, ref, bytes.length);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOSPC" || code === "EDQUOT") throw new DurableAuthorityStoreError("storage_pressure", "immutable history storage is full");
      throw error;
    }
    return ref;
  }

  async read(scope: HistoryPayloadScope, value: unknown, maxBytes: number): Promise<Buffer> {
    const ref = this.validate(scope, value, maxBytes);
    const result = await this.provider.getObject({ objectKey: ref.objectKey });
    let length = 0;
    const chunks: Buffer[] = [];
    try {
      if (result.contentLength !== undefined && result.contentLength !== ref.byteLength) throw new Error("history_payload_length_mismatch");
      for await (const value of result.stream) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        length += bytes.length;
        if (length > ref.byteLength) throw new Error("history_payload_length_mismatch");
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks, length);
      if (length !== ref.byteLength || hash(bytes) !== ref.sha256) throw new Error("history_payload_integrity_mismatch");
      return bytes;
    } finally { result.stream.destroy(); }
  }
}

export function createHistoryPayloadStore(): HistoryPayloadStore {
  return new HistoryPayloadStore(createStorageProviderFromConfig(loadConfig()));
}
