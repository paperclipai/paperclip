import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverPiModels,
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

const SERVER_ONLY_ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "PGPASSWORD",
  "BETTER_AUTH_SECRET",
] as const;

async function createPiEnvironmentProbe() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-env-"));
  const probePath = path.join(root, "pi-env-probe.js");
  await writeFile(
    probePath,
    `const forbidden = ${JSON.stringify(SERVER_ONLY_ENV_KEYS)};
if (forbidden.some((key) => process.env[key])) process.exit(1);
if (process.env.OPENAI_API_KEY !== "agent-provider-key") process.exit(2);
process.stdout.write("openai  gpt-test\\n");
`,
  );
  return { probePath, root };
}

async function withHostEnvironment<T>(
  values: Record<string, string>,
  action: () => Promise<T>,
): Promise<T> {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });

  it("does not pass host server credentials to model discovery", async () => {
    const probe = await createPiEnvironmentProbe();
    try {
      await expect(
        withHostEnvironment(
          {
            DATABASE_URL: "postgres://control-plane",
            DATABASE_MIGRATION_URL: "postgres://migration-role",
            PGPASSWORD: "database-password",
            BETTER_AUTH_SECRET: "auth-secret",
          },
          () =>
            discoverPiModels({
              command: process.execPath,
              args: [probe.probePath],
              env: { OPENAI_API_KEY: "agent-provider-key" },
            }),
        ),
      ).resolves.toEqual([{ id: "openai/gpt-test", label: "openai/gpt-test" }]);
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  });
});
