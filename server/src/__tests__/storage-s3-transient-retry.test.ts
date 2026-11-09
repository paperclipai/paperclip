import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createS3StorageProvider } from "../storage/s3-provider.js";

type Seen = { method: string; range: string | null; ifMatch: string | null; body: string };
const seen: Seen[] = [];
let respond: (req: IncomingMessage, res: ServerResponse, body: string, index: number) => void = (_req, res) => res.end();

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", chunk => chunks.push(chunk as Buffer));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ method: req.method ?? "", range: req.headers.range ?? null,
      ifMatch: (req.headers["if-match"] as string | undefined) ?? null, body });
    respond(req, res, body, seen.length - 1);
  });
});
let endpoint = "";
let dir = "";
const savedEnv = { ...process.env };

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AWS_ACCESS_KEY_ID = "fixture-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret-key";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  dir = await mkdtemp(join(tmpdir(), "s3-transient-"));
});

afterAll(async () => {
  process.env = savedEnv;
  await rm(dir, { recursive: true, force: true });
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => { seen.length = 0; });

function provider() {
  return createS3StorageProvider({ bucket: "bucket", region: "us-east-1", endpoint, forcePathStyle: true });
}

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

async function sourceFile(content: string) {
  const file = join(dir, `${seen.length}-${Math.random().toString(16).slice(2)}.bin`);
  await writeFile(file, content);
  return file;
}

const SERVER_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message><RequestId>req-500</RequestId></Error>`;

describe("S3 transient failures on saved files", () => {
  it.each([
    ["an internal error", (res: ServerResponse) => { res.writeHead(500, { "content-type": "application/xml" }); res.end(SERVER_ERROR); }],
    ["a connection reset", (res: ServerResponse) => { res.socket?.destroy(); }],
  ])("resends a small file upload after %s by reading the file again", async (_label, fail) => {
    const content = "saved workspace archive bytes";
    respond = (_req, res, _body, index) => {
      if (index === 0) { fail(res); return; }
      res.writeHead(200, { etag: '"saved"' });
      res.end();
    };

    await expect(provider().putObject({ objectKey: "company/workspace.pcws", body: Buffer.alloc(0),
      contentType: "application/octet-stream", contentLength: content.length, sourceFile: await sourceFile(content) }))
      .resolves.toEqual({ integrity: "server_verified_md5" });

    expect(seen.map(entry => entry.method)).toEqual(["PUT", "PUT"]);
    expect(seen[1]!.body).toBe(content);
  });

  it("does not resend a small upload the store refused for good", async () => {
    respond = (_req, res) => {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>denied</Message></Error>`);
    };

    await expect(provider().putObject({ objectKey: "company/workspace.pcws", body: Buffer.alloc(0),
      contentType: "application/octet-stream", contentLength: 5, sourceFile: await sourceFile("bytes") }))
      .rejects.toMatchObject({ name: "AccessDenied" });
    expect(seen.map(entry => entry.method)).toEqual(["PUT"]);
  });

  it("keeps a download complete when its connection breaks after the last byte", async () => {
    const content = "0123456789abcdefghij";
    respond = (_req, res) => {
      res.writeHead(200, { "content-length": String(content.length + 5), etag: '"v1"' });
      res.write(content);
      setTimeout(() => res.socket?.destroy(), 20);
    };

    const object = await provider().getObject({ objectKey: "company/restore.pcws", range: { start: 0, end: content.length - 1 } });

    expect(await readAll(object.stream)).toBe(content);
    expect(seen.map(entry => entry.method)).toEqual(["GET"]);
  });

  it("resumes a download whose body is cut off from the byte where it stopped", async () => {
    const content = "0123456789abcdefghij";
    respond = (req, res, _body, index) => {
      if (index === 0) {
        res.writeHead(200, { "content-length": String(content.length), etag: '"v1"' });
        res.write(content.slice(0, 8));
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      const [, from, to] = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "")!;
      const end = to ? Number(to) : content.length - 1;
      res.writeHead(206, { "content-length": String(end - Number(from) + 1), etag: '"v1"',
        "content-range": `bytes ${from}-${end}/${content.length}` });
      res.end(content.slice(Number(from), end + 1));
    };

    const object = await provider().getObject({ objectKey: "company/restore.pcws" });

    expect(await readAll(object.stream)).toBe(content);
    expect(seen.map(entry => [entry.method, entry.range, entry.ifMatch])).toEqual([
      ["GET", null, null], ["GET", "bytes=8-19", '"v1"']]);
  });

  it("closes a stalled download's connection when its reader gives up", async () => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>(resolve => { closed = resolve; });
    respond = (_req, res) => {
      res.writeHead(200, { "content-length": "20", etag: '"v1"' });
      res.write("01234567");
      res.on("close", () => closed());
    };

    const object = await provider().getObject({ objectKey: "company/restore.pcws" });
    const reader = object.stream[Symbol.asyncIterator]();
    expect(String((await reader.next()).value)).toBe("01234567");
    object.stream.destroy();

    await expect(Promise.race([connectionClosed.then(() => "closed"),
      new Promise(resolve => setTimeout(() => resolve("still open"), 2_000))])).resolves.toBe("closed");
  });

  it("closes a stalled resume request when its reader gives up", async () => {
    let closed!: () => void;
    const resumeClosed = new Promise<void>(resolve => { closed = resolve; });
    respond = (_req, res, _body, index) => {
      if (index === 0) {
        res.writeHead(200, { "content-length": "20", etag: '"v1"' });
        res.write("01234567");
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      res.on("close", () => closed());
    };

    const object = await provider().getObject({ objectKey: "company/restore.pcws" });
    const reader = object.stream[Symbol.asyncIterator]();
    expect(String((await reader.next()).value)).toBe("01234567");
    void reader.next().catch(() => undefined);
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 5_000 });
    object.stream.destroy();

    await expect(Promise.race([resumeClosed.then(() => "closed"),
      new Promise(resolve => setTimeout(() => resolve("still open"), 2_000))])).resolves.toBe("closed");
  });

  it("fails instead of mixing bytes when the object changed before the download resumed", async () => {
    const content = "0123456789abcdefghij";
    respond = (_req, res, _body, index) => {
      if (index === 0) {
        res.writeHead(200, { "content-length": String(content.length), etag: '"v1"' });
        res.write(content.slice(0, 8));
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      res.writeHead(412, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code><Message>changed</Message></Error>`);
    };

    const object = await provider().getObject({ objectKey: "company/restore.pcws" });

    await expect(readAll(object.stream)).rejects.toMatchObject({ name: "PreconditionFailed" });
    expect(seen.map(entry => entry.ifMatch)).toEqual([null, '"v1"']);
  });
});
