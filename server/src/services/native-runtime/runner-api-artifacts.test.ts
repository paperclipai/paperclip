import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { executeRunnerApi, RUNNER_API_INLINE_BYTES, type RunnerApiIo } from "./runner-api-client.js";
const context = { companyId: "company-a", issueId: "issue-a", runId: "run-a", workMode: "standard" };
const projects = "GET /api/companies/{companyId}/projects";
const io = (fetcher: typeof fetch): RunnerApiIo => ({
  apiUrl: "http://127.0.0.1:3100", token: "private-agent-token", fetch: fetcher,
  readFile: async () => { throw new Error("not an upload"); },
  saveResponse: async body => {
    const bytes = Buffer.isBuffer(body) ? body : await readFile(body.path);
    return { artifactId: "saved", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  },
});
describe("explicit read response artifacts", () => {
  it("exports a small authorized document without JSON transcription or a second request", async () => {
    const source = Buffer.from(`{ "body": ${JSON.stringify('café 🌍\n# Evidence\n"quoted"')}, "empty": [] }\n`);
    const fetcher = vi.fn(async () => new Response(source, { headers: { "content-type": "application/json" } }));
    let saved: Buffer | undefined;
    const result = await executeRunnerApi({ operationId: projects, saveResponse: true }, context, {
      ...io(fetcher),
      saveResponse: async (body, contentType) => {
        saved = Buffer.isBuffer(body) ? body : await readFile(body.path);
        return { artifactId: "document", byteSize: saved.length, contentType };
      },
    });
    expect(result).toMatchObject({ ok: true, artifact: { artifactId: "document", byteSize: source.length } });
    expect(result).not.toHaveProperty("data");
    expect(saved).toEqual(source);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("complete authorized read export", () => {
  it.each(["[]", "null", "{\n \"body\": \"é🧭\\n\\\"quoted\\\"\"\n}", ...[RUNNER_API_INLINE_BYTES - 1, RUNNER_API_INLINE_BYTES, RUNNER_API_INLINE_BYTES + 1, 100000].map(n => "x".repeat(n))])("preserves source bytes and integrity for response %#", async source => {
    const bytes = Buffer.from(source);
    const fetcher = vi.fn(async () => new Response(bytes, { headers: { "content-type": "text/plain", "x-paperclip-has-more": "true", "x-paperclip-next-offset": "2" } }));
    const reserve = vi.fn(async () => vi.fn(async () => {}));
    const result = await executeRunnerApi({ operationId: projects, saveResponse: true }, context, { ...io(fetcher), reserveResponseCapture: reserve });
    expect(result).toMatchObject({ ok: true, artifact: { byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, pagination: { hasMore: true, nextOffset: 2 } });
    expect(result).not.toHaveProperty("data");
    expect(result).not.toHaveProperty("preview");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    await expect(reserve.mock.results[0].value).resolves.toHaveBeenCalledWith(bytes.length, true);
  });

  it.each([403, 500])("marks a truncated HTTP %s error body without exporting it", async status => {
    const source = "é".repeat(RUNNER_API_INLINE_BYTES);
    const saveResponse = vi.fn(io(fetch).saveResponse);
    const result = await executeRunnerApi({ operationId: projects, saveResponse: true }, context, {
      ...io(async () => new Response(source, { status })), saveResponse,
    });
    expect(result).toMatchObject({ ok: false, status, byteSize: Buffer.byteLength(source), truncated: true });
    expect(result).not.toHaveProperty("artifact");
    expect(saveResponse).not.toHaveBeenCalled();
  });

  it.each([403, 404, 500, 206])("does not export an HTTP %s response", async status => {
    const saveResponse = vi.fn(io(fetch).saveResponse);
    const result = await executeRunnerApi({ operationId: projects, saveResponse: true }, context, {
      ...io(async () => new Response("private", { status })), saveResponse,
    });
    expect(result).toMatchObject({ ok: false, status });
    expect(result).not.toHaveProperty("artifact");
    expect(saveResponse).not.toHaveBeenCalled();
  });

  it.each([
    { operationId: "POST /api/companies/{companyId}/projects" },
    { operationId: "GET /api/board-api-keys" },
    { operationId: projects, responseText: {} },
    { operationId: projects, pathParams: { companyId: "foreign" } },
  ])("rejects invalid export before dispatch: %j", async args => {
    const fetcher = vi.fn(fetch);
    await expect(executeRunnerApi({ ...args, saveResponse: true }, context, io(fetcher))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the default small JSON response inline", async () => {
    const saveResponse = vi.fn(io(fetch).saveResponse);
    expect(await executeRunnerApi({ operationId: projects }, context, { ...io(async () => Response.json([])), saveResponse })).toMatchObject({ data: [] });
    expect(saveResponse).not.toHaveBeenCalled();
  });
});
