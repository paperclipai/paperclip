import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";

import { testEnvironment } from "./test.js";

const providerEnvKeys = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
];

async function withHermesHomeConfig(
  configLines: string[],
  fn: () => Promise<void>,
) {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  const hermesDir = join(tempHome, ".hermes");
  const configPath = join(hermesDir, "config.yaml");

  await mkdir(hermesDir, { recursive: true });
  await writeFile(configPath, `${configLines.join("\n")}\n`, "utf8");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  for (const key of providerEnvKeys) {
    delete process.env[key];
  }

  try {
    await fn();
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

test("DEBUG: command-resolution inspect", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hermes-command-resolution-"));
  const cliPath = join(tempDir, "fake-hermes");
  await writeFile(cliPath, "#!/bin/sh\necho fake-hermes 1.2.3\n", "utf8");
  await chmod(cliPath, 0o755);
  try {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: { command: cliPath },
    });
    console.log("DEBUG-CMDSTATUS:", result.status);
    console.log("DEBUG-CMDCHECKS:", JSON.stringify(result.checks));
    expect(true).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("DEBUG: detect-model supported provider inspect", async () => {
  await withHermesHomeConfig([
    "model:",
    "  default: openrouter/gpt-4.1-mini",
    "  provider: openrouter",
    "  api_key: test-secret",
  ], async () => {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: { hermesCommand: "python3", model: "openrouter/gpt-4.1-mini" },
    });
    console.log("DEBUG-MODSTATUS:", result.status);
    console.log("DEBUG-MODCHECKS:", JSON.stringify(result.checks));
    expect(true).toBe(true);
  });
});
