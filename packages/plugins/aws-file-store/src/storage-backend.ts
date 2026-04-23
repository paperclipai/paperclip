/**
 * S3/MinIO storage backend for the file-store plugin.
 * Local filesystem is NOT supported — all storage goes through S3-compatible APIs.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
}

export interface StorageBackend {
  writeFile(filePath: string, content: Buffer): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  exists(filePath: string): Promise<boolean>;
  stat(filePath: string): Promise<{ size: number; isDir: boolean; mtime: Date } | null>;
  listDir(dirPath: string): Promise<FileEntry[]>;
  listRecursive(dirPath: string): Promise<Array<{ relative: string; isDir: boolean }>>;
  mkdir(dirPath: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(filePath: string, recursive: boolean): Promise<void>;
  healthy(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// S3 / MinIO backend
// ---------------------------------------------------------------------------

export interface S3BackendConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  prefix?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3StorageBackend implements StorageBackend {
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(config: S3BackendConfig) {
    this.bucket = config.bucket;
    this.prefix = (config.prefix ?? "file-store").replace(/\/+$/, "");

    const s3Config: S3ClientConfig = {
      region: config.region,
      forcePathStyle: config.forcePathStyle ?? true,
    };

    if (config.endpoint) {
      s3Config.endpoint = config.endpoint;
    }

    if (config.accessKeyId && config.secretAccessKey) {
      s3Config.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }

    this.client = new S3Client(s3Config);
  }

  private key(filePath: string): string {
    const cleaned = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (cleaned.includes("..")) {
      throw new Error("Path traversal detected — path must stay within the store root");
    }
    return this.prefix ? `${this.prefix}/${cleaned}` : cleaned;
  }

  private dirKey(dirPath: string): string {
    const k = this.key(dirPath);
    return k.endsWith("/") ? k : k + "/";
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(filePath),
        Body: content,
      }),
    );
  }

  async readFile(filePath: string): Promise<Buffer> {
    const resp = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(filePath),
      }),
    );
    if (!resp.Body) throw new Error(`Empty response for ${filePath}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<{ size: number; isDir: boolean; mtime: Date } | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }),
      );
      return {
        size: head.ContentLength ?? 0,
        isDir: false,
        mtime: head.LastModified ?? new Date(),
      };
    } catch {
      const prefix = this.dirKey(filePath);
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1,
        }),
      );
      if ((list.Contents?.length ?? 0) > 0 || (list.CommonPrefixes?.length ?? 0) > 0) {
        return { size: 0, isDir: true, mtime: new Date() };
      }
      return null;
    }
  }

  async listDir(dirPath: string): Promise<FileEntry[]> {
    const prefix = dirPath ? this.dirKey(dirPath) : (this.prefix ? this.prefix + "/" : "");

    const resp = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        Delimiter: "/",
      }),
    );

    const entries: FileEntry[] = [];

    for (const cp of resp.CommonPrefixes ?? []) {
      if (cp.Prefix) {
        const name = cp.Prefix.slice(prefix.length).replace(/\/+$/, "");
        if (name) entries.push({ name, isDir: true, size: 0 });
      }
    }

    for (const obj of resp.Contents ?? []) {
      if (obj.Key) {
        const name = obj.Key.slice(prefix.length);
        if (name && !name.includes("/")) {
          entries.push({ name, isDir: false, size: obj.Size ?? 0 });
        }
      }
    }

    return entries;
  }

  async listRecursive(dirPath: string): Promise<Array<{ relative: string; isDir: boolean }>> {
    const prefix = dirPath ? this.dirKey(dirPath) : (this.prefix ? this.prefix + "/" : "");
    const results: Array<{ relative: string; isDir: boolean }> = [];
    let continuationToken: string | undefined;

    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of resp.Contents ?? []) {
        if (obj.Key) {
          const rel = obj.Key.slice(prefix.length);
          if (rel) results.push({ relative: rel, isDir: false });
        }
      }

      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    return results;
  }

  async mkdir(_dirPath: string): Promise<void> {
    // S3 prefixes are implicit — no-op
  }

  async move(from: string, to: string): Promise<void> {
    const fromKey = this.key(from);
    const toKey = this.key(to);

    const headResult = await this.stat(from);
    if (!headResult) throw new Error(`Source not found: ${from}`);

    if (headResult.isDir) {
      const children = await this.listRecursive(from);
      for (const child of children) {
        const srcKey = this.key(from + "/" + child.relative);
        const dstKey = this.key(to + "/" + child.relative);
        await this.client.send(
          new CopyObjectCommand({
            Bucket: this.bucket,
            CopySource: `${this.bucket}/${srcKey}`,
            Key: dstKey,
          }),
        );
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: srcKey }),
        );
      }
    } else {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          CopySource: `${this.bucket}/${fromKey}`,
          Key: toKey,
        }),
      );
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: fromKey }),
      );
    }
  }

  async remove(filePath: string, recursive: boolean): Promise<void> {
    const headResult = await this.stat(filePath);
    if (!headResult) throw new Error(`Not found: ${filePath}`);

    if (headResult.isDir) {
      if (!recursive) {
        const children = await this.listDir(filePath);
        if (children.length > 0) {
          throw new Error(
            `Directory is not empty (${children.length} items). Set recursive=true to remove with contents.`,
          );
        }
      }
      const all = await this.listRecursive(filePath);
      for (const child of all) {
        await this.client.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: this.key(filePath + "/" + child.relative),
          }),
        );
      }
    } else {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }),
      );
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          MaxKeys: 1,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStorageBackend(config: S3BackendConfig): StorageBackend {
  return new S3StorageBackend(config);
}
