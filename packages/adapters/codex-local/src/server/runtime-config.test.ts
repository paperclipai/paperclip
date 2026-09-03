import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCodexRuntimeConfig, readSelectedProviderEnvKey } from "./runtime-config.js";

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

// The selected provider declares env_key "OPENAI_API_KEY", and prepare fails fast
// when that variable is unset. Pass it explicitly rather than relying on the
// host shell, so these tests do not depend on the machine they run on.
const PROVIDER_KEY_ENV = { OPENAI_API_KEY: "sk-test-provider-key" };

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
      env: { ...PROVIDER_KEY_ENV, PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
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
      env: { ...PROVIDER_KEY_ENV, PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
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
      env: { ...PROVIDER_KEY_ENV, PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
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
      const prepared = await prepareCodexRuntimeConfig({ env: { ...PROVIDER_KEY_ENV }, codexHome: home });
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
      [JSON.stringify({ providers: {} }), "contains no usable entries"],
      [JSON.stringify({ providers: { gw: "nope" } }), "skipped provider(s) with empty names or non-object values: gw"],
    ];
    for (const [raw, noteFragment] of cases) {
      const prepared = await prepareCodexRuntimeConfig({
        env: { PAPERCLIP_CODEX_PROVIDERS: raw },
        codexHome: home,
      });
      expect(prepared.notes).toHaveLength(1);
      expect(prepared.notes[0]).toContain(noteFragment);
      expect(prepared.notes[0]).toContain("custom providers ignored");
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

  it("surfaces skipped non-object provider entries while merging the usable ones", async () => {
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: {
        ...PROVIDER_KEY_ENV,
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
          providers: {
            bad: "http://gateway.example/v1",
            good: { base_url: "http://gateway.example/v1", env_key: "OPENAI_API_KEY" },
          },
          model_provider: "good",
        }),
      },
      codexHome: home,
    });

    const content = await readConfigToml(home);
    expect(content).toContain("[model_providers.good]");
    expect(content).not.toContain("[model_providers.bad]");
    expect(
      prepared.notes.some((n) => n.includes("skipped provider(s) with empty names or non-object values: bad")),
    ).toBe(true);
    expect(prepared.notes.some((n) => n.includes("Merged 1 custom Codex model provider(s)"))).toBe(true);
    await prepared.cleanup();
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
      env: { ...PROVIDER_KEY_ENV, PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
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
      env: { ...PROVIDER_KEY_ENV, PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
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
      env: { ...PROVIDER_KEY_ENV, PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
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
      env: { ...PROVIDER_KEY_ENV, PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(BIFROST_PROVIDERS) },
      codexHome: home,
    });
    void first; // simulate crash: no cleanup
    const second = await prepareCodexRuntimeConfig({
      env: {
        ...PROVIDER_KEY_ENV,
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

  it("rejects the block when model_provider names a filtered or missing provider", async () => {
    const home = await makeCodexHome("model = \"gpt-5.1-codex\"\n");
    const prepared = await prepareCodexRuntimeConfig({
      env: {
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
          providers: { good: { base_url: "https://gateway.example/v1" }, bad: "not-an-object" },
          model_provider: "bad",
        }),
      },
      codexHome: home,
    });
    expect(prepared.notes).toContain(
      'PAPERCLIP_CODEX_PROVIDERS: model_provider "bad" does not match any usable provider entry; custom providers ignored.',
    );
    const content = await readConfigToml(home);
    expect(content).toBe("model = \"gpt-5.1-codex\"\n");
  });
});

// A provider's `env_key` names the env var codex reads the bearer key from at
// request time. When it is unset, codex dies on its first model refresh with
// "Missing environment variable: `X`" -- naming neither the config file nor the
// setting that selected the provider. These cover the pre-flight check that
// turns that into an actionable adapter error.
describe("selected model_provider env_key readiness", () => {
  // Deliberately not OPENAI_API_KEY: a var that can be set in a developer's
  // shell would make these tests pass or fail depending on the machine. Also
  // deliberately not PAPERCLIP_*-prefixed -- that prefix is stripped from the
  // inherited env before codex is spawned, which is its own case below.
  const GATEWAY_KEY = "CODEX_TEST_GATEWAY_KEY";
  const GATEWAY_PROVIDERS = {
    providers: {
      gw: { base_url: "http://gw.example/v1", env_key: GATEWAY_KEY, wire_api: "responses" },
    },
    model_provider: "gw",
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails fast, naming the provider, the env var, and the config file", async () => {
    const home = await makeCodexHome("model = \"gpt-5.1-codex\"\n");

    await expect(
      prepareCodexRuntimeConfig({
        env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(GATEWAY_PROVIDERS) },
        codexHome: home,
      }),
    ).rejects.toThrow(
      // The raw codex error names only the env var; this one has to be traceable.
      new RegExp(
        `model_provider "gw".*env_key "${GATEWAY_KEY}".*${path.join(home, "config.toml")}`,
        "s",
      ),
    );
  });

  it("leaves the home untouched when it fails: no partial merge, no backup file", async () => {
    const original = 'model = "gpt-5.1-codex"\n';
    const home = await makeCodexHome(original);

    await expect(
      prepareCodexRuntimeConfig({
        env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(GATEWAY_PROVIDERS) },
        codexHome: home,
      }),
    ).rejects.toThrow(GATEWAY_KEY);

    // The throw happens before any write, so there is no cleanup() to call and
    // nothing for the next run's self-heal to undo.
    expect(await readConfigToml(home)).toBe(original);
    await expect(
      fs.access(path.join(home, "config.toml.paperclip-backup")),
    ).rejects.toThrow();
  });

  it("passes when the env var comes from the adapter config env", async () => {
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: {
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(GATEWAY_PROVIDERS),
        [GATEWAY_KEY]: "sk-gateway",
      },
      codexHome: home,
    });

    expect(prepared.notes.some((n) => n.startsWith("Warning:"))).toBe(false);
    expect(await readConfigToml(home)).toContain("[model_providers.gw]");
    await prepared.cleanup();
  });

  it("passes when the env var comes from the host process env", async () => {
    vi.stubEnv(GATEWAY_KEY, "sk-from-host");
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(GATEWAY_PROVIDERS) },
      codexHome: home,
    });

    expect(await readConfigToml(home)).toContain("[model_providers.gw]");
    await prepared.cleanup();
  });

  it("treats a whitespace-only value as unset", async () => {
    // codex would send it verbatim as the bearer token and the provider would
    // reject it -- the same broken run with a less obvious symptom.
    const home = await makeCodexHome();
    await expect(
      prepareCodexRuntimeConfig({
        env: {
          PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(GATEWAY_PROVIDERS),
          [GATEWAY_KEY]: "   ",
        },
        codexHome: home,
      }),
    ).rejects.toThrow(GATEWAY_KEY);
  });

  it("catches a selection inherited from the base config, not just from PAPERCLIP_CODEX_PROVIDERS", async () => {
    // PAPERCLIP_CODEX_PROVIDERS defines the provider but selects nothing, so the
    // base config's root key survives the merge and is the effective selection.
    // Checking `parsed.modelProvider` instead of the merged file would miss this.
    const home = await makeCodexHome('model_provider = "gw"\n');

    await expect(
      prepareCodexRuntimeConfig({
        env: {
          PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({ providers: GATEWAY_PROVIDERS.providers }),
        },
        codexHome: home,
      }),
    ).rejects.toThrow(GATEWAY_KEY);
  });

  it("does not fire when nothing selects the provider", async () => {
    // An unselected [model_providers.*] table is inert, so its env_key is not
    // required. Firing here would break every merge that only defines providers.
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: {
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({ providers: GATEWAY_PROVIDERS.providers }),
      },
      codexHome: home,
    });

    expect(prepared.notes.some((n) => n.startsWith("Warning:"))).toBe(false);
    expect(await readConfigToml(home)).toContain("[model_providers.gw]");
    await prepared.cleanup();
  });

  it("warns instead of failing when the run targets a remote execution host", async () => {
    // The control plane's process.env is not the remote process's environment,
    // so a missing value here is not proof the run will fail.
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(GATEWAY_PROVIDERS) },
      codexHome: home,
      executionTargetIsRemote: true,
    });

    const warning = prepared.notes.find((n) => n.startsWith("Warning:"));
    expect(warning).toContain(GATEWAY_KEY);
    expect(warning).toContain("remote execution host");
    // The merge still happens; only the hard failure is withheld.
    expect(await readConfigToml(home)).toContain("[model_providers.gw]");
    await prepared.cleanup();
  });

  it("still warns for a remote target when only the control plane's process env has the key", async () => {
    // The regression this whole distinction exists for. The control plane's
    // environment does not cross the ssh/sandbox transport -- only the explicit
    // env record does -- so crediting process.env here would silently pass a run
    // that dies inside codex on the remote host. Reading it as "already set"
    // withholds the one warning that would have explained the failure.
    vi.stubEnv(GATEWAY_KEY, "sk-control-plane-only");
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: { PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(GATEWAY_PROVIDERS) },
      codexHome: home,
      executionTargetIsRemote: true,
    });

    const warning = prepared.notes.find((n) => n.startsWith("Warning:"));
    expect(warning).toContain(GATEWAY_KEY);
    expect(warning).toContain("does not cross the transport");
    await prepared.cleanup();
  });

  it("does not warn for a remote target when the adapter config env carries the key", async () => {
    // The adapter config env IS forwarded across the transport, so it is the one
    // source that settles the question for a remote run.
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: {
        PAPERCLIP_CODEX_PROVIDERS: JSON.stringify(GATEWAY_PROVIDERS),
        [GATEWAY_KEY]: "sk-gateway",
      },
      codexHome: home,
      executionTargetIsRemote: true,
    });

    expect(prepared.notes.some((n) => n.startsWith("Warning:"))).toBe(false);
    await prepared.cleanup();
  });

  it("fails fast when a PAPERCLIP_-prefixed env_key is satisfied only by the host process env", async () => {
    // sanitizeInheritedPaperclipEnv strips PAPERCLIP_* from the inherited env
    // before codex is spawned, so a value visible here never reaches the child.
    // Treating it as set would pass the check on a run guaranteed to fail.
    const prefixedKey = "PAPERCLIP_TEST_GATEWAY_KEY";
    vi.stubEnv(prefixedKey, "sk-stripped-before-spawn");
    const home = await makeCodexHome();

    await expect(
      prepareCodexRuntimeConfig({
        env: {
          PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
            providers: { gw: { base_url: "http://gw.example/v1", env_key: prefixedKey } },
            model_provider: "gw",
          }),
        },
        codexHome: home,
      }),
    ).rejects.toThrow(prefixedKey);
  });

  it("warns but never fails or rewrites an explicitly configured CODEX_HOME", async () => {
    const original = [
      'model_provider = "omlx"',
      "",
      "[model_providers.omlx]",
      'base_url = "http://127.0.0.1:8080/v1"',
      `env_key = "${GATEWAY_KEY}"`,
      "",
    ].join("\n");
    const home = await makeCodexHome(original);

    const prepared = await prepareCodexRuntimeConfig({
      env: {},
      codexHome: null,
      externalCodexHome: home,
    });

    const warning = prepared.notes.find((n) => n.startsWith("Warning:"));
    expect(warning).toContain('model_provider "omlx"');
    expect(warning).toContain(GATEWAY_KEY);
    expect(warning).toContain("does not merge model providers");
    // Read-only: the user's file is byte-for-byte untouched.
    expect(await readConfigToml(home)).toBe(original);
    await prepared.cleanup();
  });

  it("does not warn about an explicitly configured CODEX_HOME whose env var is set", async () => {
    const home = await makeCodexHome(
      ['model_provider = "omlx"', "[model_providers.omlx]", `env_key = "${GATEWAY_KEY}"`, ""].join(
        "\n",
      ),
    );
    const prepared = await prepareCodexRuntimeConfig({
      env: { [GATEWAY_KEY]: "sk-local" },
      codexHome: null,
      externalCodexHome: home,
    });

    expect(prepared.notes.some((n) => n.startsWith("Warning:"))).toBe(false);
    await prepared.cleanup();
  });

  it("does not warn about an explicitly configured CODEX_HOME with no config.toml", async () => {
    const home = await makeCodexHome();
    const prepared = await prepareCodexRuntimeConfig({
      env: {},
      codexHome: null,
      externalCodexHome: home,
    });

    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });
});

