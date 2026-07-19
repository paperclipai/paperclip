import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPENCODE_MISSING_CREDENTIAL_MESSAGE,
  OPENCODE_PROVIDER_CREDENTIAL_ENV_KEYS,
  evaluateOpenCodeCredentialPreflight,
  resolveOpenCodeHostAuthPath,
} from "./credential-preflight.js";

describe("evaluateOpenCodeCredentialPreflight", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function emptyIsolatedEnv(): Promise<Record<string, string>> {
    // Point every host-filesystem lookup at empty temp dirs so the host state of
    // the machine running the tests cannot leak into the result.
    const dataHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-data-"));
    const configHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
    cleanupDirs.push(dataHome, configHome);
    return {
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: configHome,
    };
  }

  it("is not ready when no provider credential exists anywhere", async () => {
    const env = await emptyIsolatedEnv();
    const result = await evaluateOpenCodeCredentialPreflight({ env });
    expect(result.ready).toBe(false);
    expect(result.source).toBeNull();
  });

  it("is ready for each documented provider env key", async () => {
    for (const key of OPENCODE_PROVIDER_CREDENTIAL_ENV_KEYS) {
      const env = await emptyIsolatedEnv();
      env[key] = "test-key";
      const result = await evaluateOpenCodeCredentialPreflight({ env });
      expect(result.ready, `expected ${key} to satisfy the preflight`).toBe(true);
      expect(result.source).toBe("env");
    }
  });

  it("ignores empty and whitespace-only env values", async () => {
    const env = await emptyIsolatedEnv();
    env.ANTHROPIC_API_KEY = "   ";
    env.OPENAI_API_KEY = "";
    const result = await evaluateOpenCodeCredentialPreflight({ env });
    expect(result.ready).toBe(false);
  });

  it("treats a configured OpenAI-compatible base URL as a connected provider", async () => {
    const env = await emptyIsolatedEnv();
    env.OPENAI_API_BASE = "http://127.0.0.1:11434/v1";
    const result = await evaluateOpenCodeCredentialPreflight({ env });
    expect(result.ready).toBe(true);
    expect(result.source).toBe("env");
  });

  it("treats injected gateway providers (PAPERCLIP_OPENCODE_PROVIDERS) as credentials", async () => {
    const env = await emptyIsolatedEnv();
    env.PAPERCLIP_OPENCODE_PROVIDERS = JSON.stringify({
      "eu-gateway": { options: { baseURL: "https://gateway.example/v1", apiKey: "vk-123" }, models: {} },
    });
    const result = await evaluateOpenCodeCredentialPreflight({ env });
    expect(result.ready).toBe(true);
    expect(result.source).toBe("custom_providers");
  });

  it("does not treat malformed PAPERCLIP_OPENCODE_PROVIDERS as credentials", async () => {
    const env = await emptyIsolatedEnv();
    env.PAPERCLIP_OPENCODE_PROVIDERS = "{not json";
    const result = await evaluateOpenCodeCredentialPreflight({ env });
    expect(result.ready).toBe(false);
  });

  it("treats host-level opencode auth (auth.json in the data dir) as credentials", async () => {
    const env = await emptyIsolatedEnv();
    const authPath = resolveOpenCodeHostAuthPath(env);
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, JSON.stringify({ anthropic: { type: "oauth", refresh: "r", access: "a" } }), "utf8");
    const result = await evaluateOpenCodeCredentialPreflight({ env });
    expect(result.ready).toBe(true);
    expect(result.source).toBe("host_auth");
  });

  it("ignores an empty or unparseable host auth.json", async () => {
    const env = await emptyIsolatedEnv();
    const authPath = resolveOpenCodeHostAuthPath(env);
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, "{}", "utf8");
    expect((await evaluateOpenCodeCredentialPreflight({ env })).ready).toBe(false);
    await writeFile(authPath, "not json", "utf8");
    expect((await evaluateOpenCodeCredentialPreflight({ env })).ready).toBe(false);
  });

  it("treats provider blocks in the host opencode config as credentials", async () => {
    const env = await emptyIsolatedEnv();
    const configPath = path.join(env.XDG_CONFIG_HOME!, "opencode", "opencode.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ provider: { local: { options: { baseURL: "http://127.0.0.1:8080/v1" } } } }),
      "utf8",
    );
    const result = await evaluateOpenCodeCredentialPreflight({ env });
    expect(result.ready).toBe(true);
    expect(result.source).toBe("host_config");
  });

  it("keeps the missing-credential message plain and actionable", () => {
    expect(OPENCODE_MISSING_CREDENTIAL_MESSAGE).toBe(
      "No model provider credential is connected for this agent. Connect a provider key, then resume.",
    );
  });
});
