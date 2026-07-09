import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPipelineCommands } from "../commands/pipelines.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const CASE_ID = "11111111-1111-4111-8111-111111111111";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerPipelineCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base",
    "http://localhost:3100",
    "--api-key",
    "board-token",
    "--company-id",
    COMPANY_ID,
  ], { from: "user" });
}

describe("pipeline CLI commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends request-changes review decisions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ case: { id: CASE_ID } }));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "pipelines",
      "case",
      "review",
      CASE_ID,
      "--request-changes",
      "--reason",
      "Needs edits",
      "--expected-version",
      "2",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/cases/${CASE_ID}/review`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      decision: "request_changes",
      reason: "Needs edits",
      expectedVersion: 2,
    });
  });

  it("passes request_changes rows through review-bulk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-pipeline-cli-"));
    const file = join(dir, "review-bulk.json");
    await writeFile(file, JSON.stringify([
      { caseId: CASE_ID, decision: "request_changes", reason: "Needs edits", expectedVersion: 2 },
    ]));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await run(["pipelines", "review-bulk", "--file", file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_ID}/review-cases/bulk`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      items: [{ caseId: CASE_ID, decision: "request_changes", reason: "Needs edits", expectedVersion: 2 }],
    });
  });

  it("passes blockedByCaseKeys rows through ingest-batch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-pipeline-cli-"));
    const file = join(dir, "ingest-batch.json");
    await writeFile(file, JSON.stringify([
      { caseKey: "tweet", title: "Tweet", blockedByCaseKeys: ["image", "post"] },
      { caseKey: "image", title: "Image" },
      { caseKey: "post", title: "Post" },
    ]));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "33333333-3333-4333-8333-333333333333", key: "content", name: "Content" }]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await run(["pipelines", "ingest-batch", "content", "--file", file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3100/api/pipelines/33333333-3333-4333-8333-333333333333/cases/batch");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      items: [
        { caseKey: "tweet", title: "Tweet", blockedByCaseKeys: ["image", "post"] },
        { caseKey: "image", title: "Image" },
        { caseKey: "post", title: "Post" },
      ],
    });
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
