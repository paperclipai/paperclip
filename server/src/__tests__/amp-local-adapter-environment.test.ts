import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-amp-local/server";

const ORIGINAL_AMP_API_KEY = process.env.AMP_API_KEY;

afterEach(() => {
  if (ORIGINAL_AMP_API_KEY === undefined) {
    delete process.env.AMP_API_KEY;
  } else {
    process.env.AMP_API_KEY = ORIGINAL_AMP_API_KEY;
  }
});

describe("amp_local environment diagnostics", () => {
  it("returns info when AMP_API_KEY is set in host environment", async () => {
    process.env.AMP_API_KEY = "amp-test-key";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "amp_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
      },
    });

    expect(
      result.checks.some(
        (check) =>
          check.code === "amp_api_key_present" &&
          check.level === "info",
      ),
    ).toBe(true);
  });

  it("returns info when AMP_API_KEY is set in adapter env config", async () => {
    delete process.env.AMP_API_KEY;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "amp_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
        env: {
          AMP_API_KEY: "amp-config-key",
        },
      },
    });

    expect(
      result.checks.some(
        (check) =>
          check.code === "amp_api_key_present" &&
          check.level === "info",
      ),
    ).toBe(true);
  });

  it("warns when AMP_API_KEY is not set", async () => {
    delete process.env.AMP_API_KEY;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "amp_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
      },
    });

    expect(
      result.checks.some(
        (check) =>
          check.code === "amp_api_key_missing" &&
          check.level === "warn",
      ),
    ).toBe(true);
  });

  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-amp-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "amp_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "amp_cwd_valid")).toBe(true);
    // The probe may fail (node is not amp), but cwd-related checks should not error
    expect(
      result.checks.some((check) => check.code === "amp_cwd_invalid"),
    ).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });
});
