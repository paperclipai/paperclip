import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaperclipApiClient, PaperclipApiError, issuePrefixFromIdentifier } from "./client.js";
import { runWithBearer } from "./auth-context.js";

const cfg = { apiUrl: "http://api.test/api", apiKey: null, companyId: null };

function mockFetchOnce(handler: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => vi.unstubAllGlobals());

describe("PaperclipApiClient auth precedence", () => {
  it("uses the inbound ALS bearer verbatim", async () => {
    const fetchMock = mockFetchOnce(() => new Response(JSON.stringify({ id: "me" }), { status: 200 }));
    const client = new PaperclipApiClient(cfg);
    await runWithBearer("Bearer pcp_INBOUND", () => client.requestJson("GET", "/agents/me"));
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer pcp_INBOUND");
  });

  it("falls back to the baked key when no inbound bearer", async () => {
    const fetchMock = mockFetchOnce(() => new Response("{}", { status: 200 }));
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked" });
    await client.requestJson("GET", "/agents/me");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer baked");
  });

  it("throws when neither inbound bearer nor baked key is present", async () => {
    mockFetchOnce(() => new Response("{}", { status: 200 }));
    const client = new PaperclipApiClient(cfg);
    await expect(client.requestJson("GET", "/agents/me")).rejects.toThrow(/no inbound bearer/i);
  });

  it("surfaces non-2xx as PaperclipApiError", async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ error: "nope" }), { status: 403 }));
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked" });
    await expect(client.requestJson("GET", "/agents/me")).rejects.toBeInstanceOf(PaperclipApiError);
  });

  it("PaperclipApiError on a plain-text (non-JSON) error body", async () => {
    mockFetchOnce(() => new Response("Service Unavailable", { status: 503 }));
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked" });
    await expect(client.requestJson("GET", "/x")).rejects.toMatchObject({ status: 503, body: "Service Unavailable" });
  });

  it("PaperclipApiError on an empty error body", async () => {
    mockFetchOnce(() => new Response("", { status: 500 }));
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked" });
    await expect(client.requestJson("GET", "/x")).rejects.toMatchObject({ status: 500, body: null });
  });

  it("isolates the company cache per bearer", async () => {
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      seenAuth.push(init.headers.Authorization);
      return new Response(JSON.stringify([{ id: "co-A", issuePrefix: "AAA" }]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PaperclipApiClient(cfg);
    await runWithBearer("Bearer A", () => client.listCompanies());
    await runWithBearer("Bearer A", () => client.listCompanies()); // cached: no 2nd fetch
    await runWithBearer("Bearer B", () => client.listCompanies()); // different tenant: fetches
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seenAuth).toEqual(["Bearer A", "Bearer B"]);
  });
});

describe("PaperclipApiClient query params", () => {
  it("serializes query values onto the URL, skipping empty/null/undefined", async () => {
    const seenUrls: string[] = [];
    mockFetchOnce((url) => {
      seenUrls.push(url);
      return new Response("{}", { status: 200 });
    });
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked" });
    await client.requestJson("GET", "/companies/co-1/issues", {
      query: { status: "todo,in_progress", limit: 50, offset: 0, includeArchived: false, projectId: "", assigneeAgentId: undefined, label: null },
    });
    const url = new URL(seenUrls[0]);
    expect(url.pathname).toBe("/api/companies/co-1/issues");
    expect(url.searchParams.get("status")).toBe("todo,in_progress");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("includeArchived")).toBe("false");
    expect(url.searchParams.has("projectId")).toBe(false);
    expect(url.searchParams.has("assigneeAgentId")).toBe(false);
    expect(url.searchParams.has("label")).toBe(false);
  });
});

describe("issuePrefixFromIdentifier", () => {
  it("extracts an uppercased prefix from a human key", () => {
    expect(issuePrefixFromIdentifier("PEN-307")).toBe("PEN");
    expect(issuePrefixFromIdentifier("blo-12")).toBe("BLO");
  });
  it("returns null for UUIDs and unprefixed ids", () => {
    expect(issuePrefixFromIdentifier("550e8400-e29b-41d4-a716-446655440000")).toBeNull();
    expect(issuePrefixFromIdentifier("not-a-key")).toBeNull();
    expect(issuePrefixFromIdentifier("")).toBeNull();
  });
});

describe("resolveCompany", () => {
  it("returns the default company when no override is given", async () => {
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked", companyId: "co-default" });
    expect(await client.resolveCompany({})).toBe("co-default");
  });

  it("passes a UUID override through without listing companies", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked", companyId: "co-default" });
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(await client.resolveCompany({ override: uuid })).toBe(uuid);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a prefix override to a member company UUID", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "co-pen", issuePrefix: "PEN" }, { id: "co-x", issuePrefix: "BLO" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked", companyId: "co-default" });
    expect(await client.resolveCompany({ override: "pen" })).toBe("co-pen");
  });

  it("derives company from issueId when no override is given", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "co-pen", issuePrefix: "PEN" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked", companyId: "co-default" });
    expect(await client.resolveCompany({ issueId: "PEN-42" })).toBe("co-pen");
  });

  it("throws for an unknown prefix", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "co-x", issuePrefix: "BLO" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked", companyId: "co-default" });
    await expect(client.resolveCompany({ override: "ZZZ" })).rejects.toThrow(/No accessible company with prefix "ZZZ"/);
  });

  it("throws when neither override nor default company is available", async () => {
    const client = new PaperclipApiClient({ ...cfg, apiKey: "baked" }); // companyId: null
    await expect(client.resolveCompany({})).rejects.toThrow(/PAPERCLIP_COMPANY_ID is not set/);
  });
});
