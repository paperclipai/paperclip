import { describe, expect, it } from "vitest";
import { GoogleToolError, GoogleWorkspaceAuthError } from "./errors.js";
import { fakeGoogle, json } from "./fixtures/fake-google.js";
import { createGoogleHttp, GOOGLE_API_HOSTS, googleError, googleRequestUrl, isWrite, MAX_RESPONSE_BYTES, type GoogleApiHost, type GoogleRequest } from "./google-http.js";

const HOST_PATHS: ReadonlyArray<readonly ["allows" | "rejects", string, string]> = [
  ["allows", "/gmail/v1/users/me/messages/m1", "gmail.googleapis.com"],
  ["allows", "/gmail/v1/users/me/profile", "gmail.googleapis.com"],
  ["rejects", "/gmail/v1/users/other@example.test/messages", "gmail.googleapis.com"],
  ["rejects", "/upload/gmail/v1/users/me/messages", "gmail.googleapis.com"],
  ["rejects", "/gmail/v1/users/me/../../../oauth2/v1/tokeninfo", "gmail.googleapis.com"],
  ["rejects", "/drive/v3/files/f1", "gmail.googleapis.com"],
  ["allows", "/calendar/v3/calendars/primary/events/e1", "www.googleapis.com"],
  ["allows", "/drive/v3/files/f1", "www.googleapis.com"],
  ["allows", "/drive/v3/files/f1/export", "www.googleapis.com"],
  ["allows", "/upload/drive/v3/files", "www.googleapis.com"],
  ["rejects", "/drive/v2/files", "www.googleapis.com"],
  ["rejects", "/gmail/v1/users/me/profile", "www.googleapis.com"],
  ["rejects", "/calendar/v30/x", "www.googleapis.com"],
  ["rejects", "/drive/v3", "www.googleapis.com"],
  ["rejects", "/upload/drive/v2/files", "www.googleapis.com"],
  ["rejects", "/upload/calendar/v3/x", "www.googleapis.com"],
  ["rejects", "/calendar/v3/../../drive/v2/files", "www.googleapis.com"],
  ["rejects", "/drive/v3/../../oauth2/v1/tokeninfo", "www.googleapis.com"],
  ["rejects", "/drive/v3/%2e%2e/%2e%2e/oauth2/v1/tokeninfo", "www.googleapis.com"],
  ["rejects", "/upload/drive/v3/../../../storage/v1/b", "www.googleapis.com"],
  ["rejects", "/v4/spreadsheets/s1", "www.googleapis.com"],
  ["allows", "/v4/spreadsheets/s1", "sheets.googleapis.com"],
  ["allows", "/v4/spreadsheets/s1:batchUpdate", "sheets.googleapis.com"],
  ["rejects", "/v4/spreadsheets", "sheets.googleapis.com"],
  ["rejects", "/v4/other", "sheets.googleapis.com"],
  ["rejects", "/v4/spreadsheets/../other", "sheets.googleapis.com"],
  ["rejects", "/drive/v3/files/f1", "sheets.googleapis.com"],
  ["allows", "/v1/documents/doc-1", "docs.googleapis.com"],
  ["allows", "/v1/documents/doc-1:batchUpdate", "docs.googleapis.com"],
  ["rejects", "/v1/documents", "docs.googleapis.com"],
  ["rejects", "/v1/documents/../../drive/v3/files", "docs.googleapis.com"],
  ["rejects", "/v1/documents/doc-1", "www.googleapis.com"],
  ["allows", "/v1/presentations/deck-1", "slides.googleapis.com"],
  ["allows", "/v1/presentations/deck-1:batchUpdate", "slides.googleapis.com"],
  ["rejects", "/v1/presentations", "slides.googleapis.com"],
  ["rejects", "/v1/documents/doc-1", "slides.googleapis.com"],
];

