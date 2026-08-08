import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFolderCommands } from "../commands/client/folder.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const FOLDER_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "33333333-3333-4333-8333-333333333333";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerFolderCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

describe("folder commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps full folder CRUD endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["folder", "create", "--company-id", COMPANY_ID, "--name", "Engineering", "--parent-id", PARENT_ID]);
    await run(["folder", "get", FOLDER_ID, "--company-id", COMPANY_ID]);
    await run(["folder", "update", FOLDER_ID, "--company-id", COMPANY_ID, "--name", "Eng"]);
    await run(["folder", "delete", FOLDER_ID, "--company-id", COMPANY_ID, "--yes"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}`],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}`],
      ["DELETE", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}`],
    ]);
  });

  it("folder move uses the move endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["folder", "move", FOLDER_ID, "--company-id", COMPANY_ID, "-p", PARENT_ID]);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}/move`,
    );
  });

  it("folder agents lists agents in a folder", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ agents: [{ id: "a1", name: "Bot", adapterType: "hermes_local", status: "idle", folderId: null }] }))
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["folder", "agents", FOLDER_ID, "--company-id", COMPANY_ID]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}/agents`,
    );
  });

  it("folder instructions-bundle reads the merged bundle", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ folderId: FOLDER_ID, folderName: "Eng", content: "# AGENTS" }))
    );
    vi.stubGlobal("fetch", fetchMock);

    await run(["folder", "instructions-bundle", FOLDER_ID, "--company-id", COMPANY_ID]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}/instructions-bundle`,
    );
  });

  it("folder delete --force cascades via recursive deletes", async () => {
    // The list endpoint returns all folders for the company; deleteTree
    // filters client-side for direct children. We return one child for the
    // target folder, then an empty child-set for the child itself.
    const childId = "child-1";
    const listBody = (parentId: string | null) => ({
      folders: parentId === FOLDER_ID
        ? [{ id: childId, name: "Child", parentId: FOLDER_ID, sortOrder: 0 }]
        : [],
      totalCount: parentId === FOLDER_ID ? 1 : 0,
    });
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        // Extract parentId query param
        const u = new URL(url);
        const parentId = u.searchParams.get("parentId");
        return Promise.resolve(jsonResponse(listBody(parentId)));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["folder", "delete", FOLDER_ID, "--company-id", COMPANY_ID, "--force", "--yes"]);
    // Master delegates force-delete to the server via ?force=true query param
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}?force=true`,
    );
  });
});
