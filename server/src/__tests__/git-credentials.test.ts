import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_GITHUB_TOKEN_SECRET_NAMES,
  GIT_CREDENTIAL_TOKEN_ENV_KEY,
  buildGitAuthInvocation,
  createGitRemoteAuthProvider,
  describeGitAuthFailure,
  isGitHubHttpsRemoteUrl,
  scrubGitCredentialText,
} from "../services/git-credentials.ts";

const fakeDb = null as unknown as Db;

function buildSecretsFake(byName: Record<string, string | Error>) {
  const getByName = vi.fn(async (_companyId: string, name: string) => {
    if (!(name in byName)) return null;
    return { id: `secret-${name}` };
  });
  const resolveSecretValue = vi.fn(async (_companyId: string, secretId: string) => {
    const name = secretId.replace(/^secret-/, "");
    const value = byName[name];
    if (value instanceof Error) throw value;
    return value ?? "";
  });
  return { getByName, resolveSecretValue };
}

describe("isGitHubHttpsRemoteUrl", () => {
  it("accepts https github.com and www.github.com URLs", () => {
    expect(isGitHubHttpsRemoteUrl("https://github.com/example/repo.git")).toBe(true);
    expect(isGitHubHttpsRemoteUrl("https://www.github.com/example/repo.git")).toBe(true);
  });

  it("rejects ssh, http, enterprise hosts, other providers, userinfo URLs, and non-URLs", () => {
    expect(isGitHubHttpsRemoteUrl("git@github.com:example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("ssh://git@github.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("http://github.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("https://github.enterprise.example/org/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("https://gitlab.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("https://alice:token@github.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("/local/path/repo.git")).toBe(false);
  });
});

describe("createGitRemoteAuthProvider", () => {
  const githubUrl = "https://github.com/example/repo.git";

  it("prefers company secrets in declared order", async () => {
    const secrets = buildSecretsFake({ GH_TOKEN: "gh-token", PAPERCLIP_GITHUB_TOKEN: "pc-token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: { GITHUB_TOKEN: "env-token" },
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("gh-token");
    expect(invocation?.source).toBe("company_secret");
    expect(invocation?.secretName).toBe("GH_TOKEN");
    // GITHUB_TOKEN is probed first even though only GH_TOKEN exists.
    expect(secrets.getByName.mock.calls.map((call) => call[1])).toEqual(["GITHUB_TOKEN", "GH_TOKEN"]);
  });

  it("falls back to the server env, GITHUB_TOKEN before GH_TOKEN", async () => {
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets: buildSecretsFake({}),
      env: { GITHUB_TOKEN: "env-github", GH_TOKEN: "env-gh" },
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("env-github");
    expect(invocation?.source).toBe("server_env");
    expect(invocation?.secretName).toBeNull();
  });

  it("returns null when no token is available anywhere", async () => {
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets: buildSecretsFake({}),
      env: {},
    });
    await expect(provider(githubUrl)).resolves.toBeNull();
  });

  it("returns null for out-of-scope URLs without touching the secret store", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
    });
    await expect(provider("git@github.com:example/repo.git")).resolves.toBeNull();
    await expect(provider("https://gitlab.com/example/repo.git")).resolves.toBeNull();
    expect(secrets.getByName).not.toHaveBeenCalled();
  });

  it("memoizes the credential lookup across calls", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
    });
    await provider(githubUrl);
    await provider(githubUrl);
    await provider("https://github.com/example/another.git");
    expect(secrets.getByName).toHaveBeenCalledTimes(1);
    expect(secrets.resolveSecretValue).toHaveBeenCalledTimes(1);
  });

  it("passes a system access context so resolution is audited", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(
      fakeDb,
      "company-1",
      { issueId: "issue-1", heartbeatRunId: "run-1" },
      { secrets, env: {} },
    );
    await provider(githubUrl);
    expect(secrets.resolveSecretValue).toHaveBeenCalledWith("company-1", "secret-GITHUB_TOKEN", "latest", {
      accessContext: expect.objectContaining({
        consumerType: "system",
        consumerId: "workspace-git-credential",
        actorType: "system",
        issueId: "issue-1",
        heartbeatRunId: "run-1",
      }),
    });
  });

  it("continues down the chain when one secret fails to resolve", async () => {
    const secrets = buildSecretsFake({
      GITHUB_TOKEN: new Error("provider outage"),
      GH_TOKEN: "gh-token",
    });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.secretName).toBe("GH_TOKEN");
  });
});

describe("buildGitAuthInvocation", () => {
  it("keeps the token out of argv and carries it in env with prompts disabled", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "company_secret",
      secretName: "GITHUB_TOKEN",
    });
    expect(invocation.configArgs.join(" ")).not.toContain("super-secret-token");
    expect(invocation.configArgs[0]).toBe("-c");
    expect(invocation.configArgs[1]).toBe("credential.helper=");
    expect(invocation.configArgs[3]).toContain("x-access-token");
    expect(invocation.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("super-secret-token");
    expect(invocation.env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("credential helper execution (real git, no network)", () => {
  it("git credential fill answers with the env-carried token", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-cred-fill-"));
    try {
      const invocation = buildGitAuthInvocation({
        token: "abc123",
        source: "company_secret",
        secretName: "GITHUB_TOKEN",
      });
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn("git", [...invocation.configArgs, "credential", "fill"], {
          cwd,
          env: { ...process.env, ...invocation.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(`git credential fill exited ${code}: ${stderr}`));
        });
        child.stdin.write("protocol=https\nhost=github.com\n\n");
        child.stdin.end();
      });
      expect(output).toContain("username=x-access-token");
      expect(output).toContain("password=abc123");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("scrubGitCredentialText", () => {
  it("masks URL userinfo", () => {
    expect(scrubGitCredentialText("https://x-access-token:ghp_secret@github.com/a/b.git")).toBe(
      "https://***@github.com/a/b.git",
    );
  });

  it("masks userinfo on non-HTTP schemes, leaving scp-style remotes alone", () => {
    expect(scrubGitCredentialText("ssh://deploy:hunter2@internal.example/repo.git")).toBe(
      "ssh://***@internal.example/repo.git",
    );
    expect(scrubGitCredentialText("git@github.com:example/repo.git")).toBe(
      "git@github.com:example/repo.git",
    );
  });

  it("leaves credential-free text unchanged", () => {
    expect(scrubGitCredentialText("fatal: repository not found")).toBe("fatal: repository not found");
  });
});

describe("describeGitAuthFailure", () => {
  it("names the company secret when a stored credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "company_secret", secretName: "GH_TOKEN" },
    })).toContain("the GH_TOKEN company-secret GitHub credential");
  });

  it("names the server environment when an env credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "server_env", secretName: null },
    })).toContain("server-environment GitHub credential");
  });

  it("points at Settings → Secrets for auth-looking failures without a credential", () => {
    expect(describeGitAuthFailure({
      error: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      used: null,
    })).toContain("add a GITHUB_TOKEN or GH_TOKEN company secret");
  });

  it("stays silent for non-auth failures without a credential", () => {
    expect(describeGitAuthFailure({
      error: "fatal: unable to resolve host example.invalid",
      used: null,
    })).toBeNull();
  });
});

describe("DEFAULT_GITHUB_TOKEN_SECRET_NAMES", () => {
  it("keeps the shared name order stable", () => {
    expect([...DEFAULT_GITHUB_TOKEN_SECRET_NAMES]).toEqual([
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "PAPERCLIP_GITHUB_TOKEN",
    ]);
  });
});
