import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_GITHUB_TOKEN_SECRET_NAMES,
  DEFAULT_GITLAB_TOKEN_SECRET_NAMES,
  GIT_CREDENTIAL_TOKEN_ENV_KEY,
  buildGitAuthInvocation,
  createGitRemoteAuthProvider,
  describeGitAuthFailure,
  isGitHubHttpsRemoteUrl,
  isGitLabHttpsRemoteUrl,
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

describe("isGitLabHttpsRemoteUrl", () => {
  it("accepts https gitlab.com and www.gitlab.com URLs", () => {
    expect(isGitLabHttpsRemoteUrl("https://gitlab.com/example/repo.git")).toBe(true);
    expect(isGitLabHttpsRemoteUrl("https://www.gitlab.com/example/repo.git")).toBe(true);
  });

  it("rejects ssh, http, self-managed hosts, other providers, userinfo URLs, and non-URLs", () => {
    expect(isGitLabHttpsRemoteUrl("git@gitlab.com:example/repo.git")).toBe(false);
    expect(isGitLabHttpsRemoteUrl("ssh://git@gitlab.com/example/repo.git")).toBe(false);
    expect(isGitLabHttpsRemoteUrl("http://gitlab.com/example/repo.git")).toBe(false);
    expect(isGitLabHttpsRemoteUrl("https://gitlab.internal.example/org/repo.git")).toBe(false);
    expect(isGitLabHttpsRemoteUrl("https://github.com/example/repo.git")).toBe(false);
    expect(isGitLabHttpsRemoteUrl("https://oauth2:token@gitlab.com/example/repo.git")).toBe(false);
    expect(isGitLabHttpsRemoteUrl("/local/path/repo.git")).toBe(false);
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
    await expect(provider("https://bitbucket.org/example/repo.git")).resolves.toBeNull();
    await expect(provider("https://gitlab.internal.example/example/repo.git")).resolves.toBeNull();
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

  describe("GitLab", () => {
    const gitlabUrl = "https://gitlab.com/example/repo.git";

    it("resolves a GITLAB_TOKEN company secret", async () => {
      const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets,
        env: {},
      });
      const invocation = await provider(gitlabUrl);
      expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("glpat-token");
      expect(invocation?.source).toBe("company_secret");
      expect(invocation?.secretName).toBe("GITLAB_TOKEN");
      expect(invocation?.providerId).toBe("gitlab");
    });

    it("falls back to the server env GITLAB_TOKEN", async () => {
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets: buildSecretsFake({}),
        env: { GITLAB_TOKEN: "env-gitlab" },
      });
      const invocation = await provider(gitlabUrl);
      expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("env-gitlab");
      expect(invocation?.source).toBe("server_env");
      expect(invocation?.secretName).toBeNull();
      expect(invocation?.providerId).toBe("gitlab");
    });

    it("never probes GitHub secret names for a GitLab remote, and vice versa", async () => {
      const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets,
        env: {},
      });
      await provider(gitlabUrl);
      expect(secrets.getByName.mock.calls.map((call) => call[1])).toEqual([
        "GITLAB_TOKEN",
      ]);
    });

    it("resolves GitHub and GitLab credentials independently within one run", async () => {
      const secrets = buildSecretsFake({ GITHUB_TOKEN: "gh-token", GITLAB_TOKEN: "gl-token" });
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets,
        env: {},
      });
      const githubInvocation = await provider(githubUrl);
      const gitlabInvocation = await provider(gitlabUrl);
      expect(githubInvocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("gh-token");
      expect(gitlabInvocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("gl-token");
      // One lookup chain per host, not one shared/cross-contaminated lookup.
      expect(secrets.getByName.mock.calls.map((call) => call[1])).toEqual(["GITHUB_TOKEN", "GITLAB_TOKEN"]);
    });
  });

  describe("self-hosted GitLab (PAPERCLIP_GITLAB_HOSTS)", () => {
    const selfHostedUrl = "https://gitlab.mycompany.com/example/repo.git";

    it("is out of scope with no PAPERCLIP_GITLAB_HOSTS configured", async () => {
      const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets,
        env: {},
      });
      await expect(provider(selfHostedUrl)).resolves.toBeNull();
      expect(secrets.getByName).not.toHaveBeenCalled();
    });

    it("authenticates a configured self-hosted host with the same GITLAB_TOKEN secret", async () => {
      const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets,
        env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com" },
      });
      const invocation = await provider(selfHostedUrl);
      expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("glpat-token");
      expect(invocation?.providerId).toBe("gitlab");
      // Scoped to exactly the self-hosted host, never gitlab.com.
      expect(invocation?.configArgs.join(" ")).toContain("credential.https://gitlab.mycompany.com.helper=");
      expect(invocation?.configArgs.join(" ")).not.toContain("credential.https://gitlab.com.helper=");
    });

    it("accepts a full URL entry and normalizes it to a bare hostname", async () => {
      const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets,
        env: { PAPERCLIP_GITLAB_HOSTS: "https://gitlab.mycompany.com/" },
      });
      await expect(provider(selfHostedUrl)).resolves.not.toBeNull();
    });

    it("supports multiple comma-separated self-hosted hosts", async () => {
      const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets,
        env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.a.example, gitlab.mycompany.com ,gitlab.b.example" },
      });
      const invocation = await provider(selfHostedUrl);
      expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("glpat-token");
      // Scoped only to the one host actually being cloned, not the other configured hosts.
      expect(invocation?.configArgs.join(" ")).not.toContain("gitlab.a.example");
      expect(invocation?.configArgs.join(" ")).not.toContain("gitlab.b.example");
    });

    it("stays out of scope for a host not in the configured list", async () => {
      const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets,
        env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.other-company.example" },
      });
      await expect(provider(selfHostedUrl)).resolves.toBeNull();
    });

    it("still authenticates gitlab.com itself when self-hosted hosts are also configured", async () => {
      const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets,
        env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com" },
      });
      const invocation = await provider("https://gitlab.com/example/repo.git");
      expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("glpat-token");
      expect(invocation?.configArgs.join(" ")).toContain("credential.https://gitlab.com.helper=");
      // The default SaaS match keeps scoping to both SaaS hosts, unaffected by self-hosted config.
      expect(invocation?.configArgs.join(" ")).toContain("credential.https://www.gitlab.com.helper=");
    });

    it("falls back to the server env GITLAB_TOKEN for a self-hosted host too", async () => {
      const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
        secrets: buildSecretsFake({}),
        env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com", GITLAB_TOKEN: "env-gitlab" },
      });
      const invocation = await provider(selfHostedUrl);
      expect(invocation?.source).toBe("server_env");
      expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("env-gitlab");
    });

    describe("custom ports", () => {
      const portedUrl = "https://gitlab.mycompany.com:1234/example/repo.git";

      it("matches a configured host:port exactly, scoping the helper to host:port", async () => {
        const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
        const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
          secrets,
          env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com:1234" },
        });
        const invocation = await provider(portedUrl);
        expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("glpat-token");
        // The config key must carry the port too -- git only consults credential.<url>.helper
        // for the exact port it specifies (an omitted port matches only the default port).
        expect(invocation?.configArgs.join(" ")).toContain(
          "credential.https://gitlab.mycompany.com:1234.helper=",
        );
      });

      it("accepts a configured full URL with a port", async () => {
        const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
        const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
          secrets,
          env: { PAPERCLIP_GITLAB_HOSTS: "https://gitlab.mycompany.com:1234/" },
        });
        await expect(provider(portedUrl)).resolves.not.toBeNull();
      });

      it("does not match when the configured host omits the port the remote actually uses", async () => {
        const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
        const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
          // Configured without a port; the remote is on a non-default one. Least-privilege
          // means this must stay out of scope rather than guessing the operator meant any port.
          secrets,
          env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com" },
        });
        await expect(provider(portedUrl)).resolves.toBeNull();
      });

      it("does not match a different port than the one configured", async () => {
        const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
        const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
          secrets,
          env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com:5678" },
        });
        await expect(provider(portedUrl)).resolves.toBeNull();
      });
    });

    describe("custom CA (PAPERCLIP_GITLAB_CA_CERT_PATH)", () => {
      it("sets GIT_SSL_CAINFO for a self-hosted match when a CA cert path is configured", async () => {
        const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
        const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
          secrets,
          env: {
            PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com",
            PAPERCLIP_GITLAB_CA_CERT_PATH: "/paperclip/ca/lab-ca.pem",
          },
        });
        const invocation = await provider(selfHostedUrl);
        expect(invocation?.env.GIT_SSL_CAINFO).toBe("/paperclip/ca/lab-ca.pem");
      });

      it("does not set GIT_SSL_CAINFO when no CA cert path is configured", async () => {
        const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
        const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
          secrets,
          env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com" },
        });
        const invocation = await provider(selfHostedUrl);
        expect(invocation?.env.GIT_SSL_CAINFO).toBeUndefined();
      });

      it("never sets GIT_SSL_CAINFO for gitlab.com itself, even with a CA cert path configured", async () => {
        // GIT_SSL_CAINFO replaces (not augments) git's default trust store for the process it
        // is set on. Applying a self-hosted CA bundle to a gitlab.com clone would break that
        // clone's TLS verification unless the bundle happened to also carry the public roots.
        const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
        const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
          secrets,
          env: {
            PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com",
            PAPERCLIP_GITLAB_CA_CERT_PATH: "/paperclip/ca/lab-ca.pem",
          },
        });
        const invocation = await provider("https://gitlab.com/example/repo.git");
        expect(invocation?.env.GIT_SSL_CAINFO).toBeUndefined();
      });

      it("trims whitespace and treats a blank configured path as unset", async () => {
        const secrets = buildSecretsFake({ GITLAB_TOKEN: "glpat-token" });
        const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
          secrets,
          env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com", PAPERCLIP_GITLAB_CA_CERT_PATH: "   " },
        });
        const invocation = await provider(selfHostedUrl);
        expect(invocation?.env.GIT_SSL_CAINFO).toBeUndefined();
      });

      it("never leaks the CA path into a GitHub invocation from the same provider, in either call order", async () => {
        // Each invocation is a freshly-built env object for one specific execFile("git", ...)
        // call, not process-wide state -- a mixed GitHub + self-hosted-GitLab company must see
        // no cross-contamination regardless of which project is cloned first, or whether the
        // per-provider credential memoization (keyed by providerId) is warm for one host and
        // cold for the other.
        const secrets = buildSecretsFake({ GITHUB_TOKEN: "gh-token", GITLAB_TOKEN: "glpat-token" });

        const forward = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
          secrets,
          env: {
            PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com",
            PAPERCLIP_GITLAB_CA_CERT_PATH: "/paperclip/ca/lab-ca.pem",
          },
        });
        const gitlabFirst = await forward(selfHostedUrl);
        const githubSecond = await forward(githubUrl);
        expect(gitlabFirst?.env.GIT_SSL_CAINFO).toBe("/paperclip/ca/lab-ca.pem");
        expect(githubSecond?.env.GIT_SSL_CAINFO).toBeUndefined();
        expect(githubSecond?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("gh-token");

        const reversed = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
          secrets,
          env: {
            PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com",
            PAPERCLIP_GITLAB_CA_CERT_PATH: "/paperclip/ca/lab-ca.pem",
          },
        });
        const githubFirst = await reversed(githubUrl);
        const gitlabSecond = await reversed(selfHostedUrl);
        expect(githubFirst?.env.GIT_SSL_CAINFO).toBeUndefined();
        expect(gitlabSecond?.env.GIT_SSL_CAINFO).toBe("/paperclip/ca/lab-ca.pem");
      });
    });
  });
});

