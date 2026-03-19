import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverOpenCodeAgents,
  discoverOpenCodeModels,
  ensureOpenCodeAgentConfiguredAndAvailable,
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeAgents,
  listOpenCodeModels,
  resolveConfiguredOpenCodeAgentModel,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

async function withMockOpenCodeCommand(
  stdout: string,
  run: (commandPath: string, cwd: string) => Promise<void>,
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-models-"));
  const commandPath = path.join(cwd, "opencode-mock.sh");
  await fs.writeFile(
    commandPath,
    [
      "#!/usr/bin/env bash",
      "if [ \"$1\" = \"models\" ]; then",
      "cat <<'__OPENCODE_MODELS__'",
      stdout,
      "__OPENCODE_MODELS__",
      "exit 0",
      "fi",
      "echo \"unexpected args: $*\" >&2",
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(commandPath, 0o755);

  try {
    await run(commandPath, cwd);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

describe("openCode models", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-models-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    vi.spyOn(os, "userInfo").mockReturnValue({
      uid: 1000,
      gid: 1000,
      username: "paperclip-test",
      homedir: tempHome,
      shell: "/bin/sh",
    });
    resetOpenCodeModelsCacheForTests();
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetOpenCodeModelsCacheForTests();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  async function writeGlobalConfig(filename: "opencode.json" | "opencode.jsonc", contents: string) {
    const configPath = path.join(tempHome, ".config", "opencode", filename);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, contents, "utf8");
    return configPath;
  }

  it("returns an empty list when discovery command is unavailable and no config models exist", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("falls back to ~/.config/opencode/opencode.jsonc when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await writeGlobalConfig(
      "opencode.jsonc",
      [
        "{",
        "  // Global OpenCode config",
        "  \"provider\": {",
        "    \"litellm\": {",
        "      \"models\": {",
        "        \"omnicoder-9b\": {},",
        "        \"qwen3.5-122b-a10b\": {},",
        "      },",
        "    },",
        "  },",
        "}",
        "",
      ].join("\n"),
    );

    await expect(listOpenCodeModels()).resolves.toEqual([
      { id: "litellm/omnicoder-9b", label: "litellm/omnicoder-9b" },
      { id: "litellm/qwen3.5-122b-a10b", label: "litellm/qwen3.5-122b-a10b" },
    ]);
  });

  it("falls back to ~/.config/opencode/opencode.jsonc for agent profiles when agent list is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await writeGlobalConfig(
      "opencode.jsonc",
      [
        "{",
        "  \"default_agent\": \"plan\",",
        "  \"agent\": {",
        "    \"plan\": {},",
        "    \"code-reviewer\": {",
        "      \"model\": \"anthropic/claude-sonnet-4-5\"",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    await expect(listOpenCodeAgents()).resolves.toEqual([
      { id: "code-reviewer", label: "code-reviewer" },
      { id: "plan", label: "plan" },
    ]);
  });

  it("auto-detects the default ~/.opencode/bin/opencode install", async () => {
    const binDir = path.join(tempHome, ".opencode", "bin");
    const opencodePath = path.join(binDir, "opencode");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      opencodePath,
      [
        "#!/bin/sh",
        "echo 'litellm/qwen3.5-122b-a10b'",
        "echo 'litellm/omnicoder-9b'",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(opencodePath, 0o755);

    await expect(discoverOpenCodeModels({ cwd: tempHome })).resolves.toEqual([
      { id: "litellm/omnicoder-9b", label: "litellm/omnicoder-9b" },
      { id: "litellm/qwen3.5-122b-a10b", label: "litellm/qwen3.5-122b-a10b" },
    ]);
  });

  it("parses `opencode agent list` output", async () => {
    const binDir = path.join(tempHome, ".opencode", "bin");
    const opencodePath = path.join(binDir, "opencode");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      opencodePath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"agent\" ] && [ \"$2\" = \"list\" ]; then",
        "  echo 'Available Agents:'",
        "  echo '- default (Default agent)'",
        "  echo '- code-reviewer (Agent with custom prompt)'",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(opencodePath, 0o755);

    await expect(discoverOpenCodeAgents({ cwd: tempHome })).resolves.toEqual([
      { id: "code-reviewer", label: "code-reviewer" },
      { id: "default", label: "default" },
    ]);
  });

  it("accepts configured models from the global OpenCode config fallback", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await writeGlobalConfig(
      "opencode.json",
      JSON.stringify({
        provider: {
          litellm: {
            models: {
              "omnicoder-9b": {},
            },
          },
        },
      }),
    );

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "litellm/omnicoder-9b" }),
    ).resolves.toEqual([
      { id: "litellm/omnicoder-9b", label: "litellm/omnicoder-9b" },
    ]);
  });

  it("accepts configured agent profiles from the global OpenCode config fallback", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await writeGlobalConfig(
      "opencode.json",
      JSON.stringify({
        default_agent: "plan",
        agent: {
          plan: {},
          reviewer: {},
        },
      }),
    );

    await expect(
      ensureOpenCodeAgentConfiguredAndAvailable({ agent: "reviewer" }),
    ).resolves.toEqual([
      { id: "plan", label: "plan" },
      { id: "reviewer", label: "reviewer" },
    ]);
  });

  it("resolves an agent profile model from OpenCode config", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await writeGlobalConfig(
      "opencode.json",
      JSON.stringify({
        agent: {
          plan: {
            model: "litellm/omnicoder-9b",
          },
        },
      }),
    );

    await expect(resolveConfiguredOpenCodeAgentModel({ agent: "plan" })).resolves.toBe(
      "litellm/omnicoder-9b",
    );
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("rejects when agent profile is missing", async () => {
    await expect(
      ensureOpenCodeAgentConfiguredAndAvailable({ agent: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.agent`");
  });

  it("parses plain model ids from `opencode models` output", async () => {
    await withMockOpenCodeCommand(
      [
        "Available models",
        "qwen3-coder-next",
        "gemma-3-27b-it",
      ].join("\n"),
      async (commandPath, cwd) => {
        const models = await discoverOpenCodeModels({ command: commandPath, cwd });
        expect(models).toEqual([
          { id: "gemma-3-27b-it", label: "gemma-3-27b-it" },
          { id: "qwen3-coder-next", label: "qwen3-coder-next" },
        ]);
      },
    );
  });

  it("parses table-style output that mixes provider/model and plain ids", async () => {
    await withMockOpenCodeCommand(
      [
        "| Model | Provider |",
        "| --- | --- |",
        "| litellm/qwen3-coder-next | litellm |",
        "| o3-mini | openai |",
      ].join("\n"),
      async (commandPath, cwd) => {
        const models = await discoverOpenCodeModels({ command: commandPath, cwd });
        expect(models).toEqual([
          { id: "litellm/qwen3-coder-next", label: "litellm/qwen3-coder-next" },
          { id: "o3-mini", label: "o3-mini" },
        ]);
      },
    );
  });
});