const GET: GoogleRequest = { method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/labels" };
const POST: GoogleRequest = { method: "POST", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/drafts", body: { message: { raw: "eA" } } };

function client(route: Parameters<typeof fakeGoogle>[0], timeoutMs?: number) {
  const fake = fakeGoogle(route);
  return { http: createGoogleHttp({ accessToken: "test-token", fetch: fake.fetch, retryDelayMs: 0, timeoutMs }), calls: fake.calls };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("googleRequestUrl", () => {
  it("builds an https googleapis.com URL with repeated array parameters", () => {
    const url = new URL(googleRequestUrl({ ...GET, query: { format: "metadata", metadataHeaders: ["From", "To"], skip: undefined, max: 5 } }));
    expect(url.origin).toBe("https://gmail.googleapis.com");
    expect(url.searchParams.getAll("metadataHeaders")).toEqual(["From", "To"]);
    expect(url.searchParams.get("max")).toBe("5");
    expect(url.searchParams.has("skip")).toBe(false);
  });

  it("refuses hosts outside the allowlist and relative paths", () => {
    expect(() => googleRequestUrl({ ...GET, host: "evil.example.test" as never })).toThrow(/not allowed/);
    expect(() => googleRequestUrl({ ...GET, path: "//evil.example.test/x" })).toThrow(/absolute/);
  });
});

describe("createGoogleHttp", () => {
  it("sends the bearer token and JSON body, and parses the JSON answer", async () => {
    const { http, calls } = client(() => json({ id: "r-1" }));
    await expect(http.send(POST)).resolves.toEqual({ id: "r-1" });
    expect(calls[0]!.headers.authorization).toBe("Bearer test-token");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({ message: { raw: "eA" } });
  });

  it("maps 401 to an unauthenticated auth error", async () => {
    const { http } = client(() => json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401));
    const error = await failure(http.send(GET));
    expect(error).toBeInstanceOf(GoogleWorkspaceAuthError);
    expect((error as GoogleWorkspaceAuthError).reason).toBe("unauthenticated");
    expect((error as GoogleWorkspaceAuthError).data).toEqual({ code: "unauthenticated", httpStatus: 401 });
  });

  it("maps 403 insufficient scope, from the body or the WWW-Authenticate header, to an insufficient_scope auth error", async () => {
    const fromBody = client(() => json({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403));
    const fromLegacyBody = client(() => json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, 403));
    const fromHeader = client(() => json({}, 403, { "www-authenticate": "Bearer error=\"insufficient_scope\", scope=\"x\"" }));
    for (const { http } of [fromBody, fromLegacyBody, fromHeader]) {
      const error = await failure(http.send(GET));
      expect(error).toBeInstanceOf(GoogleWorkspaceAuthError);
      expect((error as GoogleWorkspaceAuthError).reason).toBe("insufficient_scope");
      expect((error as GoogleWorkspaceAuthError).data).toEqual({ code: "insufficient_scope", httpStatus: 403 });
    }
  });

  it("keeps other 403s apart from scope errors", async () => {
    const disabled = await failure(client(() => json({ error: { code: 403, details: [{ reason: "SERVICE_DISABLED" }], message: "Gmail API has not been used in project 123" } }, 403)).http.send(GET));
    expect(disabled).toMatchObject({ kind: "api_disabled" });
    expect((disabled as Error).message).not.toContain("123");
    const denied = await failure(client(() => json({ error: { code: 403, message: "Delegation denied" } }, 403)).http.send(GET));
    expect(denied).toBeInstanceOf(GoogleToolError);
    expect(denied).toMatchObject({ kind: "permission_denied", message: "Delegation denied" });
  });

  it.each([
    [404, "not_found"],
    [400, "invalid_argument"],
    [429, "rate_limited"],
    [500, "unavailable"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const error = await failure(client(() => json({ error: { code: status, message: "x" } }, status)).http.send(POST));
    expect(error).toMatchObject({ kind, httpStatus: status });
  });

  it("keeps Google's structured status and reasons on 400, 409 and 403 errors", async () => {
    const rejected = await failure(client(() => json({ error: { code: 400, status: "FAILED_PRECONDITION", message: "x", details: [{ reason: "STALE" }] } }, 400)).http.send(POST));
    expect(rejected).toMatchObject({ kind: "invalid_argument", google: { status: "FAILED_PRECONDITION", reasons: ["STALE"] } });
    const aborted = await failure(client(() => json({ error: { code: 409, status: "ABORTED" } }, 409)).http.send(POST));
    expect(aborted).toMatchObject({ google: { status: "ABORTED", reasons: [] } });
    const denied = await failure(client(() => json({ error: { code: 403, status: "PERMISSION_DENIED", message: "no" } }, 403)).http.send(GET));
    expect(denied).toMatchObject({ kind: "permission_denied", google: { status: "PERMISSION_DENIED" } });
    expect(await failure(client(() => json({}, 404)).http.send(GET))).toMatchObject({ google: {} });
  });

  it("retries a read once after 503, then succeeds", async () => {
    let count = 0;
    const { http, calls } = client(() => (count++ === 0 ? json({}, 503) : json({ labels: [] })));
    await expect(http.send(GET)).resolves.toEqual({ labels: [] });
    expect(calls).toHaveLength(2);
  });

  it("retries a read at most once", async () => {
    const { http, calls } = client(() => json({}, 503));
    expect(await failure(http.send(GET))).toMatchObject({ kind: "unavailable" });
    expect(calls).toHaveLength(2);
  });

  it("never retries a write, after a 503 or a network failure", async () => {
    const after503 = client(() => json({}, 503));
    expect(await failure(after503.http.send(POST))).toMatchObject({ kind: "unavailable" });
    expect(after503.calls).toHaveLength(1);

    const afterNetwork = client(() => { throw new TypeError("fetch failed"); });
    expect(await failure(afterNetwork.http.send(POST))).toMatchObject({ kind: "network" });
    expect(afterNetwork.calls).toHaveLength(1);
  });

  it("warns that a failed write may have been applied, for network errors, 5xx and caller cancellation", async () => {
    const network = await failure(client(() => { throw new TypeError("fetch failed"); }).http.send(POST));
    expect((network as Error).message).toMatch(/may or may not have been made/);
    const unavailable = await failure(client(() => json({}, 503)).http.send(POST));
    expect((unavailable as Error).message).toMatch(/may or may not have been made/);

    const controller = new AbortController();
    const cancelled = createGoogleHttp({
      accessToken: "test-token",
      signal: controller.signal,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        controller.abort();
      }),
    });
    const error = await failure(cancelled.send(POST));
    expect(error).toMatchObject({ kind: "timeout" });
    expect((error as Error).message).toMatch(/may or may not have been made/);

    const readFailure = await failure(client(() => { throw new TypeError("fetch failed"); }).http.send(GET));
    expect((readFailure as Error).message).not.toMatch(/may or may not/);
  });

  it("warns that a write may have been applied when Google's success answer is unusable", async () => {
    const html = await failure(client(() => new Response("<html>ok</html>", { status: 200 })).http.send(POST));
    expect(html).toMatchObject({ kind: "invalid_response" });
    expect((html as Error).message).toMatch(/may or may not have been made/);

    const oversized = await failure(client(() => new Response("{}", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } })).http.send(POST));
    expect(oversized).toMatchObject({ kind: "invalid_response" });
    expect((oversized as Error).message).toMatch(/may or may not have been made/);

    const readHtml = await failure(client(() => new Response("<html>")).http.send(GET));
    expect((readHtml as Error).message).not.toMatch(/may or may not/);
  });

  it("treats a connection that drops while the body streams like any network failure", async () => {
    const dropping = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"partial\":"));
        controller.error(new TypeError("terminated"));
      },
    }), { status: 200 });

    let reads = 0;
    const read = client(() => (reads++ === 0 ? dropping() : json({ ok: true })));
    await expect(read.http.send(GET)).resolves.toEqual({ ok: true });
    expect(read.calls).toHaveLength(2);

    const write = client(() => dropping());
    const error = await failure(write.http.send(POST));
    expect(error).toBeInstanceOf(GoogleToolError);
    expect(error).toMatchObject({ kind: "network" });
    expect((error as Error).message).toMatch(/may or may not have been made/);
    expect(write.calls).toHaveLength(1);
  });

  it("retries a read once after a network failure", async () => {
    let count = 0;
    const { http, calls } = client(() => {
      if (count++ === 0) throw new TypeError("fetch failed");
      return json({ ok: true });
    });
    await expect(http.send(GET)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("stops a request at its deadline and says a write's outcome is unknown", async () => {
    let calls = 0;
    const slow = createGoogleHttp({
      accessToken: "test-token",
      retryDelayMs: 0,
      timeoutMs: 20,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        calls += 1;
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    });
    const error = await failure(slow.send(POST));
    expect(error).toMatchObject({ kind: "timeout" });
    expect((error as Error).message).toMatch(/may or may not/);
    expect(calls).toBe(1);
  });

  it("sends nothing to a disallowed host, and does not treat it as a network failure", async () => {
    const { http, calls } = client(() => json({}));
    const error = await failure(http.send({ ...GET, host: "evil.example.test" as never }));
    expect(error).not.toBeInstanceOf(GoogleToolError);
    expect(calls).toHaveLength(0);
  });

  it("rejects an oversized response", async () => {
    const declared = client(() => new Response("{}", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }));
    expect(await failure(declared.http.send(GET))).toMatchObject({ kind: "invalid_response" });
  });

  it("rejects a non-JSON success body", async () => {
    expect(await failure(client(() => new Response("<html>")).http.send(GET))).toMatchObject({ kind: "invalid_response" });
  });
});

