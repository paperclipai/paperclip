import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-qwen-local/server";

describe("qwen_local environment diagnostics", () => {
  it("reports a missing working directory as an error when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-qwen-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "qwen_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "qwen_cwd_invalid")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("warns when auth is missing but command exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-qwen-env-"));
    const fakeQwen = path.join(cwd, "qwen");
    await fs.writeFile(fakeQwen, "#!/bin/sh\necho '{\"ok\":true}'\n", "utf8");
    await fs.chmod(fakeQwen, 0o755);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "qwen_local",
      config: {
        command: fakeQwen,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "qwen_auth_missing")).toBe(true);
    expect(result.status).toBe("warn");
  });
});