describe("buildGitAuthInvocation", () => {
  it("keeps the token out of argv and installs the helper URL-scoped to github.com", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "company_secret",
      secretName: "GITHUB_TOKEN",
      providerId: "github",
    });
    expect(invocation.configArgs.join(" ")).not.toContain("super-secret-token");
    expect(invocation.configArgs[0]).toBe("-c");
    expect(invocation.configArgs[1]).toBe("credential.helper=");
    expect(invocation.configArgs[3]).toContain("credential.https://github.com.helper=");
    expect(invocation.configArgs[3]).toContain("x-access-token");
    expect(invocation.configArgs[5]).toContain("credential.https://www.github.com.helper=");
    expect(invocation.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("super-secret-token");
    expect(invocation.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(invocation.providerId).toBe("github");
  });

  it("keeps the token out of argv and installs the helper URL-scoped to gitlab.com", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "company_secret",
      secretName: "GITLAB_TOKEN",
      providerId: "gitlab",
    });
    expect(invocation.configArgs.join(" ")).not.toContain("super-secret-token");
    expect(invocation.configArgs[0]).toBe("-c");
    expect(invocation.configArgs[1]).toBe("credential.helper=");
    expect(invocation.configArgs[3]).toContain("credential.https://gitlab.com.helper=");
    expect(invocation.configArgs[3]).toContain("oauth2");
    expect(invocation.configArgs[5]).toContain("credential.https://www.gitlab.com.helper=");
    expect(invocation.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("super-secret-token");
    expect(invocation.providerId).toBe("gitlab");
  });

  it("scopes the helper to exactly the given hosts when scopedHosts is passed", () => {
    const invocation = buildGitAuthInvocation(
      {
        token: "super-secret-token",
        source: "company_secret",
        secretName: "GITLAB_TOKEN",
        providerId: "gitlab",
      },
      ["gitlab.mycompany.com"],
    );
    const joined = invocation.configArgs.join(" ");
    expect(joined).toContain("credential.https://gitlab.mycompany.com.helper=");
    expect(joined).toContain("oauth2");
    expect(joined).not.toContain("credential.https://gitlab.com.helper=");
    expect(joined).not.toContain("credential.https://www.gitlab.com.helper=");
  });

  it("sets GIT_SSL_CAINFO when a caCertPath is passed", () => {
    const invocation = buildGitAuthInvocation(
      {
        token: "super-secret-token",
        source: "company_secret",
        secretName: "GITLAB_TOKEN",
        providerId: "gitlab",
      },
      ["gitlab.mycompany.com"],
      "/paperclip/ca/lab-ca.pem",
    );
    expect(invocation.env.GIT_SSL_CAINFO).toBe("/paperclip/ca/lab-ca.pem");
  });

  it("omits GIT_SSL_CAINFO when no caCertPath is passed", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "company_secret",
      secretName: "GITHUB_TOKEN",
      providerId: "github",
    });
    expect(invocation.env.GIT_SSL_CAINFO).toBeUndefined();
  });
});

