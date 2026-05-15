import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";

const ORIGINAL_ENV = { ...process.env };

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerIssueCommands(program);
  return program;
}

function findDocument(program: Command): Command {
  const issue = program.commands.find((command) => command.name() === "issue");
  expect(issue).toBeDefined();
  const document = issue!.commands.find((command) => command.name() === "document");
  expect(document).toBeDefined();
  return document!;
}

describe("registerIssueCommands document subcommands", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("registers `issue document list|get|put`", () => {
    const program = buildProgram();
    const document = findDocument(program);
    expect(document.commands.map((c) => c.name()).sort()).toEqual(["get", "list", "put"]);
  });

  it("declares put body, body-file, title, format, and base-revision-id options", () => {
    const program = buildProgram();
    const document = findDocument(program);
    const put = document.commands.find((c) => c.name() === "put");
    expect(put).toBeDefined();
    const longs = put!.options.map((o) => o.long);
    for (const flag of [
      "--body",
      "--body-file",
      "--title",
      "--format",
      "--base-revision-id",
    ]) {
      expect(longs).toContain(flag);
    }
  });

  it("declares list --include-system option", () => {
    const program = buildProgram();
    const document = findDocument(program);
    const list = document.commands.find((c) => c.name() === "list");
    expect(list).toBeDefined();
    expect(list!.options.map((o) => o.long)).toContain("--include-system");
  });
});

class ExitInvoked extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe("issue document put — wire format", () => {
  let tmpDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclipai-cli-doc-"));
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitInvoked(code ?? 0);
    }) as never);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("PUTs the body from --body-file with auth and run-id headers, then GETs round-trip", async () => {
    const issueId = "00000000-0000-0000-0000-0000000000aa";
    const apiBase = "http://test:3100";
    const body = "# Audit Table\n\n| Plugin | Status |\n| --- | --- |\n| facebook | review |\n";

    const bodyFile = path.join(tmpDir, "audit-table.md");
    fs.writeFileSync(bodyFile, body, "utf8");

    process.env.PAPERCLIP_API_URL = apiBase;
    process.env.PAPERCLIP_API_KEY = "token-xyz";
    process.env.PAPERCLIP_RUN_ID = "run-9";
    process.env.PAPERCLIP_COMPANY_ID = "company-1";

    const docResponse = {
      id: "doc-1",
      companyId: "company-1",
      issueId,
      key: "audit-table",
      title: "Audit Table",
      format: "markdown",
      body,
      latestRevisionId: "rev-1",
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(docResponse), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(docResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const program = buildProgram();
    await program.parseAsync(
      [
        "issue",
        "document",
        "put",
        issueId,
        "audit-table",
        "--body-file",
        bodyFile,
        "--title",
        "Audit Table",
        "--json",
      ],
      { from: "user" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [putUrl, putInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(putUrl).toBe(`${apiBase}/api/issues/${issueId}/documents/audit-table`);
    expect(putInit.method).toBe("PUT");
    const putHeaders = putInit.headers as Record<string, string>;
    expect(putHeaders.authorization).toBe("Bearer token-xyz");
    expect(putHeaders["x-paperclip-run-id"]).toBe("run-9");
    expect(putHeaders["content-type"]).toBe("application/json");
    const putBody = JSON.parse(String(putInit.body));
    expect(putBody).toEqual({
      title: "Audit Table",
      format: "markdown",
      body,
    });

    await program.parseAsync(
      ["issue", "document", "get", issueId, "audit-table", "--json"],
      { from: "user" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(getUrl).toBe(`${apiBase}/api/issues/${issueId}/documents/audit-table`);
    expect(getInit.method).toBe("GET");

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("rejects when neither --body nor --body-file is provided", async () => {
    process.env.PAPERCLIP_API_URL = "http://test:3100";
    process.env.PAPERCLIP_API_KEY = "token";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const program = buildProgram();
    await expect(
      program.parseAsync(
        ["issue", "document", "put", "issue-1", "audit-table"],
        { from: "user" },
      ),
    ).rejects.toBeInstanceOf(ExitInvoked);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("rejects when both --body and --body-file are provided", async () => {
    process.env.PAPERCLIP_API_URL = "http://test:3100";
    process.env.PAPERCLIP_API_KEY = "token";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const bodyFile = path.join(tmpDir, "body.md");
    fs.writeFileSync(bodyFile, "hi", "utf8");

    const program = buildProgram();
    await expect(
      program.parseAsync(
        [
          "issue",
          "document",
          "put",
          "issue-1",
          "audit-table",
          "--body",
          "hi",
          "--body-file",
          bodyFile,
        ],
        { from: "user" },
      ),
    ).rejects.toBeInstanceOf(ExitInvoked);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });
});
