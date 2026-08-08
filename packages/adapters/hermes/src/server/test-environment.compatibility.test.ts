import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testEnvironment } from "./test.js";

const providerEnvKeys = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
] as const;

const originalProviderEnv = Object.fromEntries(
  providerEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof providerEnvKeys)[number], string | undefined>;
const originalHomeEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
};

async function createFakeHermesRuntime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-compat-"));
  const binDir = path.join(root, "venv", "bin");
  const hermesHome = path.join(root, "hermes-home");
  const fallbackHome = path.join(root, "ordinary-home");
  const hermesCommand = path.join(binDir, "hermes");
  const pythonCommand = path.join(binDir, "python3");

  await mkdir(binDir, { recursive: true });
  await mkdir(hermesHome, { recursive: true });
  await mkdir(fallbackHome, { recursive: true });
  process.env.HOME = fallbackHome;
  process.env.USERPROFILE = fallbackHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  await writeFile(hermesCommand, "#!/bin/sh\necho fake-hermes 1.2.3\n", "utf8");
  await writeFile(pythonCommand, "#!/bin/sh\necho Python 3.11.15\n", "utf8");
  await chmod(hermesCommand, 0o755);
  await chmod(pythonCommand, 0o755);

  return { root, hermesHome, hermesCommand };
}

async function writeHermesProfile(hermesHome: string) {
  await writeFile(
    path.join(hermesHome, "config.yaml"),
    [
      "model:",
      "  default: openrouter/test-model",
      "  provider: openrouter",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(hermesHome, ".env"),
    "OPENROUTER_API_KEY=test-secret\n",
    "utf8",
  );
}

beforeEach(() => {
  for (const key of providerEnvKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of providerEnvKeys) {
    const value = originalProviderEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const [key, value] of Object.entries(originalHomeEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.sequential("Hermes environment compatibility", () => {
  it.each([
    ["string", (hermesHome: string) => hermesHome],
    ["resolved binding", (hermesHome: string) => ({ value: hermesHome })],
  ])(
    "loads config.yaml and .env from config.env.HERMES_HOME as a %s",
    async (_label, bindHome) => {
      const runtime = await createFakeHermesRuntime();
      try {
        await writeHermesProfile(runtime.hermesHome);

        const result = await testEnvironment({
          companyId: "company-test",
          adapterType: "hermes_local",
          config: {
            hermesCommand: runtime.hermesCommand,
            model: "openrouter/test-model",
            env: { HERMES_HOME: bindHome(runtime.hermesHome) },
          },
        } as any);

        const codes = result.checks.map((check) => check.code);
        expect(codes).toContain("hermes_api_keys_found");
        expect(codes).toContain("hermes_provider_detected");
        expect(codes).not.toContain("hermes_no_api_keys");
        expect(codes).not.toContain("hermes_provider_unknown");
      } finally {
        await rm(runtime.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["hermesCommand", "command"] as const)(
    "uses the sibling python3 for an absolute configured %s",
    async (commandKey) => {
      const runtime = await createFakeHermesRuntime();
      try {
        await writeHermesProfile(runtime.hermesHome);

        const result = await testEnvironment({
          companyId: "company-test",
          adapterType: "hermes_local",
          config: {
            [commandKey]: runtime.hermesCommand,
            model: "openrouter/test-model",
            env: { HERMES_HOME: runtime.hermesHome },
          },
        } as any);

        expect(result.checks.map((check) => check.code)).not.toContain(
          "hermes_python_old",
        );
        expect(result.status).not.toBe("fail");
      } finally {
        await rm(runtime.root, { recursive: true, force: true });
      }
    },
  );

  it("treats provider and model auto as profile-delegation sentinels", async () => {
    const runtime = await createFakeHermesRuntime();
    try {
      await writeHermesProfile(runtime.hermesHome);

      const result = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: {
          hermesCommand: runtime.hermesCommand,
          model: "auto",
          provider: "auto",
          env: { HERMES_HOME: runtime.hermesHome },
        },
      } as any);

      const codes = result.checks.map((check) => check.code);
      expect(codes).toContain("hermes_configured_default_model");
      expect(codes).toContain("hermes_provider_auto");
      expect(codes).not.toContain("hermes_provider_mismatch");
      expect(codes).not.toContain("hermes_provider_unknown");
    } finally {
      await rm(runtime.root, { recursive: true, force: true });
    }
  });
});
