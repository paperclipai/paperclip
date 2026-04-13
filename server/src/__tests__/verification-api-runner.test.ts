import { describe, it, expect, vi } from "vitest";
import { runApiSpec } from "../services/verification/runners/api-runner.js";

function makeResponse(
  body: unknown,
  status = 200,
  contentType = "application/json",
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers({ "content-type": contentType }),
    text: async () => text,
  } as unknown as Response;
}

function makeReadFile(body: string) {
  return vi.fn(async () => body);
}

const baseSpecInput = {
  issueId: "test-issue",
  specPath: "skills/acceptance-api-specs/tests/DLD-1.api.spec.json",
};

describe("runApiSpec", () => {
  it("rejects invalid spec_path format", async () => {
    const result = await runApiSpec({
      ...baseSpecInput,
      specPath: "not-a-valid-path",
      readFileImpl: makeReadFile("{}"),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result.status).toBe("unavailable");
  });

  it("returns unavailable when spec file can't be read", async () => {
    const result = await runApiSpec({
      ...baseSpecInput,
      readFileImpl: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result.status).toBe("unavailable");
  });

  it("returns unavailable when spec is not valid JSON", async () => {
    const result = await runApiSpec({
      ...baseSpecInput,
      readFileImpl: makeReadFile("{ not valid json"),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result.status).toBe("unavailable");
  });

  it("returns unavailable when spec has wrong shape", async () => {
    const result = await runApiSpec({
      ...baseSpecInput,
      readFileImpl: makeReadFile(JSON.stringify({ method: "POST" })),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result.status).toBe("unavailable");
  });

  it("passes when status matches and schema validates", async () => {
    const spec = {
      method: "GET",
      url: "https://viracue.ai/api/health",
      expectedStatus: 200,
      expectedResponseSchema: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["ok"] } },
      },
    };
    const result = await runApiSpec({
      ...baseSpecInput,
      readFileImpl: makeReadFile(JSON.stringify(spec)),
      fetchImpl: vi.fn(async () => makeResponse({ status: "ok", version: "1.0" })) as unknown as typeof fetch,
    });
    expect(result.status).toBe("passed");
  });

  it("fails when status mismatches", async () => {
    const spec = { method: "GET", url: "https://x.com/health", expectedStatus: 200 };
    const result = await runApiSpec({
      ...baseSpecInput,
      readFileImpl: makeReadFile(JSON.stringify(spec)),
      fetchImpl: vi.fn(async () => makeResponse({ error: "down" }, 503)) as unknown as typeof fetch,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureSummary).toContain("200");
      expect(result.failureSummary).toContain("503");
    }
  });

  it("accepts multiple expected statuses", async () => {
    const spec = { method: "POST", url: "https://x.com/create", expectedStatus: [200, 201, 409] };
    const result = await runApiSpec({
      ...baseSpecInput,
      readFileImpl: makeReadFile(JSON.stringify(spec)),
      fetchImpl: vi.fn(async () => makeResponse({ id: "1" }, 409)) as unknown as typeof fetch,
    });
    expect(result.status).toBe("passed");
  });

  it("fails when schema does not match", async () => {
    const spec = {
      method: "GET",
      url: "https://x.com/thing",
      expectedStatus: 200,
      expectedResponseSchema: {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    };
    const result = await runApiSpec({
      ...baseSpecInput,
      readFileImpl: makeReadFile(JSON.stringify(spec)),
      fetchImpl: vi.fn(async () => makeResponse({ id: "abc" })) as unknown as typeof fetch,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureSummary).toContain("name");
    }
  });

  it("fails on forbidden notBody substring", async () => {
    const spec = {
      method: "GET",
      url: "https://x.com/thing",
      expectedStatus: 200,
      notBody: ["Internal server error"],
    };
    const result = await runApiSpec({
      ...baseSpecInput,
      readFileImpl: makeReadFile(JSON.stringify(spec)),
      fetchImpl: vi.fn(async () =>
        makeResponse({ message: "Internal server error: x" })) as unknown as typeof fetch,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureSummary).toContain("forbidden");
    }
  });

  it("returns unavailable when fetch throws", async () => {
    const spec = { method: "GET", url: "https://x.com/thing", expectedStatus: 200 };
    const result = await runApiSpec({
      ...baseSpecInput,
      readFileImpl: makeReadFile(JSON.stringify(spec)),
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(result.status).toBe("unavailable");
  });
});