describe("writes beyond POST", () => {
  const PATCH: GoogleRequest = { method: "PATCH", host: "www.googleapis.com", path: "/calendar/v3/calendars/primary/events/e1", body: { summary: "x" } };
  const DELETE: GoogleRequest = { method: "DELETE", host: "www.googleapis.com", path: "/calendar/v3/calendars/primary/events/e1" };
  const PUT: GoogleRequest = { method: "PUT", host: "www.googleapis.com", path: "/calendar/v3/calendars/primary/events/e1", body: {} };
  const READ_POST: GoogleRequest = { method: "POST", host: "www.googleapis.com", path: "/calendar/v3/freeBusy", body: {}, readOnly: true };

  it("treats every method but GET, and a POST marked read-only, as a write", () => {
    expect(isWrite({ method: "GET" })).toBe(false);
    expect(isWrite({ method: "POST", readOnly: true })).toBe(false);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      expect(isWrite({ method })).toBe(true);
      if (method !== "POST") expect(isWrite({ method, readOnly: true })).toBe(true);
    }
  });

  it.each([
    ["PATCH", PATCH],
    ["PUT", PUT],
    ["DELETE", DELETE],
    ["DELETE marked read-only", { ...DELETE, readOnly: true }],
  ] as const)("never retries %s and warns that the outcome is unknown", async (_name, request) => {
    const after503 = client(() => json({}, 503));
    const unavailable = await failure(after503.http.send(request));
    expect((unavailable as Error).message).toMatch(/may or may not have been made/);
    expect(after503.calls).toHaveLength(1);
    const afterNetwork = client(() => { throw new TypeError("fetch failed"); });
    const network = await failure(afterNetwork.http.send(request));
    expect((network as Error).message).toMatch(/may or may not have been made/);
    expect(afterNetwork.calls).toHaveLength(1);
  });

  it("retries a read-only POST once and gives no write warning", async () => {
    const twice = client(() => json({}, 503));
    const error = await failure(twice.http.send(READ_POST));
    expect(twice.calls).toHaveLength(2);
    expect((error as Error).message).not.toMatch(/may or may not/);
  });

  it("sends the method and If-Match header, and treats an empty 204 as success", async () => {
    const { http, calls } = client(() => new Response(null, { status: 204 }));
    await expect(http.send({ ...DELETE, ifMatch: "\"etag-1\"" })).resolves.toEqual({});
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.headers["if-match"]).toBe("\"etag-1\"");
  });

  it("says nothing changed when Google refuses a stale If-Match", async () => {
    const error = await failure(client(() => json({ error: { code: 412 } }, 412)).http.send({ ...PATCH, ifMatch: "\"old\"" }));
    expect(error).toMatchObject({ kind: "invalid_argument", httpStatus: 412 });
    expect((error as Error).message).not.toMatch(/may or may not/);
  });

  it("maps 410 Gone to not found", async () => {
    expect(await failure(client(() => json({ error: { code: 410 } }, 410)).http.send(DELETE))).toMatchObject({ kind: "not_found" });
  });

  it.each(HOST_PATHS)("%s %s on %s", (expected, path, host) => {
    const attempt = () => googleRequestUrl({ ...GET, host: host as GoogleApiHost, path });
    if (expected === "rejects") expect(attempt).toThrow(/not allowed/);
    else expect(new URL(attempt()).host).toBe(host);
  });

  it("has an allowed and a rejected path for every allowed host", () => {
    for (const host of GOOGLE_API_HOSTS) {
      expect(HOST_PATHS.some(([expected, , rowHost]) => expected === "allows" && rowHost === host), `${host} allowed row`).toBe(true);
      expect(HOST_PATHS.some(([expected, , rowHost]) => expected === "rejects" && rowHost === host), `${host} rejected row`).toBe(true);
    }
  });

  it("keeps an encoded slash inside one path segment", () => {
    expect(new URL(googleRequestUrl({ ...GET, host: "www.googleapis.com", path: "/drive/v3/files/..%2f..%2f" })).pathname.startsWith("/drive/v3/files/")).toBe(true);
  });
});

