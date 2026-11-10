import type { StorageProvider as StorageProviderId } from "@paperclipai/shared";
import type { Readable } from "node:stream";

export interface PutObjectInput {
  objectKey: string;
  signal?: AbortSignal;
  // Readable bodies stream straight to the backend (contentLength must be the
  // exact byte size); Buffer stays supported for small payloads.
  body: Buffer | Readable;
  contentType: string;
  contentLength: number;
  /**
   * Absolute path of a private file whose bytes are exactly `body`. A provider
   * may read ranges of it instead of the stream, so parts can upload in
   * parallel and be resent after a transient failure.
   */
  sourceFile?: string;
}

/**
 * The backend verified every uploaded byte against a digest the client sent
 * with it (Content-MD5 on each request), so a read-back is not needed to
 * prove the stored content.
 */
export interface PutObjectReceipt {
  integrity: "server_verified_md5";
}

export interface GetObjectInput {
  objectKey: string;
  // S3 reads cancel pending requests and their response streams.
  signal?: AbortSignal;
  range?: {
    start: number;
    end: number;
  };
}

export interface DeleteObjectInput {
  objectKey: string;
  signal?: AbortSignal;
  /** Remove every version and delete marker of this exact key before returning. */
  allVersions?: boolean;
}

export interface GetObjectResult {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
}

export interface HeadObjectResult {
  exists: boolean;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
}

export interface StorageProvider {
  id: StorageProviderId;
  readonly immutableObjectNamespace?: string;
  putObject(input: PutObjectInput): Promise<void | PutObjectReceipt>;
  getObject(input: GetObjectInput): Promise<GetObjectResult>;
  headObject(input: GetObjectInput): Promise<HeadObjectResult>;
  deleteObject(input: DeleteObjectInput): Promise<void>;

  putObjectConditional?(input: PutObjectInput & (
    | { ifNoneMatch: "*"; ifMatch?: never }
    | { ifMatch: string; ifNoneMatch?: never }
  )): Promise<{ etag: string }>;

  listObjects?(input: { prefix: string; continuationToken?: string; signal?: AbortSignal }): Promise<{
    keys: string[];
    continuationToken?: string;
  }>;
}

export type PutFileInput = {
  signal?: AbortSignal;
  /** Server-allocated, company-prefixed key for durable idempotent uploads. Never accept from client input. */
  objectKey?: string;
  companyId: string;
  namespace: string;
  originalFilename: string | null;
  contentType: string;
} & ({ body: Buffer } | { body: Readable; byteSize: number; sha256: string; sourceFile?: string });

export interface PutFileResult {
  provider: StorageProviderId;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  /** Present only when the backend verified every byte on receipt. */
  integrity?: PutObjectReceipt["integrity"];
}

export interface StorageService {
  provider: StorageProviderId;
  readonly immutableObjectNamespace?: string;
  putFile(input: PutFileInput): Promise<PutFileResult>;
  getObject(companyId: string, objectKey: string, options?: Pick<GetObjectInput, "range" | "signal">): Promise<GetObjectResult>;
  headObject(companyId: string, objectKey: string, options?: Pick<GetObjectInput, "signal">): Promise<HeadObjectResult>;
  deleteObject(companyId: string, objectKey: string, options?: Pick<DeleteObjectInput, "signal" | "allVersions">): Promise<void>;
}
