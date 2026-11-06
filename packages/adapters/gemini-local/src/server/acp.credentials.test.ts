import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testGeminiAcpEnvironment } from "./acp.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-credentials-"));
  for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_GCA", "GEMINI_CLI_HOME"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", path.join(root, "host-home"));
  vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "host-home"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeCredential(home: string, name: string) {
  await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
  await fs.writeFile(path.join(home, ".gemini", name), "credential-content-sentinel", { mode: 0o600 });
}

function probe(env: Record<string, string> = {}) {
  return testGeminiAcpEnvironment({
    adapterType: "gemini_local",
    companyId: "company-1",
    config: { cwd: root, agentCommand: process.execPath, env },
  });
}

describe("Gemini ACP local credential detection", () => {
  it.each(["gemini-credentials.json", "oauth_creds.json"])(
    "detects %s in the configured HOME without exposing its contents",
    async (name) => {
      const home = path.join(root, "agent-home");
      await writeCredential(home, name);
      const result = await probe({ HOME: home });
      expect(result.status).toBe("pass");
      expect(result.checks).toContainEqual(expect.objectContaining({
        code: "gemini_acp_credentials_detected", level: "info",
      }));
      expect(JSON.stringify(result)).not.toContain("credential-content-sentinel");
    },
  );

  it("detects credentials in the process home when HOME is not configured", async () => {
    await writeCredential(os.homedir(), "oauth_creds.json");
    expect((await probe()).status).toBe("pass");
  });

  it("does not use process-home credentials when the adapter selects another HOME", async () => {
    await writeCredential(os.homedir(), "oauth_creds.json");
    const result = await probe({ HOME: path.join(root, "agent-home") });
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "gemini_acp_credentials_not_detected", level: "warn",
    }));
  });

  it("uses the configured GEMINI_CLI_HOME before HOME", async () => {
    const home = path.join(root, "gemini-home");
    await writeCredential(home, "oauth_creds.json");
    expect((await probe({ HOME: path.join(root, "agent-home"), GEMINI_CLI_HOME: home })).status).toBe("pass");
  });

  it.each(["missing", "directory", "empty"])("keeps the warning for a %s credential file", async (kind) => {
    const home = path.join(root, "agent-home");
    const credential = path.join(home, ".gemini", "oauth_creds.json");
    await fs.mkdir(path.dirname(credential), { recursive: true });
    if (kind === "directory") await fs.mkdir(credential);
    if (kind === "empty") await fs.writeFile(credential, "");
    expect((await probe({ HOME: home })).checks).toContainEqual(expect.objectContaining({
      code: "gemini_acp_credentials_not_detected", level: "warn",
    }));
  });

  it("keeps the warning when the credential file cannot be read", async () => {
    const home = path.join(root, "agent-home");
    await writeCredential(home, "oauth_creds.json");
    const credential = path.join(home, ".gemini", "oauth_creds.json");
    const access = fs.access.bind(fs);
    vi.spyOn(fs, "access").mockImplementation(async (candidate, mode) => {
      if (candidate === credential) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      return access(candidate, mode);
    });
    expect((await probe({ HOME: home })).checks).toContainEqual(expect.objectContaining({
      code: "gemini_acp_credentials_not_detected", level: "warn",
    }));
  });

  it("does not use HOME credentials when GEMINI_CLI_HOME selects another directory", async () => {
    const home = path.join(root, "agent-home");
    await writeCredential(home, "oauth_creds.json");
    expect((await probe({ HOME: home, GEMINI_CLI_HOME: path.join(root, "empty-home") })).status).toBe("warn");
  });

  it.each<Record<string, string>>([
    { GEMINI_API_KEY: "test-key" },
    { GOOGLE_API_KEY: "test-key" },
    { GOOGLE_GENAI_USE_GCA: "true" },
  ])("still detects configured environment credentials: %j", async (env) => {
    expect((await probe(env)).status).toBe("pass");
  });

  it("does not count local credential files for a remote execution target", async () => {
    const home = path.join(root, "agent-home");
    await writeCredential(home, "oauth_creds.json");
    const result = await testGeminiAcpEnvironment({
      adapterType: "gemini_local", companyId: "company-1",
      config: { cwd: root, agentCommand: '"gemini" --acp', env: { HOME: home } },
      executionTarget: { kind: "remote", transport: "sandbox", providerKey: "test-provider", remoteCwd: "/work" },
    });
    expect(result.checks.some((check) => check.code === "gemini_acp_credentials_detected")).toBe(false);
  });
});