describe("download", () => {
  const MEDIA: GoogleRequest = { method: "GET", host: "www.googleapis.com", path: "/drive/v3/files/f1", query: { alt: "media" } };
  const bytes = (size: number) => new Uint8Array(size).fill(7);

  it("returns the raw bytes and content type, and asks for any type", async () => {
    const { http, calls } = client(() => new Response(bytes(3), { headers: { "content-type": "image/png" } }));
    const answer = await http.download(MEDIA, 10);
    expect([...answer.data]).toEqual([7, 7, 7]);
    expect(answer.contentType).toBe("image/png");
    expect(calls[0]!.headers.accept).toBe("*/*");
  });

  it("refuses content over the cap, declared or streamed, as too large", async () => {
    const declared = await failure(client(() => new Response(bytes(11), { headers: { "content-length": "11" } })).http.download(MEDIA, 10));
    expect(declared).toMatchObject({ kind: "too_large" });
    expect((declared as Error).message).toMatch(/larger than 10 bytes/);
    const streamed = await failure(client(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes(6));
        controller.enqueue(bytes(6));
        controller.close();
      },
    }))).http.download(MEDIA, 10));
    expect(streamed).toMatchObject({ kind: "too_large" });
  });

  it("never asks for more than the response cap", async () => {
    const { http } = client(() => new Response(null, { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }));
    expect(await failure(http.download(MEDIA, MAX_RESPONSE_BYTES * 2))).toMatchObject({ kind: "too_large" });
  });

  it("maps Google errors as send does, and retries a download once", async () => {
    let count = 0;
    const flaky = client(() => (count++ === 0 ? json({}, 503) : new Response(bytes(1))));
    await expect(flaky.http.download(MEDIA, 10)).resolves.toMatchObject({ contentType: null });
    expect(flaky.calls).toHaveLength(2);
    expect(await failure(client(() => json({ error: { code: 404 } }, 404)).http.download(MEDIA, 10))).toMatchObject({ kind: "not_found" });
  });

  it("refuses to download with a write method", async () => {
    const { http, calls } = client(() => new Response(bytes(1)));
    await expect(http.download({ ...MEDIA, method: "POST" }, 10)).rejects.toThrow(/must be a read/);
    expect(calls).toHaveLength(0);
  });
});

