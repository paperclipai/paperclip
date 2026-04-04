import type { Express } from "express";
import { IncomingMessage, ServerResponse, type IncomingHttpHeaders } from "node:http";
import { Duplex } from "node:stream";
import { URLSearchParams } from "node:url";

type HeaderValue = number | string | readonly string[];

type InMemoryResponse = {
  status: number;
  body: unknown;
  text: string;
  headers: Record<string, string | string[]>;
};

type RequestOptions = {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
};

type MultipartField = {
  name: string;
  value: string;
};

type MultipartAttachment = {
  name: string;
  body: Buffer;
  filename: string;
  contentType: string;
};

type MultipartBody = {
  fields: MultipartField[];
  attachments: MultipartAttachment[];
};

class MockSocket extends Duplex {
  remoteAddress = "127.0.0.1";
  localAddress = "127.0.0.1";
  remotePort = 12345;
  localPort = 80;
  encrypted = false;
  destroyed = false;

  override _read(): void {}

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    callback();
  }

  override destroy(error?: Error): this {
    this.destroyed = true;
    if (error) {
      this.emit("error", error);
    }
    this.emit("close");
    return this;
  }

  setTimeout(): this {
    return this;
  }

  address() {
    return {
      address: this.localAddress,
      family: "IPv4" as const,
      port: this.localPort,
    };
  }
}

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    host: "127.0.0.1",
  };
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function buildRequestPath(path: string, query?: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        search.append(key, String(entry));
      }
      continue;
    }
    search.set(key, String(value));
  }
  const queryString = search.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function serializeBody(body: unknown, headers: Record<string, string>): Buffer | null {
  if (body === undefined) return null;
  if (isMultipartBody(body)) {
    const boundary = `----paperclip-test-${Math.random().toString(16).slice(2)}`;
    headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
    return serializeMultipartBody(body, boundary);
  }
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  return Buffer.from(JSON.stringify(body), "utf8");
}

function isMultipartBody(body: unknown): body is MultipartBody {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Partial<MultipartBody>;
  return Array.isArray(candidate.fields) && Array.isArray(candidate.attachments);
}

function serializeMultipartBody(body: MultipartBody, boundary: string): Buffer {
  const chunks: Buffer[] = [];

  for (const field of body.fields) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
        "utf8",
      ),
    );
  }

  for (const attachment of body.attachments) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${attachment.name}"; filename="${attachment.filename}"\r\n`,
        "utf8",
      ),
    );
    chunks.push(Buffer.from(`Content-Type: ${attachment.contentType}\r\n\r\n`, "utf8"));
    chunks.push(attachment.body);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

function inferContentType(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function normalizeResponseHeaders(
  headers: Record<string, HeaderValue>,
): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return normalized;
}

function parseResponseBody(text: string, contentType: string): unknown {
  if (text.length === 0) return undefined;
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (chunk === undefined || chunk === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), encoding ?? "utf8");
}

