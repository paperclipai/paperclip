import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storageFailureDiagnosticsFor } from "../storage/failure-diagnostics.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";

// The body an S3-compatible gateway sends when it gives up on a request.
const REQUEST_CANCELED = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>RequestCanceled</Code><Message>Request is canceled.</Message><RequestId>req-408</RequestId></Error>`;

let failuresLeft = 0;
const requests: string[] = [];
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.resume();
  req.on("end", () => {
    requests.push(req.method ?? "");
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      res.writeHead(408, { "content-type": "application/xml", "x-amz-request-id": "req-408" });
      res.end(req.method === "HEAD" ? undefined : REQUEST_CANCELED);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", "content-length": "5", etag: '"etag"' });
    res.end(req.method === "GET" ? "hello" : undefined);
  });
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

beforeEach(() => {
  failuresLeft = 0;
  requests.length = 0;
});

function provider() {
  return createS3StorageProvider({ bucket: "bucket", region: "us-east-1", endpoint, forcePathStyle: true });
}

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

describe("S3 request timeout retries", () => {
  it("retries a read that the provider answered with 408 RequestCanceled", async () => {
    failuresLeft = 1;
    const object = await provider().getObject({ objectKey: "company/asset.png" });

    expect(await readAll(object.stream)).toBe("hello");
    expect(requests).toEqual(["GET", "GET"]);
  });

  it("retries a HEAD request that timed out", async () => {
    failuresLeft = 1;
    await expect(provider().headObject({ objectKey: "company/asset.png" })).resolves.toMatchObject({ exists: true });
    expect(requests).toEqual(["HEAD", "HEAD"]);
  });

  it("stops at the SDK attempt limit and still reports the failed read", async () => {
    failuresLeft = 10;
    const error = await provider().getObject({ objectKey: "company/asset.png" }).catch((err: unknown) => err);

    expect(error).toMatchObject({ name: "RequestCanceled" });
    expect(requests).toEqual(["GET", "GET", "GET"]);
    expect(storageFailureDiagnosticsFor(error)).toEqual({
      provider: "s3",
      operation: "get_object",
      errorCode: "RequestCanceled",
      httpStatus: 408,
      requestId: "req-408",
      attempts: 3,
    });
  });

  it("does not repeat a write that timed out", async () => {
    failuresLeft = 1;
    const error = await provider()
      .putObject({ objectKey: "k", body: Buffer.from("abc"), contentType: "text/plain", contentLength: 3 })
      .catch((err: unknown) => err);

    expect(error).toMatchObject({ name: "RequestCanceled" });
    expect(requests).toEqual(["PUT"]);
  });
});
