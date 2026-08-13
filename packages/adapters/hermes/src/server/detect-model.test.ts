import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { detectModel, parseModelFromConfig, resolveHermesConfigPath, resolveHermesHomePaths, resolveProvider } from "./detect-model.js";
import { createHermesEnvironmentTester, type SubprocessRunner } from "./test.js";

const providerEnvKeys = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
];

const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  HERMES_HOME: process.env.HERMES_HOME,
  HERMES_S6_SUPERVISED_CHILD: process.env.HERMES_S6_SUPERVISED_CHILD,
  ...Object.fromEntries(providerEnvKeys.map((key) => [key, process.env[key]])),
};

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const passingRunner: SubprocessRunner = async (command, args) => {
  if (command === "hermes" && args[0] === "--version") {
    return { stdout: "Hermes Agent 0.18.2\n", stderr: "" };
  }
  if (command === "python3" && args[0] === "--version") {
    return { stdout: "Python 3.11.0\n", stderr: "" };
  }
  if (command === "hermes" && args[0] === "profile" && args[1] === "show") {
    return { stdout: `name: ${args[2] ?? "default"}\n`, stderr: "" };
  }
  throw new Error(`unexpected subprocess: ${command} ${args.join(" ")}`);
};

test("parseModelFromConfig tracks api_key presence without exposing the raw secret", () => {
  const parsed = parseModelFromConfig([
    "model:",
    "  default: oca/gpt-5.4",
    "  provider: custom",
    "  base_url: https://example.invalid/litellm",
    "  api_key: super-secret-value",
    "",
  ].join("\n"));

  expect(parsed).toBeTruthy();
  expect(parsed?.hasApiKey).toBe(true);
  expect(Object.hasOwn(parsed ?? {}, "apiKey")).toBe(false);
});

test("resolveProvider does not fall through to model inference when Hermes config provider is unsupported but matches the requested model", () => {
  expect(resolveProvider({
    explicitProvider: undefined,
    detectedProvider: "custom",
    detectedModel: "oca/gpt-5.4",
    detectedBaseUrl: "https://example.invalid/litellm",
    detectedHasApiKey: true,
    model: "oca/gpt-5.4",
  })).toEqual({
    provider: "auto",
    resolvedFrom: "hermesConfigUnsupported:custom",
  });
});

test("resolveProvider also defers to Hermes runtime when the matching config omits provider but includes runtime signals", () => {
  expect(resolveProvider({
    explicitProvider: undefined,
    detectedProvider: "",
    detectedModel: "oca/gpt-5.4",
    detectedBaseUrl: "https://example.invalid/litellm",
    detectedHasApiKey: true,
    model: "oca/gpt-5.4",
  })).toEqual({
    provider: "auto",
    resolvedFrom: "hermesConfigRuntime",
  });
});

test("resolveProvider still infers from the requested model when Hermes config is for a different model", () => {
  expect(resolveProvider({
    explicitProvider: undefined,
    detectedProvider: "custom",
    detectedModel: "oca/gpt-5.4",
    detectedBaseUrl: "https://example.invalid/litellm",
    detectedHasApiKey: true,
    model: "claude-sonnet-4",
  })).toEqual({
    provider: "anthropic",
    resolvedFrom: "modelInference",
  });
});

