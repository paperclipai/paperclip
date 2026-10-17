import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";
import {
  PAPERCLIP_WINDOWS_UTF8_PLUGIN_FILENAME,
  PAPERCLIP_WINDOWS_UTF8_PLUGIN_SOURCE,
} from "./windows-utf8.js";

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
  it("allows all tools and connected tools by default", async () => {
    const configHome = await makeConfigHome({
      permission: {
        read: "allow",
        bash: "ask",
        "mcp__example__write": "deny",
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
      permission: "allow",
    });

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("merges custom providers from PAPERCLIP_OPENCODE_PROVIDERS into the config", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      bifrost: {
        npm: "@ai-sdk/openai-compatible",
        name: "Bifrost EU",
        options: {
          baseURL: "http://gateway.example.svc.cluster.local:8080/v1",
          apiKey: "{env:ANTHROPIC_API_KEY}",
        },
        models: { "example/model-a": { name: "Model A" } },
      },
    };

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({
      permission: "allow",
      provider: providers,
    });
    expect(prepared.notes.some((n) => n.includes("bifrost"))).toBe(true);
    await prepared.cleanup();
  });

  it("reads PAPERCLIP_OPENCODE_PROVIDERS from process.env when absent from the run env", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { npm: "@ai-sdk/openai-compatible", models: { "example/model-a": {} } } };
    process.env.PAPERCLIP_OPENCODE_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(runtimeConfig).toMatchObject({ provider: providers });
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_OPENCODE_PROVIDERS;
    }
  });

  it("expands {env:VAR} placeholders in custom providers using the run/process env (bakes the literal vk)", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      bifrost: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://bifrost/v1", apiKey: "{env:ANTHROPIC_API_KEY}" },
        models: { "example/model-a": {} },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers), ANTHROPIC_API_KEY: "sk-bf-REALVK" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: { bifrost: { options: { apiKey: string } } } };
    // The {env:...} placeholder must be replaced with the literal value, so OpenCode
    // does not depend on its sandboxed process env carrying the key.
    expect(runtimeConfig.provider.bifrost.options.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { options: { apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}" }, models: { "x/y": {} } } };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers) },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: { bifrost: { options: { apiKey: string } } } };
    expect(runtimeConfig.provider.bifrost.options.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("pins small_model from PAPERCLIP_OPENCODE_SMALL_MODEL", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_SMALL_MODEL: "example/model-a" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { small_model?: string };
    expect(runtimeConfig.small_model).toBe("example/model-a");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_OPENCODE_PROVIDERS without writing a provider block and surfaces a note", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "not json" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.",
    );
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_OPENCODE_PROVIDERS is valid JSON but not an object", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "[1,2,3]" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries with non-object values and keeps the usable ones", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
          bifrost: "http://gateway.example/v1",
          usable: { options: { baseURL: "http://gateway.example/v1" } },
        }),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, unknown> };
    expect(runtimeConfig.provider?.usable).toBeDefined();
    expect(runtimeConfig.provider?.bifrost).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.",
    );
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries when no usable entries remain", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ bifrost: "http://gateway.example/v1" }),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.",
    );
    await prepared.cleanup();
  });

  it("registers a configured model missing from the catalog on its provider", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "openrouter/openai/gpt-oss-120b:nitro" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.openrouter?.models).toEqual({
      "openai/gpt-oss-120b:nitro": {},
    });
    expect(prepared.notes).toContain(
      "Registered configured model openrouter/openai/gpt-oss-120b:nitro in the runtime OpenCode config.",
    );
    await prepared.cleanup();
  });

  it("does not clobber an explicit model definition when registering the configured model", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      openrouter: {
        models: {
          "openai/gpt-oss-120b:nitro": { name: "GPT-OSS 120B (nitro)" },
          "example/other": {},
        },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
      },
      config: { model: "openrouter/openai/gpt-oss-120b:nitro" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.openrouter?.models).toEqual(providers.openrouter.models);
    expect(
      prepared.notes.some((note) => note.startsWith("Registered configured model")),
    ).toBe(false);
    await prepared.cleanup();
  });

  it("skips model registration when the configured model is not provider/model shaped", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "not-a-provider-model" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    await prepared.cleanup();
  });

  it("respects explicit opt-out off Windows", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
      platform: "linux",
    });

    expect(prepared.env).toEqual({ XDG_CONFIG_HOME: configHome });
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("does not inject the Windows UTF-8 shell plugin for a remote target", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      platform: "win32",
      targetIsRemote: true,
    });
    expect(prepared.env).toEqual({ XDG_CONFIG_HOME: configHome });
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("injects the Windows UTF-8 shell plugin on Windows", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      platform: "win32",
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const configDir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode");
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(configDir, "opencode.json"), "utf8"),
    ) as { plugin?: unknown[] };
    const pluginRef = `./${PAPERCLIP_WINDOWS_UTF8_PLUGIN_FILENAME}`;
    expect(runtimeConfig.plugin).toEqual([pluginRef]);
    await expect(
      fs.readFile(path.join(configDir, PAPERCLIP_WINDOWS_UTF8_PLUGIN_FILENAME), "utf8"),
    ).resolves.toBe(PAPERCLIP_WINDOWS_UTF8_PLUGIN_SOURCE);
    expect(prepared.notes.some((note) => note.includes("Windows UTF-8 shell plugin"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("does not inject the Windows UTF-8 shell plugin off Windows", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      platform: "linux",
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { plugin?: unknown };
    expect(runtimeConfig.plugin).toBeUndefined();
    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("preserves an existing plugin array and appends the Windows UTF-8 plugin once", async () => {
    const configHome = await makeConfigHome({
      permission: { read: "allow" },
      plugin: ["file:///existing/plugin.js"],
    });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      platform: "win32",
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const configDir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode");
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(configDir, "opencode.json"), "utf8"),
    ) as { plugin?: unknown[] };
    const pluginRef = `./${PAPERCLIP_WINDOWS_UTF8_PLUGIN_FILENAME}`;
    expect(runtimeConfig.plugin).toEqual(["file:///existing/plugin.js", pluginRef]);
    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("ships a loadable plugin that forces UTF-8 and is idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-utf8-plugin-"));
    cleanupPaths.add(dir);
    const pluginFile = path.join(dir, "paperclip-windows-utf8.mjs");
    await fs.writeFile(pluginFile, PAPERCLIP_WINDOWS_UTF8_PLUGIN_SOURCE, "utf8");

    const mod = (await import(pathToFileURL(pluginFile).href)) as {
      PaperclipWindowsUtf8: () => Promise<{
        "tool.execute.before": (
          input: { tool: string },
          output: { args: { command: string } },
        ) => Promise<void>;
      }>;
    };
    const hooks = await mod.PaperclipWindowsUtf8();

    // The plugin reads `process.platform`. Force the Windows branch so this test
    // exercises the rewrite on every host, including Linux CI.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      // A plain shell command gets the console and $OutputEncoding fix and keeps
      // its original text inside the outer scriptblock.
      const plain = { args: { command: "Write-Output 'Привет'" } };
      await hooks["tool.execute.before"]({ tool: "bash" }, plain);
      expect(plain.args.command).toContain("PAPERCLIP_WINDOWS_UTF8");
      expect(plain.args.command).toContain("[Console]::OutputEncoding");
      expect(plain.args.command).toContain("$OutputEncoding");
      expect(plain.args.command).not.toContain("Invoke-RestMethod:ContentType");
      expect(plain.args.command).toContain("& {Write-Output 'Привет'\n};");

      // A JSON request also gets the UTF-8 request content type default.
      const json = {
        args: { command: "Invoke-RestMethod -Uri $u -Headers @{'Content-Type'='application/json'} -Body $b" },
      };
      await hooks["tool.execute.before"]({ tool: "shell" }, json);
      expect(json.args.command).toContain("Invoke-RestMethod:ContentType");
      expect(json.args.command).toContain("Invoke-WebRequest:ContentType");

      // A non-JSON request keeps its own content type: no JSON default is added.
      const form = { args: { command: "Invoke-RestMethod -Uri https://example.test/form -Body 'name=alice'" } };
      await hooks["tool.execute.before"]({ tool: "bash" }, form);
      expect(form.args.command).not.toContain("Invoke-RestMethod:ContentType");

      // A comment-prefixed command still gets the fix: the comment may precede
      // the executable statement inside the scriptblock.
      const commentCmd = { args: { command: "# note\nWrite-Output 'Привет'" } };
      await hooks["tool.execute.before"]({ tool: "shell" }, commentCmd);
      expect(commentCmd.args.command).toContain("PAPERCLIP_WINDOWS_UTF8");
      expect(commentCmd.args.command).toContain("& {# note\nWrite-Output 'Привет'\n};");

      // A command whose first non-comment token is a `using` statement is left
      // unchanged: `using` must stay first and cannot live inside a scriptblock.
      const usingCommands = [
        "using namespace System.Text; [Encoding]::UTF8.GetBytes('Привет')",
        "<# note #>using namespace System.Text; Write-Output 'Привет'",
      ];
      for (const usingCommand of usingCommands) {
        const usingArgs = { args: { command: usingCommand } };
        await hooks["tool.execute.before"]({ tool: "shell" }, usingArgs);
        expect(usingArgs.args.command).toBe(usingCommand);
      }

      // Wrappable top-level constructs (`param`, `begin`/`process`/`end` blocks)
      // stay valid because the original text runs inside the outer scriptblock.
      const wrappedCommands = [
        "param([string]$text = 'Привет'); Write-Output $text",
        "param([string]$text = ')'); Write-Output $text",
        "begin { Write-Output 'Привет' }",
        "process { Write-Output 'Привет' }",
        "end { Write-Output 'Привет' }",
      ];
      for (const wrappedCommand of wrappedCommands) {
        const wrappedArgs = { args: { command: wrappedCommand } };
        await hooks["tool.execute.before"]({ tool: "shell" }, wrappedArgs);
        expect(wrappedArgs.args.command).toContain("PAPERCLIP_WINDOWS_UTF8");
        expect(wrappedArgs.args.command).toContain(`& {${wrappedCommand}\n};`);
      }

      // Second pass must not double-prefix.
      const once = plain.args.command;
      await hooks["tool.execute.before"]({ tool: "bash" }, plain);
      expect(plain.args.command).toBe(once);

      // Non-shell tools are never rewritten.
      const readOutput = { args: { command: "cat file" } };
      await hooks["tool.execute.before"]({ tool: "read" }, readOutput);
      expect(readOutput.args.command).toBe("cat file");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }

    // Off Windows the hook is a no-op.
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const linuxOutput = { args: { command: "Write-Output 'Привет'" } };
      await hooks["tool.execute.before"]({ tool: "bash" }, linuxOutput);
      expect(linuxOutput.args.command).toBe("Write-Output 'Привет'");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }

    await fs.rm(dir, { recursive: true, force: true });
    cleanupPaths.delete(dir);
  });
});
