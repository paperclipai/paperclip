import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverCodeBuddyModels,
  listCodeBuddyModels,
  resetCodeBuddyModelsCacheForTests,
} from "@penclipai/adapter-codebuddy-local/server";

async function writeFakeCodeBuddyCommand(root: string, scriptBody: string): Promise<string> {
  if (process.platform === "win32") {
    const scriptPath = path.join(root, "codebuddy.js");
    const commandPath = path.join(root, "codebuddy.cmd");
    await fs.writeFile(scriptPath, scriptBody, "utf8");
    await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return commandPath;
  }

  const commandPath = path.join(root, "codebuddy");
  await fs.writeFile(commandPath, `#!/usr/bin/env node\n${scriptBody}`, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("codebuddy model discovery", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    delete process.env.PAPERCLIP_CODEBUDDY_COMMAND;
    resetCodeBuddyModelsCacheForTests();
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("parses the currently supported model list from codebuddy --help", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codebuddy-models-"));
    cleanupDirs.add(root);
    const command = await writeFakeCodeBuddyCommand(
      root,
      `
if (process.argv.includes("--help")) {
  console.log([
    "Usage: codebuddy [options]",
    "  --model <model>  Select model. Currently supported: (glm-5.0, glm-4.7, minimax-m2.7, glm-5.0, deepseek-v3-2-volc)",
  ].join("\\n"));
  process.exit(0);
}
process.exit(0);
`,
    );

    const models = await discoverCodeBuddyModels({ command, cwd: root });
    expect(models.map((model) => model.id)).toEqual([
      "deepseek-v3-2-volc",
      "glm-4.7",
      "glm-5.0",
      "minimax-m2.7",
    ]);
  });

  it("caches model discovery for repeated listCodeBuddyModels calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codebuddy-models-cache-"));
    cleanupDirs.add(root);
    const hitsPath = path.join(root, "hits.txt");
    process.env.PAPERCLIP_CODEBUDDY_COMMAND = await writeFakeCodeBuddyCommand(
      root,
      `
const fs = require("node:fs");
const hitsPath = ${JSON.stringify(hitsPath)};
if (process.argv.includes("--help")) {
  const hits = fs.existsSync(hitsPath) ? Number(fs.readFileSync(hitsPath, "utf8")) : 0;
  fs.writeFileSync(hitsPath, String(hits + 1), "utf8");
  console.log("Usage: codebuddy [options]\\n  --model <model>  Select model. Currently supported: (glm-5.0, kimi-k2.5)");
  process.exit(0);
}
process.exit(0);
`,
    );

    const first = await listCodeBuddyModels();
    const second = await listCodeBuddyModels();

    expect(first).toEqual(second);
    expect(Number(await fs.readFile(hitsPath, "utf8"))).toBe(1);
  });

  it("returns an empty list when help output omits the supported-model section", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codebuddy-models-empty-"));
    cleanupDirs.add(root);
    process.env.PAPERCLIP_CODEBUDDY_COMMAND = await writeFakeCodeBuddyCommand(
      root,
      `
if (process.argv.includes("--help")) {
  console.log("Usage: codebuddy [options]\\n  --model <model>  Select model.");
  process.exit(0);
}
process.exit(0);
`,
    );

    await expect(listCodeBuddyModels()).resolves.toEqual([]);
  });

  it("returns an empty list when the codebuddy help command fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codebuddy-models-fail-"));
    cleanupDirs.add(root);
    process.env.PAPERCLIP_CODEBUDDY_COMMAND = await writeFakeCodeBuddyCommand(
      root,
      `
if (process.argv.includes("--help")) {
  console.error("boom");
  process.exit(1);
}
process.exit(0);
`,
    );

    await expect(listCodeBuddyModels()).resolves.toEqual([]);
  });
});
