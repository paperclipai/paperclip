import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeLocalReasoningEffortsForModel, models as claudeFallbackModels } from "../index.js";
import {
  listClaudeModels,
  refreshClaudeModels,
  resetClaudeModelsCacheForTests,
  resolveClaudeReasoningEfforts,
} from "./models.js";

async function makeOverrideFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-catalog-"));
  const file = path.join(dir, "claude.json");
  await fs.writeFile(file, content, "utf8");
  return file;
}

describe("claude_local model catalog override", () => {
  const dirsToClean: string[] = [];

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE;
    resetClaudeModelsCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE;
    resetClaudeModelsCacheForTests();
    await Promise.all(dirsToClean.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("uses the bundled default when no override file is configured", async () => {
    const models = await listClaudeModels();
    expect(models).toEqual(claudeFallbackModels);
  });

  it("uses the bundled default when the override file does not exist", async () => {
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = path.join(os.tmpdir(), "does-not-exist-claude.json");
    const models = await listClaudeModels();
    expect(models).toEqual(claudeFallbackModels);
  });

  it("replaces the model list with a valid override file", async () => {
    const file = await makeOverrideFile(JSON.stringify({
      version: 1,
      direct: [{ id: "claude-operator-model", label: "Operator Model" }],
      bedrock: [],
    }));
    dirsToClean.push(path.dirname(file));
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;

    const models = await listClaudeModels();
    expect(models).toEqual([{ id: "claude-operator-model", label: "Operator Model" }]);
  });

  it("falls back to the bundled default and warns on malformed JSON", async () => {
    const file = await makeOverrideFile("{not json");
    dirsToClean.push(path.dirname(file));
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const models = await listClaudeModels();

    expect(models).toEqual(claudeFallbackModels);
    expect(warnSpy).toHaveBeenCalledWith(
      "[paperclip] Claude model catalog override invalid, using bundled defaults",
      expect.objectContaining({ path: file }),
    );
  });

  it("falls back to the bundled default and warns when the file fails schema validation", async () => {
    const file = await makeOverrideFile(JSON.stringify({ direct: [{ id: "x" }] }));
    dirsToClean.push(path.dirname(file));
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const models = await listClaudeModels();

    expect(models).toEqual(claudeFallbackModels);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("retries a transient read error on the next lookup, without caching it by mtime", async () => {
    const file = await makeOverrideFile(JSON.stringify({
      version: 1,
      direct: [{ id: "claude-operator-model", label: "Operator Model" }],
      bedrock: [],
    }));
    dirsToClean.push(path.dirname(file));
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readSpy = vi.spyOn(syncFs, "readFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });

    const first = await listClaudeModels();
    expect(first).toEqual(claudeFallbackModels);
    expect(warnSpy).toHaveBeenCalledWith(
      "[paperclip] Claude model catalog override unreadable, using bundled defaults",
      expect.objectContaining({ path: file }),
    );

    readSpy.mockRestore();

    // Same file, same mtime (it never changed) — still recovers because a read
    // error isn't cached the way a parse/validation error is.
    const second = await listClaudeModels();
    expect(second).toEqual([{ id: "claude-operator-model", label: "Operator Model" }]);
  });

  it("re-reads the override file only after its mtime changes", async () => {
    const file = await makeOverrideFile(JSON.stringify({
      version: 1,
      direct: [{ id: "claude-operator-model-v1", label: "Operator Model v1" }],
      bedrock: [],
    }));
    dirsToClean.push(path.dirname(file));
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;

    const first = await listClaudeModels();
    expect(first).toEqual([{ id: "claude-operator-model-v1", label: "Operator Model v1" }]);

    // Overwrite without changing mtime enough to register: still returns the cached value.
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      direct: [{ id: "claude-operator-model-v2", label: "Operator Model v2" }],
      bedrock: [],
    }), "utf8");
    // Force a distinct mtime (some filesystems have 1s+ mtime resolution).
    const bumped = new Date(Date.now() + 5000);
    await fs.utimes(file, bumped, bumped);

    const second = await listClaudeModels();
    expect(second).toEqual([{ id: "claude-operator-model-v2", label: "Operator Model v2" }]);
  });

  it("uses the override's bedrock list in Bedrock mode", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const file = await makeOverrideFile(JSON.stringify({
      version: 1,
      direct: [],
      bedrock: [{ id: "us.anthropic.claude-operator-model", label: "Operator Bedrock Model" }],
    }));
    dirsToClean.push(path.dirname(file));
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;

    const models = await listClaudeModels();
    expect(models).toEqual([{ id: "us.anthropic.claude-operator-model", label: "Operator Bedrock Model" }]);
  });

  it("merges live Anthropic discovery over the override, live results taking precedence", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const file = await makeOverrideFile(JSON.stringify({
      version: 1,
      direct: [{ id: "claude-operator-model", label: "Stale Operator Label" }],
      bedrock: [],
    }));
    dirsToClean.push(path.dirname(file));
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "claude-operator-model", display_name: "Live Operator Label" }],
      }),
    } as Response);

    const models = await listClaudeModels();

    expect(models).toContainEqual({ id: "claude-operator-model", label: "Live Operator Label" });
    expect(models.filter((model) => model.id === "claude-operator-model")).toHaveLength(1);
  });

  it("surfaces a catalog entry's efforts on the model list", async () => {
    const file = await makeOverrideFile(JSON.stringify({
      version: 1,
      direct: [{ id: "claude-operator-model", label: "Operator Model", efforts: ["low", "medium", "high", "xhigh"] }],
      bedrock: [],
    }));
    dirsToClean.push(path.dirname(file));
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;

    const models = await listClaudeModels();
    expect(models).toEqual([
      { id: "claude-operator-model", label: "Operator Model", efforts: ["low", "medium", "high", "xhigh"] },
    ]);
  });

  it("preserves the override's efforts when live Anthropic discovery returns the same id", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const file = await makeOverrideFile(JSON.stringify({
      version: 1,
      direct: [{ id: "claude-operator-model", label: "Stale Label", efforts: ["low", "medium", "high", "xhigh"] }],
      bedrock: [],
    }));
    dirsToClean.push(path.dirname(file));
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "claude-operator-model", display_name: "Live Operator Label" }],
      }),
    } as Response);

    const models = await listClaudeModels();

    expect(models).toContainEqual({
      id: "claude-operator-model",
      label: "Live Operator Label",
      efforts: ["low", "medium", "high", "xhigh"],
    });
  });

  describe("resolveClaudeReasoningEfforts", () => {
    it("matches the client-bundled lookup when no override is configured", () => {
      for (const model of ["claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-4-5", "claude-haiku-4-5", "custom-model"]) {
        expect(resolveClaudeReasoningEfforts(model)).toEqual(claudeLocalReasoningEffortsForModel(model));
      }
    });

    it("grants an operator-added effort level from the override file", async () => {
      const file = await makeOverrideFile(JSON.stringify({
        version: 1,
        direct: [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", efforts: ["low", "medium", "high", "xhigh"] }],
        bedrock: [],
      }));
      dirsToClean.push(path.dirname(file));
      process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;

      expect(resolveClaudeReasoningEfforts("claude-haiku-4-5")).toEqual(["low", "medium", "high", "xhigh"]);
    });
  });

  it("refreshClaudeModels re-reads the override file on demand", async () => {
    const file = await makeOverrideFile(JSON.stringify({
      version: 1,
      direct: [{ id: "claude-operator-model-a", label: "A" }],
      bedrock: [],
    }));
    dirsToClean.push(path.dirname(file));
    process.env.PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE = file;

    const first = await listClaudeModels();
    expect(first).toEqual([{ id: "claude-operator-model-a", label: "A" }]);

    const bumped = new Date(Date.now() + 5000);
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      direct: [{ id: "claude-operator-model-b", label: "B" }],
      bedrock: [],
    }), "utf8");
    await fs.utimes(file, bumped, bumped);

    const refreshed = await refreshClaudeModels();
    expect(refreshed).toEqual([{ id: "claude-operator-model-b", label: "B" }]);
  });
});
