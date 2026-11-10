import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { isStorageUnavailableError, storageUnavailableMessage, STORAGE_CREDENTIALS_REJECTED_MESSAGE,
  waitOutStorageOutages } from "../storage/storage-unavailable.js";

const rejection = (code: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>${code}</Code><Message>Injected credential rejection</Message><RequestId>req-403</RequestId></Error>`;

let acceptedKey = "first-access-key";
let rejectAllUntil = 0;
let rejectionCode = "InvalidAccessKeyId";
const signedWith: string[] = [];
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const key = /Credential=([^/]+)\//.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    signedWith.push(key);
    if (key !== acceptedKey || Date.now() < rejectAllUntil) {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end(rejection(rejectionCode));
      return;
    }
    res.writeHead(200, { etag: '"v1"' });
    res.end();
  });
});
const savedEnv = { ...process.env };
let endpoint = "";

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
});
afterAll(async () => {
  process.env = savedEnv;
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  signedWith.length = 0;
  acceptedKey = "first-access-key";
  rejectAllUntil = 0;
  rejectionCode = "InvalidAccessKeyId";
  process.env.AWS_ACCESS_KEY_ID = "first-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "first-secret-key";
});

const provider = () => createS3StorageProvider({ bucket: "bucket", region: "us-east-1", endpoint, forcePathStyle: true });
const put = (storage: ReturnType<typeof provider>, objectKey: string) =>
  storage.putObject({ objectKey, body: Buffer.from("{}"), contentType: "application/json", contentLength: 2 });

describe("S3 credentials that expire or rotate during a run (storage chaos ST5)", () => {
  it("re-resolves a rotated key and finishes the write instead of failing the run", async () => {
    const storage = provider();
    await put(storage, "company/runs/before.json");
    acceptedKey = "second-access-key";
    process.env.AWS_ACCESS_KEY_ID = "second-access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "second-secret-key";
    await waitOutStorageOutages(() => put(storage, "company/runs/after.json"));
    expect(signedWith).toEqual(["first-access-key", "first-access-key", "second-access-key"]);
  }, 30_000);

  it.each(["ExpiredToken", "InvalidAccessKeyId", "SignatureDoesNotMatch"])(
    "waits out a window of 403 %s answers with a valid key", async (code) => {
      rejectionCode = code;
      rejectAllUntil = Date.now() + 3_000;
      await expect(waitOutStorageOutages(() => put(provider(), "company/runs/window.json"))).resolves.toBeUndefined();
      expect(signedWith.length).toBeGreaterThan(1);
    }, 30_000);

  it("reports a rejected key as a storage wait with a credentials message outside the wait", async () => {
    acceptedKey = "never-issued";
    const error = await put(provider(), "company/runs/rejected.json").catch(thrown => thrown);
    expect(isStorageUnavailableError(error)).toBe(true);
    expect(storageUnavailableMessage(error)).toBe(STORAGE_CREDENTIALS_REJECTED_MESSAGE);
    expect(signedWith).toHaveLength(1);
  });

  it("keeps a 403 AccessDenied a permanent failure", async () => {
    rejectionCode = "AccessDenied";
    acceptedKey = "never-issued";
    const error = await put(provider(), "company/runs/denied.json").catch(thrown => thrown);
    expect(isStorageUnavailableError(error)).toBe(false);
  });
});
