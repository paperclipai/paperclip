import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverPiModelsCached,
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

async function writeFakePi(pathToFile: string, body: string): Promise<void> {
  await fs.writeFile(pathToFile, body, "utf8");
  await fs.chmod(pathToFile, 0o755);
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

  it("falls back to stale cached models when discovery later times out", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-models-"));
    const piPath = path.join(root, "pi");

    await writeFakePi(
      piPath,
      `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.error("provider  model");
  console.error("openai    gpt-4.1-mini");
  process.exit(0);
}
process.exit(1);
`,
    );

    const first = await discoverPiModelsCached({
      command: piPath,
      cwd: root,
      env: {},
    });
    expect(first.some((m) => m.id === "openai/gpt-4.1-mini")).toBe(true);

    await writeFakePi(
      piPath,
      `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  // Keep process alive until timeout to simulate transient runtime slowness.
  setTimeout(() => process.exit(0), 60_000);
}
`,
    );

    const second = await discoverPiModelsCached({
      command: piPath,
      cwd: root,
      env: {},
    });
    expect(second.some((m) => m.id === "openai/gpt-4.1-mini")).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });
});