async function withHermesHomeConfig(
  configLines: string[],
  fn: () => Promise<void>,
) {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  const hermesDir = join(tempHome, ".hermes");
  const configPath = join(hermesDir, "config.yaml");

  await mkdir(hermesDir, { recursive: true });
  await writeFile(configPath, `${configLines.join("\n")}\n`, "utf8");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.HERMES_HOME;
  delete process.env.HERMES_S6_SUPERVISED_CHILD;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  for (const key of providerEnvKeys) {
    delete process.env[key];
  }

  try {
    await fn();
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

async function withHermesHomeConfigs(
  configs: Record<string, string[]>,
  fn: () => Promise<string>,
) {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.HERMES_HOME;
  delete process.env.HERMES_S6_SUPERVISED_CHILD;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  for (const [profile, lines] of Object.entries(configs)) {
    const dir = profile === "default"
      ? join(tempHome, ".hermes")
      : join(tempHome, ".hermes", "profiles", profile);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.yaml"), `${lines.join("\n")}\n`, "utf8");
  }

  try {
    return await fn();
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

test("testEnvironment does not warn about missing API keys when Hermes config provides a supported provider api_key", async () => {
  await withHermesHomeConfig([
    "model:",
    "  default: openrouter/gpt-4.1-mini",
    "  provider: openrouter",
    "  api_key: test-secret",
  ], async () => {
    const testEnvironment = createHermesEnvironmentTester({ runner: passingRunner });
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        model: "openrouter/gpt-4.1-mini",
      },
    });

    const codes = result.checks.map((check) => check.code);

    expect(codes.includes("hermes_no_api_keys")).toBe(false);
    expect(result.status).toBe("pass");
  });
});

test("testEnvironment describes provider-omitted runtime config without inventing provider auto", async () => {
  await withHermesHomeConfig([
    "model:",
    "  default: oca/gpt-5.4",
    "  base_url: https://example.invalid/litellm",
    "  api_key: test-secret",
  ], async () => {
    const testEnvironment = createHermesEnvironmentTester({ runner: passingRunner });
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        model: "oca/gpt-5.4",
      },
    });

    const apiKeyCheck = result.checks.find((check) => check.code === "hermes_api_key_in_config");
    expect(apiKeyCheck).toBeTruthy();
    expect(apiKeyCheck?.message).toMatch(/without an explicit provider/i);
    expect(apiKeyCheck?.message).not.toMatch(/provider "auto"/i);
  });
});

test("testEnvironment does not warn about missing API keys when Hermes config provides a custom provider base_url and api_key", async () => {
  await withHermesHomeConfig([
    "model:",
    "  default: oca/gpt-5.4",
    "  provider: custom",
    "  base_url: https://example.invalid/litellm",
    "  api_key: test-secret",
  ], async () => {
    const testEnvironment = createHermesEnvironmentTester({ runner: passingRunner });
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        model: "oca/gpt-5.4",
      },
    });

    const codes = result.checks.map((check) => check.code);

    expect(codes.includes("hermes_no_api_keys")).toBe(false);
    expect(result.status).toBe("pass");
  });
});

test("resolveHermesConfigPath selects default and named profile config paths", async () => {
  await withHermesHomeConfigs({ default: ["model:", "  default: openrouter/default"] }, async () => {
    await mkdir(join(process.env.HOME!, ".hermes", "profiles", "paperclip-engineer"), { recursive: true });
    expect(resolveHermesConfigPath()).toMatch(/\.hermes\/config\.yaml$/);
    expect(resolveHermesConfigPath(undefined)).toMatch(/\.hermes\/config\.yaml$/);
    expect(resolveHermesConfigPath("default")).toMatch(/\.hermes\/config\.yaml$/);
    expect(resolveHermesConfigPath("paperclip-engineer")).toMatch(/\.hermes\/profiles\/paperclip-engineer\/config\.yaml$/);
    return "";
  });
});

test("sticky named active_profile overrides root model and provider detection", async () => {
  await withHermesHomeConfigs({
    default: [
      "model:",
      "  default: openrouter/root-model",
      "  provider: openrouter",
      "  api_key: root-secret-marker",
    ],
    engineer: [
      "model:",
      "  default: oca/sticky-model",
      "  provider: custom",
      "  base_url: https://example.invalid/sticky",
      "  api_key: sticky-secret-marker",
    ],
  }, async () => {
    await writeFile(join(process.env.HOME!, ".hermes", "active_profile"), "engineer\n", "utf8");

    const detected = await detectModel(resolveHermesConfigPath());

    expect(detected?.model).toBe("oca/sticky-model");
    expect(detected?.provider).toBe("custom");
    expect(resolveHermesHomePaths().selectedHome).toBe(join(process.env.HOME!, ".hermes", "profiles", "engineer"));
    return "";
  });
});

test("explicit named and default profiles override sticky active_profile", async () => {
  await withHermesHomeConfigs({
    default: ["model:", "  default: openrouter/root-model", "  provider: openrouter"],
    engineer: ["model:", "  default: openrouter/engineer-model", "  provider: openrouter"],
    reviewer: ["model:", "  default: anthropic/reviewer-model", "  provider: anthropic"],
  }, async () => {
    await writeFile(join(process.env.HOME!, ".hermes", "active_profile"), "engineer\n", "utf8");

    expect(resolveHermesConfigPath("reviewer")).toBe(join(process.env.HOME!, ".hermes", "profiles", "reviewer", "config.yaml"));
    expect((await detectModel(resolveHermesConfigPath("reviewer")))?.model).toBe("anthropic/reviewer-model");
    expect(resolveHermesConfigPath("default")).toBe(join(process.env.HOME!, ".hermes", "config.yaml"));
    expect((await detectModel(resolveHermesConfigPath("default")))?.model).toBe("openrouter/root-model");
    return "";
  });
});

