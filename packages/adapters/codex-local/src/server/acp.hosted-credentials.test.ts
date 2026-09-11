import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testCodexAcpEnvironment } from "./acp.js";

// Regression guard for advice a hosted user cannot act on.
//
// The probe used to answer a missing credential with "run `codex login` for the
// same OS user that runs the Paperclip server". On a self-hosted install that is
// fine: the host is the user's own machine. On a hosted multi-tenant install it
// is a dead end, and a customer who picked Codex expecting his ChatGPT plan to
// work followed that hint until he gave up and asked for a refund.
//
// The subtler half is credential *reporting*. Readiness falls back to
// `codexHomeHasUsableAuth(sharedSourceHome)`, i.e. the server's own Codex home.
// On a hosted install that credential belongs to the operator or another
// tenant, so a tenant could be told they were authenticated by someone else's
// login. The hosted branch therefore sits above every host-derived signal.
//
// `callerControlsHost: false` is how the server says "this person is a tenant,
// not the operator". These tests pin both directions.

const baseConfig = {
  engine: "acp",
  // Deliberately not "codex": keeps the probe on the credential branch instead
  // of resolving and spawning a real ACP server on the test machine.
  agentCommand: "/nonexistent/codex-acp",
  env: {},
};

let hostHome: string;

beforeEach(async () => {
  // Point the "server's own Codex home" at a directory we control, so these
  // assertions describe the code and not whether the machine running them
  // happens to have a real ~/.codex. Without this the suite passes on CI and
  // fails on any developer laptop with Codex logged in.
  hostHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-hosttest-"));
  vi.stubEnv("CODEX_HOME", path.join(hostHome, "codex"));
  vi.stubEnv("HOME", hostHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(hostHome, { recursive: true, force: true }).catch(() => {});
});

/** Gives the server host a usable Codex credential, as a logged-in operator would. */
async function seedHostCredential() {
  const home = path.join(hostHome, "codex");
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, "auth.json"),
    // Shape `hasUsableAuthPayload` accepts for subscription auth: a token
    // bundle carrying an account id, which is what `codex login` writes.
    JSON.stringify({
      tokens: { account_id: "acct-operator", access_token: "at", refresh_token: "rt" },
    }),
  );
}

describe("Codex ACP credential advice on a hosted install", () => {
  it("tells a tenant to add a key, never to run `codex login`", async () => {
    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: baseConfig,
      callerControlsHost: false,
    });

    const missing = result.checks.find((check) => check.code === "codex_acp_credentials_missing");
    expect(missing).toBeTruthy();
    expect(missing?.hint).toContain("Add an OpenAI API key");
    // The plan question is the one they actually arrived with. Leaving it
    // unanswered is what sent the customer looking for a route that is not there.
    expect(missing?.hint).toContain("ChatGPT Plus or Pro plan cannot be used here");
    // `codex login` may still be NAMED as the reason a plan cannot work, but
    // never issued as something to go and do on the server.
    expect(missing?.hint).not.toContain("run `codex login`");
  });

  it("never reports the host's own credential as the tenant's", async () => {
    // The operator is logged in on the server. That is not this tenant's login,
    // and claiming otherwise would send them off to debug a working-looking
    // agent that fails on its first real run.
    await seedHostCredential();

    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: baseConfig,
      callerControlsHost: false,
    });

    expect(result.checks.some((check) => check.code === "codex_acp_native_auth_detected")).toBe(false);
    expect(result.checks.some((check) => check.code === "codex_acp_credentials_missing")).toBe(true);
  });

  it("still accepts a key configured on the agent itself", async () => {
    // The hosted branch must not swallow the tenant's OWN credential, which is
    // the one thing that does work here.
    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { ...baseConfig, env: { OPENAI_API_KEY: "sk-proj-test" } },
      callerControlsHost: false,
    });

    expect(result.checks.some((check) => check.code === "codex_acp_credentials_missing")).toBe(false);
    expect(result.checks.some((check) => check.code === "codex_acp_openai_api_key_detected")).toBe(true);
  });

  it("keeps host advice and host credential reporting for a self-hosted operator", async () => {
    // Default (field omitted) is the single-operator install, where the host
    // really is the user's machine: their login counts and `codex login` is the
    // right thing to tell them.
    await seedHostCredential();
    const detected = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: baseConfig,
    });
    expect(detected.checks.some((check) => check.code === "codex_acp_native_auth_detected")).toBe(true);

    await fs.rm(path.join(hostHome, "codex"), { recursive: true, force: true });
    const missing = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: baseConfig,
    });
    const check = missing.checks.find((c) => c.code === "codex_acp_credentials_missing");
    expect(check).toBeTruthy();
    expect(check?.hint).toContain("codex login");
  });
});
