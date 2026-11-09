import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

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

  it("does not embed the model catalogue when the configured model is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-pi-models-"));
    const command = join(directory, "pi");
    const modelIds = Array.from({ length: 13 }, (_, index) => `provider/model-${index}`);
    await writeFile(
      command,
      `#!/bin/sh\nprintf 'provider  model\\n';\n${modelIds
        .map((id) => {
          const [provider, model] = id.split("/");
          return `printf '${provider}  ${model}\\n'`;
        })
        .join(";\n")}\n`,
    );
    await chmod(command, 0o755);

    try {
      await expect(
        ensurePiModelConfiguredAndAvailable({
          command,
          model: "provider/missing",
        }),
      ).rejects.toMatchObject({
        message:
          "Configured Pi model is unavailable: provider/missing. 13 models are available; list them with `pi --list-models`.",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("injects PAPERCLIP_PI_PROVIDERS providers into discovery via a managed models.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-pi-providers-"));
    const command = join(directory, "pi");
    await writeFile(
      command,
      `#!/bin/sh\nif [ -f "$PI_CODING_AGENT_DIR/models.json" ]; then\n  printf 'provider  model\\n'\n  printf 'llm2  qwen3.8-27b-w4a16\\n'\nelse\n  printf 'No models available.\\n' >&2\n  exit 1\nfi\n`,
    );
    await chmod(command, 0o755);

    process.env.PAPERCLIP_PI_COMMAND = command;
    process.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify({
      llm2: {
        name: "test provider",
        baseUrl: "https://example.com/v1",
        apiKey: "test-key",
        models: [{ id: "qwen3.8-27b-w4a16" }],
      },
    });

    try {
      const models = await listPiModels();
      expect(models.map((model) => model.id)).toContain("llm2/qwen3.8-27b-w4a16");
    } finally {
      delete process.env.PAPERCLIP_PI_PROVIDERS;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