test("empty and default sticky active_profile select root", async () => {
  await withHermesHomeConfigs({
    default: ["model:", "  default: openrouter/root-model", "  provider: openrouter"],
    engineer: ["model:", "  default: openrouter/engineer-model", "  provider: openrouter"],
  }, async () => {
    await writeFile(join(process.env.HOME!, ".hermes", "active_profile"), "\n", "utf8");
    expect((await detectModel(resolveHermesConfigPath()))?.model).toBe("openrouter/root-model");

    await writeFile(join(process.env.HOME!, ".hermes", "active_profile"), "default\n", "utf8");
    expect((await detectModel(resolveHermesConfigPath()))?.model).toBe("openrouter/root-model");
    return "";
  });
});

test("S6 supervised child ignores sticky active_profile", async () => {
  await withHermesHomeConfigs({
    default: ["model:", "  default: openrouter/root-model", "  provider: openrouter"],
    engineer: ["model:", "  default: openrouter/engineer-model", "  provider: openrouter"],
  }, async () => {
    process.env.HERMES_S6_SUPERVISED_CHILD = "1";
    await writeFile(join(process.env.HOME!, ".hermes", "active_profile"), "engineer\n", "utf8");

    expect(resolveHermesConfigPath()).toBe(join(process.env.HOME!, ".hermes", "config.yaml"));
    expect((await detectModel(resolveHermesConfigPath()))?.model).toBe("openrouter/root-model");
    return "";
  });
});

