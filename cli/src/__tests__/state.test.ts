import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/banner.js", () => ({ printPaperclipCliBanner: vi.fn() }));
vi.mock("@clack/prompts", () => ({ intro: vi.fn(), outro: vi.fn() }));

import { stateRestoreCommand } from "../commands/state.js";

const originalEnv = process.env;

describe("state restore command", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ restored: ["agents/a/AGENTS.md"], dryRun: true }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls the company restore API for --from-git", async () => {
    await stateRestoreCommand(undefined, {
      apiUrl: "http://paperclip.test/api",
      token: "token",
      json: true,
      fromGit: "/backup/state.git",
      companyId: "company-1",
      ref: "refs/heads/main",
      dryRun: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company-1/state-repo/restore",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ source: "/backup/state.git", ref: "refs/heads/main", dryRun: true }),
      }),
    );
  });

  it("requires a company for git restores", async () => {
    delete process.env.PAPERCLIP_COMPANY_ID;
    await expect(stateRestoreCommand(undefined, { fromGit: "/backup/state.git" })).rejects.toThrow("--company-id");
  });
});
