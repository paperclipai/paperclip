import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterModel } from "@penclipai/adapter-utils";
import { resetCodeBuddyModelsCacheForTests } from "@penclipai/adapter-codebuddy-local/server";
import { models as codexFallbackModels } from "@penclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@penclipai/adapter-cursor-local";
import { models as opencodeFallbackModels } from "@penclipai/adapter-opencode-local";
import { resetOpenCodeModelsCacheForTests } from "@penclipai/adapter-opencode-local/server";
import { listAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";

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

describe("adapter model listing", () => {
  const cleanupDirs = new Set<string>();

  beforeEach(() => {
    delete process.env.PAPERCLIP_CODEBUDDY_COMMAND;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetCodeBuddyModelsCacheForTests();
    resetCodexModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("returns codex fallback models when no OpenAI key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads codex models dynamically and merges fallback options", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5-pro")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
  });

  it("falls back to static codex models when OpenAI model discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });


  it("returns cursor fallback models when CLI discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));

    const models = await listAdapterModels("cursor");
    expect(models).toEqual(cursorFallbackModels);
  });

  it("loads codebuddy models dynamically from codebuddy --help and caches the result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codebuddy-adapter-models-"));
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
  console.log([
    "Usage: codebuddy [options]",
    "  --model <model>  Select model. Currently supported: (glm-5.0, glm-4.7, minimax-m2.5, glm-5.0, deepseek-v3-2-volc)",
  ].join("\\n"));
  process.exit(0);
}
process.exit(0);
`,
    );

    const first = await listAdapterModels("codebuddy_local");
    const second = await listAdapterModels("codebuddy_local");

    expect(Number(await fs.readFile(hitsPath, "utf8"))).toBe(1);
    expect(first).toEqual(second);
    expect(first).toEqual(
      expect.arrayContaining<AdapterModel>([
        { id: "glm-5.0", label: "glm-5.0" },
        { id: "glm-4.7", label: "glm-4.7" },
        { id: "minimax-m2.5", label: "minimax-m2.5" },
        { id: "deepseek-v3-2-volc", label: "deepseek-v3-2-volc" },
      ]),
    );
  });

  it("returns an empty list for codebuddy when help parsing fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codebuddy-adapter-models-empty-"));
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

    const models = await listAdapterModels("codebuddy_local");
    expect(models).toEqual([]);
  });

  it("returns opencode fallback models including gpt-5.4", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAdapterModels("opencode_local");

    expect(models).toEqual(opencodeFallbackModels);
  });

  it("loads cursor models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: auto, composer-1.5, gpt-5.3-codex-high, sonnet-4.6",
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const first = await listAdapterModels("cursor");
    const second = await listAdapterModels("cursor");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "auto")).toBe(true);
    expect(first.some((model) => model.id === "gpt-5.3-codex-high")).toBe(true);
    expect(first.some((model) => model.id === "composer-1")).toBe(true);
  });

});
