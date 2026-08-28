import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdapterCommands } from "../commands/client/adapter.js";
import { registerAssetCommands } from "../commands/client/asset.js";
import { registerCompanyCommands, resolveExportOutputPath } from "../commands/client/company.js";
import { registerSkillCommands } from "../commands/client/skill.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const SKILL_ID = "33333333-3333-4333-8333-333333333333";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCompanyCommands(program);
  registerAdapterCommands(program);
  registerAssetCommands(program);
  registerSkillCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

describe("admin, asset, and skill parity commands", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    tempDir = await mkdtemp(path.join(tmpdir(), "paperclip-cli-parity-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("wraps company management and raw portability endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["company", "stats"]);
    await run(["company", "create", "--payload-json", "{}"]);
    await run(["company", "update", COMPANY_ID, "--payload-json", "{}"]);
    await run(["company", "branding:update", COMPANY_ID, "--payload-json", "{}"]);
    await run(["company", "archive", COMPANY_ID]);
    await run(["company", "export:preview", COMPANY_ID, "--payload-json", "{}"]);
    await run(["company", "export:api", COMPANY_ID, "--payload-json", "{}"]);
    await run(["company", "import:preview", COMPANY_ID, "--payload-json", "{}"]);
    await run(["company", "import:apply", COMPANY_ID, "--payload-json", "{}"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/companies/stats"],
      ["POST", "http://localhost:3100/api/companies"],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}`],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}/branding`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/archive`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/exports/preview`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/exports`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/imports/preview`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/imports/apply`],
    ]);
  });

  it("wraps adapter management and company adapter endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["adapter", "list"]);
    await run(["adapter", "install", "--payload-json", "{\"packageName\":\"adapter\"}"]);
    await run(["adapter", "get", "codex_local"]);
    await run(["adapter", "get", "codex/local"]);
    await run(["adapter", "update", "codex_local", "--payload-json", "{\"disabled\":true}"]);
    await run(["adapter", "override", "codex_local", "--payload-json", "{\"paused\":true}"]);
    await run(["adapter", "reload", "codex_local"]);
    await run(["adapter", "reinstall", "codex_local"]);
    await run(["adapter", "config-schema", "codex_local"]);
    await run(["adapter", "ui-parser", "codex_local"]);
    await run(["adapter", "models", "codex_local", "--company-id", COMPANY_ID, "--refresh", "--environment-id", "env-1"]);
    await run(["adapter", "model-profiles", "codex_local", "--company-id", COMPANY_ID]);
    await run(["adapter", "detect-model", "codex_local", "--company-id", COMPANY_ID]);
    await run(["adapter", "test-environment", "codex_local", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["adapter", "delete", "codex_local"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/adapters"],
      ["POST", "http://localhost:3100/api/adapters/install"],
      ["GET", "http://localhost:3100/api/adapters/codex_local"],
      ["GET", "http://localhost:3100/api/adapters/codex%2Flocal"],
      ["PATCH", "http://localhost:3100/api/adapters/codex_local"],
      ["PATCH", "http://localhost:3100/api/adapters/codex_local/override"],
      ["POST", "http://localhost:3100/api/adapters/codex_local/reload"],
      ["POST", "http://localhost:3100/api/adapters/codex_local/reinstall"],
      ["GET", "http://localhost:3100/api/adapters/codex_local/config-schema"],
      ["GET", "http://localhost:3100/api/adapters/codex_local/ui-parser.js"],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/adapters/codex_local/models?refresh=true&environmentId=env-1`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/adapters/codex_local/model-profiles`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/adapters/codex_local/detect-model`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/adapters/codex_local/test-environment`],
      ["DELETE", "http://localhost:3100/api/adapters/codex_local"],
    ]);
  });

  it("wraps asset upload/download endpoints", async () => {
    const imagePath = path.join(tempDir, "logo.png");
    const outputPath = path.join(tempDir, "asset.bin");
    await writeFile(imagePath, Buffer.from("png"));
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ assetId: ASSET_ID }, { status: 201 })))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ assetId: ASSET_ID }, { status: 201 })))
      .mockImplementationOnce(() => Promise.resolve(new Response("asset-bytes")));
    vi.stubGlobal("fetch", fetchMock);

    await run(["asset", "image:upload", "--company-id", COMPANY_ID, "--file", imagePath, "--namespace", "docs", "--alt", "Logo"]);
    await run(["asset", "logo:upload", "--company-id", COMPANY_ID, "--file", imagePath]);
    await run(["asset", "content", ASSET_ID, "--out", outputPath]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/assets/images`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/logo`],
      ["GET", `http://localhost:3100/api/assets/${ASSET_ID}/content`],
    ]);
    const firstUpload = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect((firstUpload.get("file") as File).type).toBe("image/png");
  });

  it("rejects portable export paths outside the output directory", async () => {
    expect(() => resolveExportOutputPath(tempDir, "../outside.md")).toThrow("outside output directory");
  });

  it("wraps company skill endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["skill", "list", "--company-id", COMPANY_ID]);
    await run(["skill", "get", SKILL_ID, "--company-id", COMPANY_ID]);
    await run(["skill", "file", SKILL_ID, "--company-id", COMPANY_ID, "--path", "SKILL.md"]);
    await run(["skill", "create", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["skill", "file:update", SKILL_ID, "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["skill", "import", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["skill", "scan-projects", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["skill", "update-status", SKILL_ID, "--company-id", COMPANY_ID]);
    await run(["skill", "install-update", SKILL_ID, "--company-id", COMPANY_ID]);
    await run(["skill", "delete", SKILL_ID, "--company-id", COMPANY_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/skills`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/skills/${SKILL_ID}`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/skills/${SKILL_ID}/files?path=SKILL.md`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/skills`],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}/skills/${SKILL_ID}/files`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/skills/import`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/skills/scan-projects`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/skills/${SKILL_ID}/update-status`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/skills/${SKILL_ID}/install-update`],
      ["DELETE", `http://localhost:3100/api/companies/${COMPANY_ID}/skills/${SKILL_ID}`],
    ]);
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
