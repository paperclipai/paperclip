import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-hermes-local/server";

describe("hermes_local environment diagnostics", () => {
  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-hermes-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "hermes_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("runs the hello probe when Hermes is available on PATH", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-hermes-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const fakeHermes = path.join(binDir, "hermes");
    const script = `#!/bin/sh
printf '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮\n'
printf 'hello\n'
printf '╰──────────────────────────────────────────────────────────────────────────────╯\n'
printf 'Session:        20260310_000000_test\n'
`;

    try {
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(fakeHermes, script, { encoding: "utf8", mode: 0o755 });

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "hermes_local",
        config: {
          command: "hermes",
          cwd,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "hermes_hello_probe_passed")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