async function runRequest(app: Express, options: RequestOptions): Promise<InMemoryResponse> {
  const socket = new MockSocket();
  const req = new IncomingMessage(socket);
  const headers = normalizeHeaders(options.headers);
  const bodyBuffer = serializeBody(options.body, headers);

  req.method = options.method;
  req.url = buildRequestPath(options.path, options.query);
  (req as IncomingMessage & { originalUrl?: string }).originalUrl = req.url;
  req.headers = headers as IncomingHttpHeaders;
  req.socket = socket;
  req.connection = socket;
  if (options.body !== undefined && !Buffer.isBuffer(options.body) && typeof options.body !== "string") {
    (req as IncomingMessage & { body?: unknown }).body = options.body;
  }

  if (bodyBuffer) {
    req.headers["content-length"] = String(bodyBuffer.length);
  }

  const res = new ServerResponse(req);
  const responseChunks: Buffer[] = [];
  Object.defineProperty(res, "headersSent", {
    value: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(res, "writableEnded", {
    value: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(res, "finished", {
    value: false,
    writable: true,
    configurable: true,
  });
  res.locals = {};

  res.write = ((chunk: unknown, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
    const buffer = toBuffer(chunk, encoding);
    if (buffer.length > 0) {
      responseChunks.push(buffer);
    }
    (res as ServerResponse & { headersSent: boolean }).headersSent = true;
    if (callback) {
      process.nextTick(() => callback());
    }
    return true;
  }) as typeof res.write;

  res.end = ((chunk?: unknown, encoding?: BufferEncoding, callback?: () => void) => {
    const buffer = toBuffer(chunk, encoding);
    if (buffer.length > 0) {
      responseChunks.push(buffer);
    }
    (res as ServerResponse & { headersSent: boolean }).headersSent = true;
    (res as ServerResponse & { writableEnded: boolean }).writableEnded = true;
    (res as ServerResponse & { finished: boolean }).finished = true;
    if (callback) {
      process.nextTick(callback);
    }
    process.nextTick(() => {
      res.emit("prefinish");
      res.emit("finish");
    });
    return res;
  }) as typeof res.end;

  await new Promise<void>((resolve, reject) => {
    res.once("finish", resolve);
    res.once("error", reject);
    req.once("error", reject);

    try {
      app.handle(req as never, res as never, (error?: unknown) => {
        if (error instanceof Error) {
          reject(error);
          return;
        }
        if (error !== undefined) {
          reject(new Error(String(error)));
          return;
        }
        if (!res.writableEnded) {
          res.end();
        }
      });
    } catch (error) {
      reject(error);
      return;
    }

    process.nextTick(() => {
      if (bodyBuffer) {
        req.push(bodyBuffer);
      }
      req.push(null);
    });
  });

  const text = Buffer.concat(responseChunks).toString("utf8");
  const responseHeaders = normalizeResponseHeaders(
    res.getHeaders() as Record<string, HeaderValue>,
  );

  return {
    status: res.statusCode,
    body: parseResponseBody(text, String(res.getHeader("content-type") ?? "")),
    text,
    headers: responseHeaders,
  };
}

class InMemoryRequestBuilder implements PromiseLike<InMemoryResponse> {
  private headers: Record<string, string> = {};
  private queryParams: Record<string, unknown> = {};
  private body: unknown;
  private readonly formFields: MultipartField[] = [];
  private readonly attachments: MultipartAttachment[] = [];

  constructor(
    private readonly app: Express,
    private readonly method: string,
    private readonly path: string,
  ) {}

  set(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  query(values: Record<string, unknown>): this {
    Object.assign(this.queryParams, values);
    return this;
  }

  send(body: unknown): this {
    this.body = body;
    return this;
  }

  field(name: string, value: string): this {
    this.formFields.push({ name, value });
    return this;
  }

  attach(
    name: string,
    body: Buffer,
    options: string | { filename: string; contentType?: string },
  ): this {
    const filename = typeof options === "string" ? options : options.filename;
    const contentType =
      typeof options === "string"
        ? inferContentType(options)
        : (options.contentType ?? inferContentType(options.filename));
    this.attachments.push({ name, body, filename, contentType });
    return this;
  }

  async expect(status: number): Promise<InMemoryResponse> {
    const response = await this.execute();
    if (response.status !== status) {
      throw new Error(`Expected status ${status} but received ${response.status}`);
    }
    return response;
  }

  then<TResult1 = InMemoryResponse, TResult2 = never>(
    onfulfilled?: ((value: InMemoryResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<InMemoryResponse | TResult> {
    return this.execute().catch(onrejected ?? undefined);
  }

  finally(onfinally?: (() => void) | null): Promise<InMemoryResponse> {
    return this.execute().finally(onfinally ?? undefined);
  }

  private execute(): Promise<InMemoryResponse> {
    const requestBody =
      this.attachments.length > 0 || this.formFields.length > 0
        ? {
            fields: this.formFields,
            attachments: this.attachments,
          }
        : this.body;
    return runRequest(this.app, {
      method: this.method,
      path: this.path,
      query: this.queryParams,
      headers: this.headers,
      body: requestBody,
    });
  }
}

type RequestFactory = {
  get(path: string): InMemoryRequestBuilder;
  post(path: string): InMemoryRequestBuilder;
  patch(path: string): InMemoryRequestBuilder;
  put(path: string): InMemoryRequestBuilder;
  delete(path: string): InMemoryRequestBuilder;
};

export default function request(app: Express): RequestFactory {
  return {
    get: (path) => new InMemoryRequestBuilder(app, "GET", path),
    post: (path) => new InMemoryRequestBuilder(app, "POST", path),
    patch: (path) => new InMemoryRequestBuilder(app, "PATCH", path),
    put: (path) => new InMemoryRequestBuilder(app, "PUT", path),
    delete: (path) => new InMemoryRequestBuilder(app, "DELETE", path),
  };
}
