import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshS3CredentialsOnRejection } from "./s3-credential-refresh.js";

const REJECTION = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>InvalidAccessKeyId</Code><Message>Injected rejection</Message><RequestId>req-403</RequestId></Error>`;

let acceptedKey = "first";
const delays = [50, 400];
let rejected = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const key = /Credential=([^/]+)\//.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    if (key === acceptedKey) { res.writeHead(200, { etag: '"v1"' }); res.end(); return; }
    setTimeout(() => {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end(REJECTION);
    }, delays[rejected++] ?? 0);
  });
});
let endpoint = "";

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe("S3 credential refresh after a rejection", () => {
  it("re-resolves the key once when parallel requests signed with the old key are rejected at different times", async () => {
    let issued = "first";
    let lookups = 0;
    const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, maxAttempts: 1,
      credentials: async () => { lookups += 1; return { accessKeyId: issued, secretAccessKey: `${issued}-secret` }; } });
    refreshS3CredentialsOnRejection(client);
    const put = (key: string) => client.send(new PutObjectCommand({ Bucket: "bucket", Key: key, Body: "{}" }));
    try {
      await put("warm");
      expect(lookups).toBe(1);
      acceptedKey = "second";
      issued = "second";
      const results = await Promise.allSettled([put("a"), put("b")]);
      expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
      expect(lookups).toBe(2);
      await put("after");
      expect(lookups).toBe(2);
    } finally {
      client.destroy();
    }
  });
});