describe("readSelectedProviderEnvKey", () => {
  it("reads the root selection and the matching provider's env_key", () => {
    expect(
      readSelectedProviderEnvKey(
        [
          'model_provider = "gw"  # selected by paperclip',
          "",
          "[model_providers.other]",
          'env_key = "OTHER_KEY"',
          "",
          "[model_providers.gw]",
          "env_key = 'GW_KEY'",
          "",
        ].join("\n"),
      ),
    ).toEqual({ modelProvider: "gw", envKey: "GW_KEY" });
  });

  it("ignores a model_provider key that lives inside a table", () => {
    // [profiles.dev].model_provider is a different key; only the root-level one
    // selects the provider codex actually dials.
    expect(
      readSelectedProviderEnvKey(
        ["[profiles.dev]", 'model_provider = "gw"', "", "[model_providers.gw]", 'env_key = "GW_KEY"'].join(
          "\n",
        ),
      ),
    ).toBeNull();
  });

  it("ignores env_key in a subtable of the selected provider", () => {
    // [model_providers.gw.http_headers] is header data, not the provider's own key.
    expect(
      readSelectedProviderEnvKey(
        [
          'model_provider = "gw"',
          "[model_providers.gw]",
          'base_url = "http://gw.example/v1"',
          "[model_providers.gw.http_headers]",
          'env_key = "NOT_THE_PROVIDER_KEY"',
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("returns null when the selected provider declares no env_key", () => {
    // A keyless local gateway is a legitimate config; there is nothing to check.
    expect(
      readSelectedProviderEnvKey(
        ['model_provider = "gw"', "[model_providers.gw]", 'base_url = "http://gw.example/v1"'].join(
          "\n",
        ),
      ),
    ).toBeNull();
  });

  it("does not match env_key nested in an inline table on another key", () => {
    expect(
      readSelectedProviderEnvKey(
        [
          'model_provider = "gw"',
          "[model_providers.gw]",
          'http_headers = { env_key = "DECOY" }',
        ].join("\n"),
      ),
    ).toBeNull();
  });
});
