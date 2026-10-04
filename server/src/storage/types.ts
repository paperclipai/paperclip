import type { StorageProvider as StorageProviderId } from "@paperclipai/shared";
import type { Readable } from "node:stream";

/**
 * Upload body. A `Buffer` is used for small in-memory payloads (images, logos,
 * manifests); a `Readable` is used for large binaries that must never be fully
 * buffered in the Node heap (video masters, archives).
 */
export type UploadBody = Buffer | Readable;

export interface PutObjectInput {
  objectKey: string;
  // Readable bodies stream straight to the backend (contentLength must be the
  // exact byte size); Buffer stays supported for small payloads.
  body: Buffer | Readable;
  contentType: string;
  /**
   * Declared object length. Optional for streamed uploads; when omitted the
   * provider must be able to write an unknown-length stream.
   */
  contentLength?: number;
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
  putObject(input: PutObjectInput): Promise<void>;
  getObject(input: GetObjectInput): Promise<GetObjectResult>;
  headObject(input: GetObjectInput): Promise<HeadObjectResult>;
  deleteObject(input: GetObjectInput): Promise<void>;
}

export type PutFileInput = {
  companyId: string;
  namespace: string;
  originalFilename: string | null;
  contentType: string;
} & ({ body: Buffer } | { body: Readable; byteSize: number; sha256: string });

export interface PutFileResult {
  provider: StorageProviderId;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
}

export interface StorageService {
  provider: StorageProviderId;
  putFile(input: PutFileInput): Promise<PutFileResult>;
  getObject(companyId: string, objectKey: string, options?: Pick<GetObjectInput, "range">): Promise<GetObjectResult>;
  headObject(companyId: string, objectKey: string): Promise<HeadObjectResult>;
  deleteObject(companyId: string, objectKey: string): Promise<void>;
}
