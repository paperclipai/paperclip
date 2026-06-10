import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCodexRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeCodexHome(configToml?: string): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
  cleanupPaths.add(home);
  if (configToml !== undefined) {
    await fs.writeFile(path.join(home, "config.toml"), configToml, "utf8");
  }
  return home;
}

async function readConfigToml(home: string): Promise<string> {
  return fs.readFile(path.join(home, "config.toml"), "utf8");
}

const BIFROST_PROVIDERS = {
  providers: {
    bifrost: {
      name: "bifrost",
      base_url: "http://gateway.example.svc.cluster.local:8080/v1",
      env_key: "OPENAI_API_KEY",
      wire_api: "responses",
    },
  },
  model_provider: "bifrost",
};

describe("prepareCodexRuntimeConfig", () => {
  it("is a no-op when PAPERCLIP_CODEX_PROVIDERS is unset", async () => {
    const home = await makeCodexHome("model = \"gpt-5.1-codex\"\n");
    const prepared = await prepareCodexRuntimeConfig({ env: { FOO: "bar" }, codexHome: home });

    expect(prepared.notes).toEqual([]);
    expect(await readConfigToml(home)).toBe("model = \"gpt-5.1-codex\"\n");
    await prepared.cleanup();
  });

  it("is a no-op when the home has no config.toml and the env is unset", async () => {
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({ env: {}, codexHome: home });

    expect(prepared.notes).toEqual([]);
    await expect(fs.access(path.join(home, "config.toml"))).rejects.toThrow();
    await prepared.cleanup();
  });

  it("merges providers + model_provider into a fresh config.toml and cleans it up", async () => {
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
      codexHome: home,
    });

    const content = await readConfigToml(home);
    expect(content).toContain('model_provider = "bifrost"');
    expect(content).toContain("[model_providers.bifrost]");
    expect(content).toContain('base_url = "http://gateway.example.svc.cluster.local:8080/v1"');
    expect(content).toContain('env_key = "OPENAI_API_KEY"');
    expect(content).toContain('wire_api = "responses"');
    expect(prepared.notes.some((n) => n.includes("bifrost"))).toBe(true);

    await prepared.cleanup();
    await expect(fs.access(path.join(home, "config.toml"))).rejects.toThrow();
  });

  it("preserves existing config.toml content, keeps model_provider in the root region, and restores on cleanup", async () => {
    const original = [
      'model = "gpt-5.1-codex"',
      "",
      "[profiles.dev]",
      'model = "gpt-5.1-codex-mini"',
      "",
    ].join("\n");
    const home = await makeCodexHome(original);
    const prepared = await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
      codexHome: home,
    });

    const content = await readConfigToml(home);
    // Existing content survives.
    expect(content).toContain('model = "gpt-5.1-codex"');
    expect(content).toContain("[profiles.dev]");
    // model_provider must precede the first table header (TOML root region),
    // and the provider tables must come after the user's tables.
    expect(content.indexOf('model_provider = "bifrost"')).toBeLessThan(
      content.indexOf("[profiles.dev]"),
    );
    expect(content.indexOf("[model_providers.bifrost]")).toBeGreaterThan(
      content.indexOf("[profiles.dev]"),
    );

    await prepared.cleanup();
    expect(await readConfigToml(home)).toBe(original);
  });

  it("wins over a pre-existing same-name [model_providers.*] section and root model_provider key", async () => {
    const original = [
      'model_provider = "stale"',
      "",
      "[model_providers.bifrost]",
      'base_url = "http://old.example/v1"',
      'env_key = "OLD_KEY"',
      "",
      "[model_providers.bifrost.http_headers]",
      '"X-Old" = "1"',
      "",
      "[model_providers.other]",
      'base_url = "http://other.example/v1"',
      "",
    ].join("\n");
    const home = await makeCodexHome(original);
    const prepared = await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
      codexHome: home,
    });

    const content = await readConfigToml(home);
    expect(content).not.toContain('model_provider = "stale"');
    expect(content).not.toContain("http://old.example/v1");
    expect(content).not.toContain("X-Old");
    // Unrelated provider sections survive.
    expect(content).toContain("[model_providers.other]");
    expect(content).toContain("http://other.example/v1");
    // Exactly one bifrost section: ours.
    expect(content.split("[model_providers.bifrost]").length).toBe(2);
    expect(content).toContain('base_url = "http://gateway.example.svc.cluster.local:8080/v1"');

    await prepared.cleanup();
    expect(await readConfigToml(home)).toBe(original);
  });

  it("emits plain-object fields as inline tables and arrays as TOML arrays", async () => {
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: {
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
          providers: {
            gw: {
              base_url: "http://gw.example/v1",
              query_params: { "api-version": "2026-01-01" },
              http_headers: { "X Team": "agents" },
              request_max_retries: 4,
            },
          },
        }),
      },
      codexHome: home,
    });

    const content = await readConfigToml(home);
    expect(content).toContain("[model_providers.gw]");
    // Bare keys (incl. hyphens) stay bare; keys with other characters get quoted.
    expect(content).toContain('query_params = { api-version = "2026-01-01" }');
    expect(content).toContain('http_headers = { "X Team" = "agents" }');
    expect(content).toContain("request_max_retries = 4");
    // No model_provider was requested, so none is emitted.
    expect(content).not.toContain("model_provider =");

    await prepared.cleanup();
  });

  it("expands {env:VAR} placeholders from the run env and process.env, leaving unresolvable ones intact", async () => {
    const home = await makeCodexHome();
    process.env.PAPERCLIP_CODEX_TEST_PROCESS_KEY = "from-process-env";
    try {
      const prepared = await prepareCodexRuntimeConfig({
        env: {
          PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
            providers: {
              gw: {
                base_url: "http://gw.example/v1",
                http_headers: {
                  "X-Run": "{env:PAPERCLIP_CODEX_TEST_RUN_KEY}",
                  "X-Process": "{env:PAPERCLIP_CODEX_TEST_PROCESS_KEY}",
                  "X-Missing": "{env:DEFINITELY_UNSET_VAR_XYZ}",
                },
              },
            },
            model_provider: "gw",
          }),
          PAPERCLIP_CODEX_TEST_RUN_KEY: "from-run-env",
        },
        codexHome: home,
      });

      const content = await readConfigToml(home);
      expect(content).toContain('X-Run = "from-run-env"');
      expect(content).toContain('X-Process = "from-process-env"');
      expect(content).toContain('X-Missing = "{env:DEFINITELY_UNSET_VAR_XYZ}"');

      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_CODEX_TEST_PROCESS_KEY;
    }
  });

  it("reads PAPERCLIP_CODEX_PROVIDERS from process.env when absent from the run env", async () => {
    const home = await makeCodexHome();
    process.env.PAPERCLIP_CODEX_PROVIDERS = JSON.stringify(BIFROST_PROVIDERS);
    try {
      const prepared = await prepareCodexRuntimeConfig({ env: {}, codexHome: home });
      const content = await readConfigToml(home);
      expect(content).toContain("[model_providers.bifrost]");
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_CODEX_PROVIDERS;
    }
  });

  it("surfaces a note for malformed PAPERCLIP_CODEX_PROVIDERS without touching config.toml", async () => {
    const home = await makeCodexHome("model = \"gpt-5.1-codex\"\n");
    const cases: Array<[raw: string, noteFragment: string]> = [
      ["not json", "contains invalid JSON"],
      [JSON.stringify(["providers"]), "is not a JSON object"],
      [JSON.stringify({ no_providers: true }), 'has no "providers" object'],
      [JSON.stringify({ providers: { gw: "nope" } }), "contains no usable entries"],
    ];
    for (const [raw, noteFragment] of cases) {
      const prepared = await prepareCodexRuntimeConfig({
        env: { PAPERCLIP_CODEX_PROVIDERS: raw },
        codexHome: home,
      });
      expect(prepared.notes).toHaveLength(1);
      expect(prepared.notes[0]).toContain(noteFragment);
      expect(prepared.notes[0]).toContain("custom model providers ignored");
      expect(await readConfigToml(home)).toBe("model = \"gpt-5.1-codex\"\n");
      await prepared.cleanup();
    }
  });

  it("stays silent when PAPERCLIP_CODEX_PROVIDERS is unset or empty", async () => {
    const home = await makeCodexHome("model = \"gpt-5.1-codex\"\n");
    const envs: Array<Record<string, string>> = [
      {},
      { PAPERCLIP_CODEX_PROVIDERS: "" },
      { PAPERCLIP_CODEX_PROVIDERS: "  " },
    ];
    for (const env of envs) {
      const prepared = await prepareCodexRuntimeConfig({ env, codexHome: home });
      expect(prepared.notes).toEqual([]);
      expect(await readConfigToml(home)).toBe("model = \"gpt-5.1-codex\"\n");
      await prepared.cleanup();
    }
  });

  it("escapes DEL (U+007F) in emitted TOML strings", async () => {
    const del = String.fromCharCode(0x7f);
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: {
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
          providers: { gw: { base_url: "http://gw.example/v1", name: `del${del}name` } },
        }),
      },
      codexHome: home,
    });

    const content = await readConfigToml(home);
    expect(content).not.toContain(del);
    expect(content).toContain("u007fname");
    await prepared.cleanup();
  });

  it("restores user provider sections from the pre-run backup after an interrupted run", async () => {
    const userConfig = [
      'model = "gpt-5.1-codex"',
      "",
      "[model_providers.bifrost]",
      'base_url = "http://user.example/v1"',
      "",
    ].join("\n");
    const home = await makeCodexHome(userConfig);
    // Simulate a crash: the merge excises the user's same-name provider
    // section (the managed definition must win), and cleanup() never runs.
    await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
      codexHome: home,
    });
    expect(await readConfigToml(home)).toContain('env_key = "OPENAI_API_KEY"');

    const prepared = await prepareCodexRuntimeConfig({ env: {}, codexHome: home });
    expect(prepared.notes.some((n) => n.includes("backup"))).toBe(true);
    expect(await readConfigToml(home)).toBe(userConfig);
    await expect(fs.access(path.join(home, "config.toml.paperclip-backup"))).rejects.toThrow();
    await prepared.cleanup();
  });

  it("removes the pre-run backup on cleanup", async () => {
    const home = await makeCodexHome('approval_policy = "never"\n');
    const prepared = await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
      codexHome: home,
    });
    const backupPath = path.join(home, "config.toml.paperclip-backup");
    expect(await fs.readFile(backupPath, "utf8")).toBe('approval_policy = "never"\n');

    await prepared.cleanup();
    expect(await readConfigToml(home)).toBe('approval_policy = "never"\n');
    await expect(fs.access(backupPath)).rejects.toThrow();
  });

  it("skips the merge and surfaces a note when CODEX_HOME is explicitly configured", async () => {
    const prepared = await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
      codexHome: null,
    });

    expect(prepared.notes).toHaveLength(1);
    expect(prepared.notes[0]).toContain("CODEX_HOME");
    await prepared.cleanup();
  });

  it("self-heals stale managed blocks when the env is no longer set", async () => {
    const home = await makeCodexHome();
    const crashed = await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
      codexHome: home,
    });
    // Simulate a crash: cleanup never runs, the managed blocks persist.
    void crashed;
    expect(await readConfigToml(home)).toContain("[model_providers.bifrost]");

    const prepared = await prepareCodexRuntimeConfig({ env: {}, codexHome: home });
    expect(prepared.notes.some((n) => n.includes("stale"))).toBe(true);
    const content = await readConfigToml(home);
    expect(content).not.toContain("model_provider");
    expect(content).not.toContain("bifrost");
    await prepared.cleanup();
  });

  it("re-running with changed providers replaces the previous managed blocks", async () => {
    const home = await makeCodexHome("approval_policy = \"never\"\n");
    const first = await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
      codexHome: home,
    });
    void first; // simulate crash: no cleanup
    const second = await prepareCodexRuntimeConfig({
      env: {
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
          providers: { gw2: { base_url: "http://gw2.example/v1", env_key: "OPENAI_API_KEY" } },
          model_provider: "gw2",
        }),
      },
      codexHome: home,
    });

    const content = await readConfigToml(home);
    expect(content).toContain('approval_policy = "never"');
    expect(content).toContain("[model_providers.gw2]");
    expect(content).toContain('model_provider = "gw2"');
    expect(content).not.toContain("bifrost");
    expect(content.split("model_provider =").length).toBe(2);
    await second.cleanup();
  });
});
