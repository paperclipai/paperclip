import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeConfigHome(initialConfig?: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-"));
  cleanupPaths.add(root);
  const configDir = path.join(root, "opencode");
  await fs.mkdir(configDir, { recursive: true });
  if (initialConfig) {
    await fs.writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

describe("prepareOpenCodeRuntimeConfig", () => {
  it("injects an external_directory allow rule by default", async () => {
    const configHome = await makeConfigHome({
      permission: {
        read: "allow",
      },
      theme: "system",
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    expect(prepared.env.XDG_CONFIG_HOME).not.toBe(configHome);
    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({
      theme: "system",
      permission: {
        read: "allow",
        external_directory: "allow",
      },
    });

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("respects explicit opt-out", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
    });

    expect(prepared.env).toEqual({ XDG_CONFIG_HOME: configHome });
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("injects options.think=false for gemma4 model entries", async () => {
    const configHome = await makeConfigHome({
      provider: {
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: {
            "gemma4:26b-a4b-it-q4_K_M": { name: "Gemma 4 26B", tools: true },
            "llama3.3:70b-instruct-q4_K_M": { name: "Llama 3.3 70B", tools: true },
          },
        },
      },
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as {
      provider: {
        ollama: {
          models: Record<string, { name: string; tools: boolean; options?: { think?: boolean } }>;
        };
      };
    };

    const models = runtimeConfig.provider.ollama.models;
    // gemma4 model gets think: false injected
    expect(models["gemma4:26b-a4b-it-q4_K_M"].options?.think).toBe(false);
    // other models are untouched
    expect(models["llama3.3:70b-instruct-q4_K_M"].options).toBeUndefined();
    expect(prepared.notes.some((n) => n.includes("options.think=false"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("does not overwrite explicit think=false already in model options", async () => {
    const configHome = await makeConfigHome({
      provider: {
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: {
            "gemma4:26b-a4b-it-q4_K_M": {
              name: "Gemma 4 26B",
              tools: true,
              options: { think: false, someOtherField: "keep" },
            },
          },
        },
      },
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as {
      provider: {
        ollama: {
          models: Record<string, { options?: { think?: boolean; someOtherField?: string } }>;
        };
      };
    };

    const model = runtimeConfig.provider.ollama.models["gemma4:26b-a4b-it-q4_K_M"];
    expect(model.options?.think).toBe(false);
    expect(model.options?.someOtherField).toBe("keep");
    // should not be counted as a new injection
    expect(prepared.notes.some((n) => n.includes("options.think=false"))).toBe(false);

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("does not inject think for non-gemma4 models", async () => {
    const configHome = await makeConfigHome({
      provider: {
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: {
            "qwen3:30b-a3b": { name: "Qwen3 30B", tools: true },
          },
        },
      },
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as {
      provider: { ollama: { models: Record<string, { options?: unknown }> } };
    };

    const model = runtimeConfig.provider.ollama.models["qwen3:30b-a3b"];
    expect(model.options).toBeUndefined();
    expect(prepared.notes.some((n) => n.includes("options.think=false"))).toBe(false);

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("does not inject think when no provider models are configured", async () => {
    const configHome = await makeConfigHome({ theme: "dark" });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    expect(prepared.notes.some((n) => n.includes("options.think=false"))).toBe(false);

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });
});
