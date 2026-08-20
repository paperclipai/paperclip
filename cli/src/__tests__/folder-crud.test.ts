import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFolderCommands } from "../commands/client/folder.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const FOLDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_ID_1 = "11111111-1111-4111-8111-111111111111";
const AGENT_ID_2 = "22222222-2222-4222-8222-222222222222";

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
    "--company-id", COMPANY_ID,
  ], { from: "user" });
}

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

describe("folder CRUD commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps folder CRUD and assignment endpoints", async () => {
    const MOCK_FOLDER = {
      id: FOLDER_ID, name: "Test Folder", slug: "test-folder", parentId: null,
      companyId: COMPANY_ID, sortOrder: 0, metadata: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
    const MOCK_AGENT_LIST = {
      folderId: FOLDER_ID, folderName: "Test Folder",
      agents: [{ id: AGENT_ID_1, name: "Agent1", adapterType: "codex", status: "idle", folderId: FOLDER_ID }],
    };
    const MOCK_ASSIGN = { ok: true };

    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/agent-folders/") && url.includes("/agents")) {
        return Promise.resolve(jsonResponse(MOCK_AGENT_LIST));
      }
      if (url.includes("/agent-folders/") && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ deleted: true }));
      }
      if (url.includes("/agent-folders/") && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse(MOCK_FOLDER));
      }
      if (url.includes("/agent-folders/") && init?.method === "GET") {
        return Promise.resolve(jsonResponse(MOCK_FOLDER));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse(MOCK_FOLDER));
      }
      return Promise.resolve(jsonResponse(MOCK_FOLDER));
    });
    vi.stubGlobal("fetch", fetchMock);

    await run(["folder", "create", "--name", "Research Team", "--slug", "research"]);
    await run(["folder", "create", "--name", "Sub-team", "--parent-id", PARENT_ID, "--metadata", JSON.stringify({ region: "us-west" })]);
    await run(["folder", "get", FOLDER_ID]);
    await run(["folder", "update", FOLDER_ID, "--name", "Renamed Folder"]);
    await run(["folder", "update", FOLDER_ID, "--metadata", "null"]);
    await run(["folder", "delete", FOLDER_ID, "--yes"]);
    await run(["folder", "delete", FOLDER_ID, "--yes", "--force"]);
    await run(["folder", "agents", FOLDER_ID]);
    await run(["folder", "assign", "--folder-id", FOLDER_ID, "--agent-ids", `${AGENT_ID_1},${AGENT_ID_2}`]);

    const calls = fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]]);
    expect(calls).toEqual([
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}`],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}`],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}`],
      ["DELETE", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}`],
      ["DELETE", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}?force=true`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}/agents`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-folders/${FOLDER_ID}/agents`],
    ]);
  });

  it("create sends name, slug, parentId, sortOrder, and metadata", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      id: FOLDER_ID, name: "Research Team", slug: "research", parentId: null, sortOrder: 0,
    })));
    vi.stubGlobal("fetch", fetchMock);

    await run(["folder", "create", "--name", "Research Team", "--slug", "research", "--parent-id", PARENT_ID, "--metadata", '{"region":"us-west"}', "--sort-order", "5"]);

    const postCall = fetchMock.mock.calls[0];
    expect(postCall[1]?.method).toBe("POST");
    expect(postCall[1]?.body).toBe(JSON.stringify({
      name: "Research Team",
      slug: "research",
      parentId: PARENT_ID,
      sortOrder: 5,
      metadata: { region: "us-west" },
    }));
  });

  it("delete without --yes exits without calling API", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    // handleCommandError calls process.exit(1) which throws under exitOverride
    await expect(run(["folder", "delete", FOLDER_ID])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("get renders a human-readable line", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      id: FOLDER_ID, name: "Ops", slug: "ops", parentId: null, sortOrder: 2, metadata: null,
    })));
    vi.stubGlobal("fetch", fetchMock);

    await run(["folder", "get", FOLDER_ID]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("name=Ops"),
    );
  });

  it("json flag outputs raw JSON", async () => {
    const mockFolder = {
      id: FOLDER_ID, name: "Ops", slug: "ops", parentId: null, sortOrder: 2, metadata: null,
    };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(mockFolder)));
    vi.stubGlobal("fetch", fetchMock);

    const logSpy = vi.spyOn(console, "log");

    await run(["folder", "get", FOLDER_ID, "--json"]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(mockFolder, null, 2));
  });
});