describe("redirects", () => {
  it("asks fetch not to follow redirects, and turns any redirect into a tool error", async () => {
    let init: RequestInit | undefined;
    const fetch = async (_url: string, given: RequestInit) => {
      init = given;
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/file" } });
    };
    const http = createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 });
    const error = await failure(http.download({ method: "GET", host: "www.googleapis.com", path: "/drive/v3/files/f1", query: { alt: "media" } }, 10));
    expect(init?.redirect).toBe("manual");
    expect(error).toMatchObject({ kind: "invalid_response", message: "Google answered with a redirect, which is not followed." });
    const write = await failure(http.send(POST));
    expect((write as Error).message).toMatch(/redirect, which is not followed\. The change may or may not have been made/);
  });

  it("treats an opaque redirect (status 0) the same way", () => {
    expect(googleError({ status: 0, headers: new Headers() }, "")).toMatchObject({ kind: "invalid_response" });
  });
});

describe("uploads and Drive error reasons", () => {
  it("sends an upload body with its own content type", async () => {
    const { http, calls } = client(() => json({ id: "n1" }));
    await http.send({ method: "POST", host: "www.googleapis.com", path: "/upload/drive/v3/files", upload: { contentType: "multipart/related; boundary=b", data: Buffer.from("abc") } });
    expect(calls[0]!.headers["content-type"]).toBe("multipart/related; boundary=b");
    expect(calls[0]!.raw?.toString()).toBe("abc");
  });

  it("refuses a request with both a JSON body and an upload", async () => {
    const { http, calls } = client(() => json({}));
    await expect(http.send({ ...POST, upload: { contentType: "text/plain", data: Buffer.from("x") } })).rejects.toThrow(/either/);
    expect(calls).toHaveLength(0);
  });

  it("maps Drive's export size limit to too_large and drive.file refusals to a clear message", () => {
    const headers = new Headers();
    expect(googleError({ status: 403, headers }, JSON.stringify({ error: { code: 403, errors: [{ reason: "exportSizeLimitExceeded" }] } })))
      .toMatchObject({ kind: "too_large" });
    const denied = googleError({ status: 403, headers }, JSON.stringify({ error: { code: 403, message: "The user has not granted the app 123456 write access to the file f1.", errors: [{ reason: "appNotAuthorizedToFile" }] } }));
    expect(denied).toMatchObject({ kind: "permission_denied" });
    expect((denied as Error).message).not.toContain("123456");
    expect((denied as Error).message).toMatch(/drive\.file/);
  });

  it.each([
    ["docs.googleapis.com", "/v1/documents/doc-1", "/v1/documents/doc-1:batchUpdate",
      ["/v1/documents", "/v1/documents:create", "/v2/documents/x", "/v1/documentsx/y", "/v1/documents/../../drive/v3/files", "/v1/presentations/x", "/upload/v1/documents/x"]],
    ["slides.googleapis.com", "/v1/presentations/deck-1", "/v1/presentations/deck-1:batchUpdate",
      ["/v1/presentations", "/v1/presentations:create", "/v1/presentations/../x", "/v1/presentationsx/y", "/v1/documents/x", "/v2/presentations/x"]],
  ] as const)("allows %s only under its documents path, after path normalization", (host, read, write, rejected) => {
    expect(googleRequestUrl({ ...GET, host, path: read })).toBe(`https://${host}${read}`);
    expect(googleRequestUrl({ ...GET, method: "POST", host, path: write })).toBe(`https://${host}${write}`);
    for (const path of rejected) expect(() => googleRequestUrl({ ...GET, host, path }), path).toThrow(/not allowed/);
  });
});
