import { AbortMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FILE_PART_CONCURRENCY, THROTTLED_PART_ATTEMPTS, putS3MultipartFile } from "../storage/s3-multipart.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";

const partBytes = 8 * 1024 * 1024;

async function sourceFile(parts: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-s3-throttle-"));
  const file = path.join(dir, "source.bin");
  const handle = await fs.open(file, "wx", 0o600);
  try {
    for (let index = 0; index < parts; index++) await handle.write(Buffer.alloc(partBytes, index + 1));
  } finally { await handle.close(); }
  return { dir, file, size: parts * partBytes };
}

const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest("base64");

async function drain(body: unknown) {
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const slowDown = () => Object.assign(new Error("Please reduce your request rate."), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });

describe("file-backed S3 multipart uploads under a request-rate limit", () => {
  it("backs off and completes when the real S3 client receives SlowDown for one part", async () => {
    const source = await sourceFile(3);
    const attempts = new Map<number, number>();
    let completed = "";
    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://localhost");
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        if (url.searchParams.has("uploads")) {
          response.end("<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>");
        } else if (request.method === "PUT") {
          const number = Number(url.searchParams.get("partNumber"));
          attempts.set(number, (attempts.get(number) ?? 0) + 1);
          if (number === 2 && attempts.get(number)! <= 3) {
            response.writeHead(503, { "Content-Type": "application/xml" })
              .end("<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message><RequestId>throttled</RequestId></Error>");
          } else {
            expect(md5(Buffer.concat(chunks))).toBe(request.headers["content-md5"]);
            response.writeHead(200, { ETag: `"part-${number}"` }).end();
          }
        } else if (request.method === "POST") {
          completed = Buffer.concat(chunks).toString();
          response.end("<CompleteMultipartUploadResult><ETag>complete</ETag></CompleteMultipartUploadResult>");
        } else {
          response.writeHead(500).end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture"); vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture");
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = createStorageService(createS3StorageProvider({ bucket: "bucket", region: "us-east-1", forcePathStyle: true,
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    try {
      const result = await service.putFile({ companyId: "company", objectKey: "company/workspace-snapshots/throttled.pcws", namespace: "workspace-snapshots",
        originalFilename: null, contentType: "application/octet-stream", body: Readable.from([Buffer.alloc(0)]), byteSize: source.size,
        sha256: createHash("sha256").update(await fs.readFile(source.file)).digest("hex"), sourceFile: source.file });
      expect(result.integrity).toBe("server_verified_md5");
      expect(attempts.get(2)).toBe(4);
      expect([...completed.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(match => Number(match[1]))).toEqual([1, 2, 3]);
    } finally {
      random.mockRestore(); warn.mockRestore(); vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(source.dir, { recursive: true, force: true });
    }
  });

  it("halves new parts in flight once when a parallel burst of parts is throttled", async () => {
    const source = await sourceFile(16);
    const client = new S3Client({ region: "us-east-1" });
    const attempts = new Map<number, number>();
    let laterActive = 0, laterPeak = 0;
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        const number = command.input.PartNumber!;
        attempts.set(number, (attempts.get(number) ?? 0) + 1);
        await drain(command.input.Body);
        if (number <= FILE_PART_CONCURRENCY && attempts.get(number) === 1) throw slowDown();
        if (number > FILE_PART_CONCURRENCY) {
          laterActive++; laterPeak = Math.max(laterPeak, laterActive);
          await new Promise(resolve => setTimeout(resolve, 20));
          laterActive--;
        }
        return { ETag: `part-${number}` };
      }
      if (command instanceof AbortMultipartUploadCommand) throw new Error("must not abort a recovered upload");
      return {};
    });
    try {
      await expect(putS3MultipartFile(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream",
        contentLength: source.size, body: Buffer.alloc(0), sourceFile: source.file })).resolves.toEqual({ integrity: "server_verified_md5" });
      expect([...attempts.keys()].sort((a, b) => a - b)).toEqual([...Array(16).keys()].map(n => n + 1));
      // Eight simultaneous throttles are one round: four slots remain, not one.
      expect(laterPeak).toBe(FILE_PART_CONCURRENCY / 2);
    } finally { random.mockRestore(); send.mockRestore(); client.destroy(); await fs.rm(source.dir, { recursive: true, force: true }); }
  });

  it("stops after a bounded number of throttled attempts and aborts once", async () => {
    const source = await sourceFile(3);
    const client = new S3Client({ region: "us-east-1" });
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        await drain(command.input.Body);
        if (command.input.PartNumber === 1) throw slowDown();
        return { ETag: `part-${command.input.PartNumber}` };
      }
      if (command instanceof AbortMultipartUploadCommand) return {};
      throw new Error("must not complete a failed upload");
    });
    try {
      await expect(putS3MultipartFile(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream",
        contentLength: source.size, body: Buffer.alloc(0), sourceFile: source.file })).rejects.toMatchObject({ name: "SlowDown" });
      const partOne = send.mock.calls.filter(([command]) => command instanceof UploadPartCommand && command.input.PartNumber === 1);
      expect(partOne).toHaveLength(THROTTLED_PART_ATTEMPTS);
      expect(send.mock.calls.filter(([command]) => command instanceof AbortMultipartUploadCommand)).toHaveLength(1);
    } finally { random.mockRestore(); send.mockRestore(); client.destroy(); await fs.rm(source.dir, { recursive: true, force: true }); }
  });

  it("cancels promptly while a throttled part is backing off", async () => {
    const source = await sourceFile(3);
    const client = new S3Client({ region: "us-east-1" });
    const cancellation = new AbortController();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    const send = vi.spyOn(client, "send").mockImplementation(async (command: any) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        await drain(command.input.Body);
        if (command.input.PartNumber === 1) { setTimeout(() => cancellation.abort(new Error("run cancelled")), 10); throw slowDown(); }
        return { ETag: `part-${command.input.PartNumber}` };
      }
      return {};
    });
    const started = Date.now();
    try {
      await expect(putS3MultipartFile(client, "bucket", "key", { objectKey: "key", contentType: "application/octet-stream",
        contentLength: source.size, body: Buffer.alloc(0), sourceFile: source.file, signal: cancellation.signal })).rejects.toThrow("run cancelled");
      expect(Date.now() - started).toBeLessThan(900);
      expect(send.mock.calls.filter(([command]) => command instanceof UploadPartCommand && command.input.PartNumber === 1)).toHaveLength(1);
    } finally { random.mockRestore(); send.mockRestore(); client.destroy(); await fs.rm(source.dir, { recursive: true, force: true }); }
  });
});
