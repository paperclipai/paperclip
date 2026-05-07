import { describe, expect, it } from "vitest";
import { HttpClient } from "../http.js";
import { ToscaApiError } from "../types.js";
import {
  firstCallAuthHeader,
  firstCallBody,
  firstCallUrl,
  mockJsonResponse,
  mockNoContentResponse,
} from "./helpers.js";

const BASE_URL = "https://myorg.tricentis.com";
const PAT_CREDS = { type: "pat" as const, token: "test-token" };

function makeClient(fetchFn: typeof globalThis.fetch): HttpClient {
  return new HttpClient({ baseUrl: BASE_URL, credentials: PAT_CREDS, fetchFn });
}

describe("HttpClient", () => {
  it("sends Authorization header with PAT credentials", async () => {
    const fetch = mockJsonResponse({ id: "1" });
    const client = makeClient(fetch);
    await client.get("/api/v1/test");
    expect(firstCallAuthHeader(fetch)).toBe("Bearer test-token");
  });

  it("appends query params to the URL", async () => {
    const fetch = mockJsonResponse({});
    const client = makeClient(fetch);
    await client.get("/api/v1/items", { page: 2, pageSize: 10 });
    expect(firstCallUrl(fetch)).toContain("page=2");
    expect(firstCallUrl(fetch)).toContain("pageSize=10");
  });

  it("omits undefined query params", async () => {
    const fetch = mockJsonResponse({});
    const client = makeClient(fetch);
    await client.get("/api/v1/items", { page: undefined, pageSize: 10 });
    expect(firstCallUrl(fetch)).not.toContain("page=");
    expect(firstCallUrl(fetch)).toContain("pageSize=10");
  });

  it("sends JSON body on POST", async () => {
    const fetch = mockJsonResponse({ id: "new" }, 201);
    const client = makeClient(fetch);
    await client.post("/api/v1/items", { name: "foo" });
    expect(firstCallBody(fetch)).toEqual({ name: "foo" });
  });

  it("throws ToscaApiError on non-OK response", async () => {
    const errorBody = { code: "NOT_FOUND", message: "Resource not found" };
    const fetch = mockJsonResponse(errorBody, 404);
    const client = makeClient(fetch);
    await expect(client.get("/api/v1/missing")).rejects.toThrow(ToscaApiError);
    await expect(client.get("/api/v1/missing")).rejects.toMatchObject({
      status: 404,
      body: errorBody,
    });
  });

  it("returns undefined for 204 No Content", async () => {
    const fetch = mockNoContentResponse();
    const client = makeClient(fetch);
    const result = await client.delete("/api/v1/items/1");
    expect(result).toBeUndefined();
  });
});
