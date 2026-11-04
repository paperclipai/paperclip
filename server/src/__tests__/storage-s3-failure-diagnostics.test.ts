import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { CreateMultipartUploadCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { storageFailureDiagnosticsFor } from "../storage/failure-diagnostics.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { putS3Multipart } from "../storage/s3-multipart.js";

const SIGNATURE_MISMATCH = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided. Check your key and signing method.</Message><StringToSign>private string to sign</StringToSign><RequestId>req-4G-1</RequestId></Error>`;

let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end();
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => handler(req, res));
});
let endpoint = "";
const savedEnv = { ...process.env };

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AWS_ACCESS_KEY_ID = "fixture-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret-key";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
});

afterAll(async () => {
  process.env = savedEnv;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function provider() {
  return createS3StorageProvider({ bucket: "bucket", region: "us-east-1", endpoint, forcePathStyle: true });
}

function rejectSignature(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(403, { "content-type": "application/xml", "x-amz-request-id": "req-4G-1" });
  res.end(req.method === "HEAD" ? undefined : SIGNATURE_MISMATCH);
}

describe("S3 storage failure diagnostics", () => {
  it("records the failed operation and provider correlation fields on the original SDK error", async () => {
    handler = rejectSignature;
    const error = await provider().getObject({ objectKey: "company/asset.png" }).catch((err: unknown) => err);

    expect(error).toMatchObject({ name: "SignatureDoesNotMatch" });
    expect(storageFailureDiagnosticsFor(error)).toEqual({
      provider: "s3",
      operation: "get_object",
      errorCode: "SignatureDoesNotMatch",
      httpStatus: 403,
      requestId: "req-4G-1",
      attempts: 1,
    });
    expect(JSON.stringify(storageFailureDiagnosticsFor(error))).not.toContain("private");
  });

  it("names each single-request operation", async () => {
    handler = rejectSignature;
    const s3 = provider();
    const put = await s3.putObject({ objectKey: "k", body: Buffer.from("abc"), contentType: "text/plain", contentLength: 3 }).catch((err: unknown) => err);
    const head = await s3.headObject({ objectKey: "k" }).catch((err: unknown) => err);
    const remove = await s3.deleteObject({ objectKey: "k" }).catch((err: unknown) => err);

    expect(storageFailureDiagnosticsFor(put)).toMatchObject({ operation: "put_object", errorCode: "SignatureDoesNotMatch", httpStatus: 403 });
    // A HEAD response has no body, so the SDK can only report the status.
    expect(storageFailureDiagnosticsFor(head)).toMatchObject({ operation: "head_object", httpStatus: 403, requestId: "req-4G-1" });
    expect(storageFailureDiagnosticsFor(remove)).toMatchObject({ operation: "delete_object", errorCode: "SignatureDoesNotMatch" });
  });

  it("keeps not-found handling unchanged", async () => {
    handler = (_req, res) => {
      res.writeHead(404, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>`);
    };
    const s3 = provider();

    await expect(s3.getObject({ objectKey: "missing" })).rejects.toMatchObject({ status: 404 });
    await expect(s3.headObject({ objectKey: "missing" })).resolves.toEqual({ exists: false });
  });

  it("names the multipart step that failed and ignores unsafe provider fields", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const failure = Object.assign(new Error("private provider message"), {
      name: "Signature mismatch <private>",
      $metadata: { httpStatusCode: 403, requestId: "private request id with spaces", attempts: 2 },
    });
    const send = vi.spyOn(client, "send").mockImplementation(async (command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) throw failure;
      return {};
    });
    try {
      const body = Readable.from([Buffer.from("abc")]);
      await expect(putS3Multipart(client, "bucket", "key", { objectKey: "key", contentType: "text/plain", contentLength: 3, body })).rejects.toBe(failure);
      expect(storageFailureDiagnosticsFor(failure)).toEqual({
        provider: "s3",
        operation: "upload_part",
        errorCode: "unknown",
        httpStatus: 403,
        requestId: null,
        attempts: 2,
      });
    } finally {
      send.mockRestore();
      client.destroy();
    }
  });
});