test("profile-scoped HERMES_HOME bypasses root sticky active_profile", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  const root = join(tempHome, "custom-root");
  const profileHome = join(root, "profiles", "engineer");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HERMES_HOME = profileHome;
  delete process.env.HERMES_S6_SUPERVISED_CHILD;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  try {
    await mkdir(profileHome, { recursive: true });
    await mkdir(join(root, "profiles", "reviewer"), { recursive: true });
    await writeFile(join(root, "active_profile"), "reviewer\n", "utf8");
    expect(resolveHermesConfigPath()).toBe(join(profileHome, "config.yaml"));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("custom HERMES_HOME root reads its own sticky active_profile", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  const customRoot = join(tempHome, "custom-hermes-root");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HERMES_HOME = customRoot;
  delete process.env.HERMES_S6_SUPERVISED_CHILD;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  try {
    await mkdir(join(customRoot, "profiles", "engineer"), { recursive: true });
    await writeFile(join(customRoot, "active_profile"), "engineer\n", "utf8");
    await writeFile(join(customRoot, "profiles", "engineer", "config.yaml"), [
      "model:",
      "  default: oca/custom-sticky-model",
      "  provider: custom",
      "  api_key: custom-sticky-secret",
    ].join("\n"), "utf8");

    expect(resolveHermesConfigPath()).toBe(join(customRoot, "profiles", "engineer", "config.yaml"));
    expect((await detectModel(resolveHermesConfigPath()))?.model).toBe("oca/custom-sticky-model");
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("invalid sticky active_profile fails closed without leaking content or temp paths", async () => {
  await withHermesHomeConfigs({
    default: ["model:", "  default: openrouter/root-model", "  provider: openrouter"],
  }, async () => {
    const tempRoot = join(process.env.HOME!, ".hermes");
    const secretMarker = "SECRET_STICKY_MARKER";
    await writeFile(join(tempRoot, "active_profile"), `../${secretMarker}\n`, "utf8");

    expect(() => resolveHermesConfigPath()).toThrow(/active profile/i);
    try {
      resolveHermesConfigPath();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(tempRoot);
      expect(message).not.toContain(secretMarker);
    }
    return "";
  });
});

test("valid but missing sticky active_profile selection fails closed", async () => {
  await withHermesHomeConfigs({
    default: ["model:", "  default: openrouter/root-model", "  provider: openrouter"],
  }, async () => {
    await writeFile(join(process.env.HOME!, ".hermes", "active_profile"), "missing-profile\n", "utf8");

    expect(() => resolveHermesConfigPath()).toThrow(/selected Hermes profile/i);
    return "";
  });
});

test("resolveHermesConfigPath honors custom HERMES_HOME roots for default and named profiles", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  const customRoot = join(tempHome, "custom-hermes-root");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HERMES_HOME = customRoot;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  try {
    await mkdir(join(customRoot, "profiles", "engineer"), { recursive: true });
    expect(resolveHermesConfigPath()).toBe(join(customRoot, "config.yaml"));
    expect(resolveHermesConfigPath("default")).toBe(join(customRoot, "config.yaml"));
    expect(resolveHermesConfigPath("engineer")).toBe(join(customRoot, "profiles", "engineer", "config.yaml"));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("resolveHermesConfigPath mirrors profile-scoped HERMES_HOME semantics", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  const customRoot = join(tempHome, "custom-hermes-root");
  const profileHome = join(customRoot, "profiles", "engineer");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HERMES_HOME = profileHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  try {
    await mkdir(profileHome, { recursive: true });
    await mkdir(join(customRoot, "profiles", "reviewer"), { recursive: true });
    expect(resolveHermesConfigPath()).toBe(join(profileHome, "config.yaml"));
    expect(resolveHermesConfigPath("default")).toBe(join(customRoot, "config.yaml"));
    expect(resolveHermesConfigPath("reviewer")).toBe(join(customRoot, "profiles", "reviewer", "config.yaml"));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("resolveHermesConfigPath anchors explicit named profiles under native root when HERMES_HOME is inside native root", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  const nativeRoot = join(tempHome, ".hermes");
  const profileHome = join(nativeRoot, "profiles", "engineer");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HERMES_HOME = profileHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  try {
    await mkdir(profileHome, { recursive: true });
    await mkdir(join(nativeRoot, "profiles", "reviewer"), { recursive: true });
    expect(resolveHermesConfigPath()).toBe(join(profileHome, "config.yaml"));
    expect(resolveHermesConfigPath("default")).toBe(join(nativeRoot, "config.yaml"));
    expect(resolveHermesConfigPath("reviewer")).toBe(join(nativeRoot, "profiles", "reviewer", "config.yaml"));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("selected profile detection reads custom HERMES_HOME config instead of native home config", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  const nativeRoot = join(tempHome, ".hermes");
  const customRoot = join(tempHome, "custom-hermes-root");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HERMES_HOME = customRoot;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  for (const key of providerEnvKeys) {
    delete process.env[key];
  }

  try {
    await mkdir(join(nativeRoot, "profiles", "engineer"), { recursive: true });
    await mkdir(join(customRoot, "profiles", "engineer"), { recursive: true });
    await writeFile(join(nativeRoot, "profiles", "engineer", "config.yaml"), [
      "model:",
      "  default: openrouter/native-model",
      "  provider: openrouter",
      "  api_key: native-secret",
    ].join("\n"), "utf8");
    await writeFile(join(customRoot, "profiles", "engineer", "config.yaml"), [
      "model:",
      "  default: oca/custom-root-model",
      "  provider: custom",
      "  base_url: https://example.invalid/custom-root",
      "  api_key: custom-root-secret",
    ].join("\n"), "utf8");

    const detected = await detectModel(resolveHermesConfigPath("engineer"));

    expect(detected?.model).toBe("oca/custom-root-model");
    expect(detected?.provider).toBe("custom");
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("profile-aware model detection uses the selected Hermes profile config", async () => {
  await withHermesHomeConfigs({
    default: [
      "model:",
      "  default: openrouter/default-model",
      "  provider: openrouter",
      "  api_key: default-secret",
    ],
    engineer: [
      "model:",
      "  default: oca/profile-model",
      "  provider: custom",
      "  base_url: https://example.invalid/profile",
      "  api_key: profile-secret",
    ],
  }, async () => {
    const defaultDetected = await detectModel(resolveHermesConfigPath());
    const profileDetected = await detectModel(resolveHermesConfigPath("engineer"));

    expect(defaultDetected?.model).toBe("openrouter/default-model");
    expect(defaultDetected?.provider).toBe("openrouter");
    expect(profileDetected?.model).toBe("oca/profile-model");
    expect(profileDetected?.provider).toBe("custom");
    return "";
  });
});

test("testEnvironment detection uses the selected profile config over the default home config", async () => {
  await withHermesHomeConfigs({
    default: [
      "model:",
      "  default: openrouter/default-model",
      "  provider: openrouter",
      "  api_key: default-secret",
    ],
    engineer: [
      "model:",
      "  default: oca/profile-model",
      "  provider: custom",
      "  base_url: https://example.invalid/profile",
      "  api_key: profile-secret",
    ],
  }, async () => {
    for (const key of providerEnvKeys) {
      delete process.env[key];
    }
    const testEnvironment = createHermesEnvironmentTester({ runner: passingRunner });
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        profile: "engineer",
        model: "oca/profile-model",
      },
    });

    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("hermes_custom_provider_config");
    expect(codes).toContain("hermes_provider_unsupported");
    expect(codes).not.toContain("hermes_no_api_keys");
    return "";
  });
});

test("named profile API key check ignores default profile .env keys", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.HERMES_HOME;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  for (const key of providerEnvKeys) {
    delete process.env[key];
  }

  try {
    await mkdir(join(tempHome, ".hermes", "profiles", "engineer"), { recursive: true });
    await writeFile(join(tempHome, ".hermes", ".env"), "OPENROUTER_API_KEY=default-only\n", "utf8");
    await writeFile(join(tempHome, ".hermes", "profiles", "engineer", "config.yaml"), [
      "model:",
      "  default: openrouter/profile-model",
      "  provider: openrouter",
    ].join("\n"), "utf8");

    const testEnvironment = createHermesEnvironmentTester({ runner: passingRunner });
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        profile: "engineer",
        model: "openrouter/profile-model",
      },
    });

    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("hermes_no_api_keys");
    expect(codes).not.toContain("hermes_api_keys_found");
    expect(result.status).toBe("warn");
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("named profile API key check accepts selected profile .env keys", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.HERMES_HOME;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  for (const key of providerEnvKeys) {
    delete process.env[key];
  }

  try {
    await mkdir(join(tempHome, ".hermes", "profiles", "engineer"), { recursive: true });
    await writeFile(join(tempHome, ".hermes", ".env"), "OPENROUTER_API_KEY=default-only\n", "utf8");
    await writeFile(join(tempHome, ".hermes", "profiles", "engineer", ".env"), "OPENROUTER_API_KEY=profile-only\n", "utf8");
    await writeFile(join(tempHome, ".hermes", "profiles", "engineer", "config.yaml"), [
      "model:",
      "  default: openrouter/profile-model",
      "  provider: openrouter",
    ].join("\n"), "utf8");

    const testEnvironment = createHermesEnvironmentTester({ runner: passingRunner });
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        profile: "engineer",
        model: "openrouter/profile-model",
      },
    });

    const apiKeyCheck = result.checks.find((check) => check.code === "hermes_api_keys_found");
    expect(apiKeyCheck?.message).toBe("API keys found: OpenRouter");
    expect(result.status).toBe("pass");
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("named profile API key check accepts selected profile model config api_key", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.HERMES_HOME;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  for (const key of providerEnvKeys) {
    delete process.env[key];
  }

  try {
    await mkdir(join(tempHome, ".hermes", "profiles", "engineer"), { recursive: true });
    await writeFile(join(tempHome, ".hermes", ".env"), "OPENROUTER_API_KEY=default-only\n", "utf8");
    await writeFile(join(tempHome, ".hermes", "profiles", "engineer", "config.yaml"), [
      "model:",
      "  default: openrouter/profile-model",
      "  provider: openrouter",
      "  api_key: profile-config-secret",
    ].join("\n"), "utf8");

    const testEnvironment = createHermesEnvironmentTester({ runner: passingRunner });
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        profile: "engineer",
        model: "openrouter/profile-model",
      },
    });

    const apiKeyCheck = result.checks.find((check) => check.code === "hermes_api_key_in_config");
    expect(apiKeyCheck?.message).toMatch(/selected Hermes profile\/config/i);
    expect(apiKeyCheck?.message).not.toMatch(/~\/\.hermes/);
    expect(apiKeyCheck?.hint).not.toMatch(/~\/\.hermes/);
    expect(result.status).toBe("pass");
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});