describe("credential helper execution (real git, no network)", () => {
  async function runCredentialFill(description: string, providerId: "github" | "gitlab" = "github") {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-cred-fill-"));
    try {
      const invocation = buildGitAuthInvocation({
        token: "abc123",
        source: "company_secret",
        secretName: providerId === "github" ? "GITHUB_TOKEN" : "GITLAB_TOKEN",
        providerId,
      });
      return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
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
          child.on("close", (code) => resolve({ code, stdout, stderr }));
          child.stdin.write(description);
          child.stdin.end();
        },
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }

  it("answers a github.com https request with the env-carried token", async () => {
    const result = await runCredentialFill("protocol=https\nhost=github.com\n\n");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("username=x-access-token");
    expect(result.stdout).toContain("password=abc123");
  });

  it("never hands the token to another host, even if git asks", async () => {
    // Simulates a request whose effective host changed after our pre-invocation URL check
    // (for example a repository-local url.<base>.insteadOf rewrite): the URL-scoped helper
    // config keeps git from consulting the helper, prompts are disabled, so the fill fails
    // and the token is never emitted.
    const result = await runCredentialFill("protocol=https\nhost=evil.example\n\n");
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("abc123");
  });

  it("never answers plain-http requests for github.com", async () => {
    const result = await runCredentialFill("protocol=http\nhost=github.com\n\n");
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("abc123");
  });

  it("answers a gitlab.com https request with the env-carried token, using the oauth2 username", async () => {
    const result = await runCredentialFill("protocol=https\nhost=gitlab.com\n\n", "gitlab");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("username=oauth2");
    expect(result.stdout).toContain("password=abc123");
  });

  it("a gitlab-scoped invocation never answers for github.com", async () => {
    const result = await runCredentialFill("protocol=https\nhost=github.com\n\n", "gitlab");
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("abc123");
  });

  it("a github-scoped invocation never answers for gitlab.com", async () => {
    const result = await runCredentialFill("protocol=https\nhost=gitlab.com\n\n", "github");
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("abc123");
  });

  it("answers a self-hosted request on a custom port, with the port in git's host= line", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-cred-fill-port-"));
    try {
      const invocation = buildGitAuthInvocation(
        {
          token: "abc123",
          source: "company_secret",
          secretName: "GITLAB_TOKEN",
          providerId: "gitlab",
        },
        ["gitlab.mycompany.com:1234"],
      );
      const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn("git", [...invocation.configArgs, "credential", "fill"], {
          cwd,
          env: { ...process.env, ...invocation.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout }));
        // Git's credential protocol carries the port as part of `host=` for a non-default port.
        child.stdin.write("protocol=https\nhost=gitlab.mycompany.com:1234\n\n");
        child.stdin.end();
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("username=oauth2");
      expect(result.stdout).toContain("password=abc123");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("answers a self-hosted request on a bracketed IPv6 host", async () => {
    // A bracketed IPv6 host lands unescaped in the credential helper's shell `case` pattern
    // unless `[`/`]` are escaped there -- the shell would otherwise read them as a glob
    // character class instead of literal brackets, and the pattern would never match.
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-cred-fill-ipv6-"));
    try {
      const invocation = buildGitAuthInvocation(
        {
          token: "abc123",
          source: "company_secret",
          secretName: "GITLAB_TOKEN",
          providerId: "gitlab",
        },
        ["[2001:db8::1]:8443"],
      );
      const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn("git", [...invocation.configArgs, "credential", "fill"], {
          cwd,
          env: { ...process.env, ...invocation.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout }));
        child.stdin.write("protocol=https\nhost=[2001:db8::1]:8443\n\n");
        child.stdin.end();
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("username=oauth2");
      expect(result.stdout).toContain("password=abc123");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

// This module never sends real bytes over the wire on its own (`buildGitAuthInvocation` only
// prepares config); GIT_SSL_CAINFO is trusted to work exactly as git's own docs say. Prove that
// trust against a real self-signed TLS server instead of assuming it: without GIT_SSL_CAINFO
// git must reject the self-signed cert, and with it pointed at the exact cert, git must get
// past the TLS handshake (and only then fail for an unrelated reason -- there is no real git
// server behind the test endpoint).
//
// The availability check must be synchronous and run at collection time (not inside beforeAll):
// `describe.skipIf`/`it.skipIf` evaluate their condition immediately when called, before any
// hook runs, so a boolean only known once an async beforeAll completes would never take effect.
const opensslAvailable = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!opensslAvailable)("GIT_SSL_CAINFO against a real self-signed TLS server", () => {
  const execFileAsync = promisify(execFile);
  let workDir: string;
  let certPath: string;
  let server: https.Server;
  let baseUrl: string;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-ca-test-"));
    certPath = path.join(workDir, "cert.pem");
    const keyPath = path.join(workDir, "key.pem");
    await execFileAsync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ]);
    const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
    server = https.createServer({ key, cert }, (_req, res) => {
      res.writeHead(404);
      res.end("not a real git server");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `https://127.0.0.1:${port}/example/repo.git`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  it("rejects the self-signed cert with no GIT_SSL_CAINFO", async () => {
    await expect(
      execFileAsync("git", ["ls-remote", baseUrl], { env: { ...process.env } }),
    ).rejects.toThrow(/certificate|SSL|TLS/i);
  });

  it("gets past the TLS handshake once GIT_SSL_CAINFO points at the exact cert", async () => {
    const error = await execFileAsync("git", ["ls-remote", baseUrl], {
      env: { ...process.env, GIT_SSL_CAINFO: certPath },
    }).then(
      () => null,
      (err: unknown) => err as { stderr?: string; message: string },
    );
    // Still fails -- there is no real git smart-HTTP backend behind the test endpoint -- but
    // the failure must not be a certificate/TLS error, proving trust was actually established.
    expect(error).not.toBeNull();
    const failureText = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
    expect(failureText).not.toMatch(/certificate|SSL certificate problem|unable to get local issuer/i);
    expect(failureText).toMatch(/not found|repository/i);
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

  it("masks entire URL query strings regardless of parameter names", () => {
    expect(scrubGitCredentialText("https://github.com/a/b.git?access_token=ghs_secret&ref=main")).toBe(
      "https://github.com/a/b.git?***",
    );
    expect(scrubGitCredentialText("https://host.example/r.git?obscure_cred_name=secret")).toBe(
      "https://host.example/r.git?***",
    );
  });

  it("leaves credential-free text unchanged", () => {
    expect(scrubGitCredentialText("fatal: repository not found")).toBe("fatal: repository not found");
  });
});

describe("describeGitAuthFailure", () => {
  it("names the company secret when a stored GitHub credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "company_secret", secretName: "GH_TOKEN", providerId: "github" },
    })).toContain("the GH_TOKEN company-secret GitHub credential");
  });

  it("names the server environment when an env GitHub credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "server_env", secretName: null, providerId: "github" },
    })).toContain("server-environment GitHub credential");
  });

  it("names the company secret when a stored GitLab credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "company_secret", secretName: "GITLAB_TOKEN", providerId: "gitlab" },
    })).toContain("the GITLAB_TOKEN company-secret GitLab credential");
  });

  it("names the server environment when an env GitLab credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "server_env", secretName: null, providerId: "gitlab" },
    })).toContain("server-environment GitLab credential");
  });

  it("points at Settings → Secrets for a GitHub remote with no credential", () => {
    expect(describeGitAuthFailure({
      error: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      used: null,
      remoteUrl: "https://github.com/example/repo.git",
    })).toContain("No GitHub credential is configured — add a GITHUB_TOKEN or GH_TOKEN company secret");
  });

  it("points at Settings → Secrets for a GitLab remote with no credential", () => {
    expect(describeGitAuthFailure({
      error: "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled",
      used: null,
      remoteUrl: "https://gitlab.com/example/repo.git",
    })).toContain("No GitLab credential is configured — add a GITLAB_TOKEN company secret");
  });

  it("falls back to generic guidance when the remote's provider is unknown", () => {
    expect(describeGitAuthFailure({
      error: "fatal: could not read Username for 'https://bitbucket.org': terminal prompts disabled",
      used: null,
      remoteUrl: "https://bitbucket.org/example/repo.git",
    })).toContain("No git credential is configured — add a GITHUB_TOKEN/GH_TOKEN or GITLAB_TOKEN company secret");
  });

  it("recognizes a configured self-hosted GitLab remote with no credential", () => {
    expect(describeGitAuthFailure({
      error: "fatal: could not read Username for 'https://gitlab.mycompany.com': terminal prompts disabled",
      used: null,
      remoteUrl: "https://gitlab.mycompany.com/example/repo.git",
      env: { PAPERCLIP_GITLAB_HOSTS: "gitlab.mycompany.com" },
    })).toContain("No GitLab credential is configured — add a GITLAB_TOKEN company secret");
  });

  it("falls back to generic guidance for an unconfigured self-hosted-looking host", () => {
    expect(describeGitAuthFailure({
      error: "fatal: could not read Username for 'https://gitlab.mycompany.com': terminal prompts disabled",
      used: null,
      remoteUrl: "https://gitlab.mycompany.com/example/repo.git",
      env: {},
    })).toContain("No git credential is configured — add a GITHUB_TOKEN/GH_TOKEN or GITLAB_TOKEN company secret");
  });

  it("falls back to generic guidance when no remoteUrl is available either", () => {
    expect(describeGitAuthFailure({
      error: "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled",
      used: null,
    })).toContain("No git credential is configured — add a GITHUB_TOKEN/GH_TOKEN or GITLAB_TOKEN company secret");
  });

  it("stays silent for non-auth failures without a credential", () => {
    expect(describeGitAuthFailure({
      error: "fatal: unable to resolve host example.invalid",
      used: null,
    })).toBeNull();
  });

  it("stays silent for non-auth failures even when a credential was used", () => {
    // A credential present during an unrelated failure (network outage, target-path
    // collision) must not be blamed for it.
    expect(describeGitAuthFailure({
      error: "fatal: destination path '/x/y' already exists and is not an empty directory.",
      used: { source: "company_secret", secretName: "GH_TOKEN", providerId: "github" },
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

describe("DEFAULT_GITLAB_TOKEN_SECRET_NAMES", () => {
  it("keeps the shared name order stable", () => {
    expect([...DEFAULT_GITLAB_TOKEN_SECRET_NAMES]).toEqual([
      "GITLAB_TOKEN",
      "PAPERCLIP_GITLAB_TOKEN",
    ]);
  });
});
