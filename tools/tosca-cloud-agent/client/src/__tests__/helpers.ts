import { vi } from "vitest";

/** Intersection that satisfies both fetch's call signature and vi mock introspection */
export type MockFetch = typeof globalThis.fetch & {
  readonly mock: { readonly calls: ReadonlyArray<readonly [string | URL | Request, RequestInit?]> };
};

/** Build a mock fetch that responds with a JSON body */
export function mockJsonResponse(body: unknown, status = 200): MockFetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : String(status),
    json: () => Promise.resolve(body),
  } as Response) as unknown as MockFetch;
}

/** Build a mock fetch that returns different responses per call */
export function mockSequentialJsonResponses(
  responses: ReadonlyArray<{ readonly body: unknown; readonly status?: number }>,
): MockFetch {
  const mock = vi.fn();
  for (const { body, status = 200 } of responses) {
    mock.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : String(status),
      json: () => Promise.resolve(body),
    } as Response);
  }
  return mock as unknown as MockFetch;
}

/** Return the URL string from the first call of a fetch mock */
export function firstCallUrl(mock: MockFetch): string {
  const [url] = mock.mock.calls[0] as [string, RequestInit?];
  return url;
}

/** Return the parsed request body from the first call of a fetch mock */
export function firstCallBody(mock: MockFetch): unknown {
  const [, init] = mock.mock.calls[0] as [string, RequestInit?];
  if (!init?.body) return undefined;
  return JSON.parse(init.body as string);
}

/** Return the Authorization header from the first call of a fetch mock */
export function firstCallAuthHeader(mock: MockFetch): string | undefined {
  const [, init] = mock.mock.calls[0] as [string, RequestInit?];
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.["Authorization"];
}

/** A raw vi.fn() that satisfies typeof globalThis.fetch — for 204 scenarios */
export function mockNoContentResponse(): MockFetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 204,
    statusText: "No Content",
    json: () => Promise.reject(new Error("no body for 204")),
  } as Response) as unknown as MockFetch;
}
