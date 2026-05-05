import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPENCODE_LOCAL_MODEL,
  models as curatedModels,
  modelProfiles,
} from "../index.js";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });
});

describe("opencode-local curated defaults (issue #5132)", () => {
  // Hire-time defaults must route through the `opencode/*` provider so they
  // succeed for both ChatGPT-OAuth and api-key auth. `openai/*` ids are gated
  // by the OAuth allowlist and 400 for OAuth-only users at adapter startup.

  it("ships a Zen-routed (opencode/*) default model", () => {
    expect(DEFAULT_OPENCODE_LOCAL_MODEL).toMatch(/^opencode\//);
  });

  it("only exposes opencode/* entries in the curated model list", () => {
    expect(curatedModels.length).toBeGreaterThan(0);
    for (const entry of curatedModels) {
      expect(entry.id, `curated model ${entry.id} must use opencode/* prefix`)
        .toMatch(/^opencode\//);
      expect(entry.label, `curated label for ${entry.id} should match its id prefix`)
        .toMatch(/^opencode\//);
    }
  });

  it("includes the default in the curated list", () => {
    expect(curatedModels.some((entry) => entry.id === DEFAULT_OPENCODE_LOCAL_MODEL)).toBe(true);
  });

  it("ships a Zen-routed cheap-profile model", () => {
    const cheap = modelProfiles.find((profile) => profile.key === "cheap");
    expect(cheap, "cheap model profile is defined").toBeDefined();
    const cheapModel = cheap?.adapterConfig?.model;
    expect(typeof cheapModel === "string" ? cheapModel : "")
      .toMatch(/^opencode\//);
  });
});
