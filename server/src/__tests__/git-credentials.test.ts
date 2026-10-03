import { spawn, spawnSync } from "node:child_process";
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
  reconcileGitHubIdentity,
  resetGitHubIdentityCache,
  resolveGitHubIdentity,
  resolveVerifiedGitHubIdentity,
  scrubGitCredentialText,
  verifiedNoreplyEmail,
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

  it("accepts GitHub SSH remotes for process-scoped HTTPS rewriting", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
    });
    const invocation = await provider("git@github.com:example/repo.git");
    expect(invocation?.env.GIT_CONFIG_VALUE_3).toBe("git@github.com:");
    expect(invocation?.env.GIT_CONFIG_KEY_3).toBe("url.https://github.com/.insteadOf");
  });

  it("returns null for non-GitHub URLs without touching the secret store", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
    });
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

  it("ignores a managed connection installed only for another agent", async () => {
    const query = (rows: unknown[]) => ({
      from: () => ({ where: async () => rows }),
    });
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([{
          id: "github-connection",
          companyId: "company-1",
          enabled: true,
          status: "active",
          config: { sourceTemplateKey: "github" },
        }]))
        .mockReturnValueOnce(query([{
          connectionId: "github-connection",
          companyId: "company-1",
          targetType: "agent",
          targetId: "agent-a",
        }])),
    } as unknown as Db;
    const secrets = buildSecretsFake({ GH_TOKEN: "agent-b-legacy-token" });
    const provider = createGitRemoteAuthProvider(db, "company-1", { agentId: "agent-b" }, {
      secrets,
      env: {},
    });

    const invocation = await provider(githubUrl);

    expect(invocation?.source).toBe("company_secret");
    expect(invocation?.secretName).toBe("GH_TOKEN");
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("agent-b-legacy-token");
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

function publishedConfig(invocation: { env: Record<string, string | undefined> }): Record<string, string> {
  const entries: Record<string, string> = {};
  const count = Number(invocation.env.GIT_CONFIG_COUNT ?? 0);
  for (let index = 0; index < count; index += 1) {
    const key = invocation.env[`GIT_CONFIG_KEY_${index}`];
    const value = invocation.env[`GIT_CONFIG_VALUE_${index}`];
    if (key !== undefined && value !== undefined) entries[key] = value;
  }
  return entries;
}

describe("buildGitAuthInvocation", () => {
  it("keeps the token out of argv and installs the helper URL-scoped to github.com", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "company_secret",
      secretName: "GITHUB_TOKEN",
    });
    expect(invocation.configArgs.join(" ")).not.toContain("super-secret-token");
    expect(invocation.configArgs[0]).toBe("-c");
    expect(invocation.configArgs[1]).toBe("credential.helper=");
    expect(invocation.configArgs[3]).toContain("credential.https://github.com.helper=");
    expect(invocation.configArgs[3]).toContain("x-access-token");
    expect(invocation.configArgs[5]).toContain("credential.https://www.github.com.helper=");
    expect(invocation.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("super-secret-token");
    expect(invocation.env.GH_TOKEN).toBe("super-secret-token");
    expect(invocation.env.GITHUB_TOKEN).toBe("super-secret-token");
    expect(invocation.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(invocation.env).not.toHaveProperty("HOME");
  });

  it("sets GitHub's stable noreply commit identity without exposing the token in config", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "managed_connection",
      secretName: null,
      verifiedGithubIdentity: { userId: "12345", login: "octocat" },
    });
    expect(invocation.env.GIT_CONFIG_KEY_7).toBe("user.name");
    expect(invocation.env.GIT_CONFIG_VALUE_7).toBe("octocat");
    expect(invocation.env.GIT_CONFIG_KEY_8).toBe("user.email");
    expect(invocation.env.GIT_CONFIG_VALUE_8).toBe("12345+octocat@users.noreply.github.com");
    expect(invocation.env.GIT_AUTHOR_NAME).toBe("octocat");
    expect(invocation.env.GIT_AUTHOR_EMAIL).toBe("12345+octocat@users.noreply.github.com");
    expect(invocation.env.GIT_COMMITTER_NAME).toBe("octocat");
    expect(invocation.env.GIT_COMMITTER_EMAIL).toBe("12345+octocat@users.noreply.github.com");
    expect(Object.values(invocation.env).filter((value) => value.includes("super-secret-token"))).toHaveLength(3);
  });

  it("publishes no ident from the stored claim alone, only from a verified identity", () => {
    // The defect this replaces: `githubIdentity` was populated straight from the connection's
    // tenant record and read as the commit ident. The shipped stand-in row carried `100000001`,
    // a live but unrelated account, so every managed commit became a verified-looking
    // contribution to that stranger. The claim is still reported to operators; it just no
    // longer decides whose name a commit carries.
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "managed_connection",
      secretName: null,
      githubIdentity: { userId: "100000001", login: "Tessalol" },
    });
    expect(invocation.env.GIT_AUTHOR_EMAIL).toBe("");
    expect(invocation.env.GIT_COMMITTER_EMAIL).toBe("");
    expect(invocation.env.GIT_AUTHOR_NAME).toBe("");
    expect(publishedConfig(invocation)["user.email"]).toBe("");
    expect(JSON.stringify(invocation.env)).not.toContain("100000001");
  });

  it("withholds the commit identity entirely when the id is not a numeric account id", () => {
    // The regression this guards: a stand-in tenant row carried `100000001`, a real but
    // unrelated account, and the broker published it as the agent's own ident. A non-numeric or
    // zero/negative id is therefore never published, even when the login looks plausible.
    for (const userId of ["", "  ", "etqan-bot", "0", "-1", "12.5", "1e9", "1000000010000000000000x"]) {
      const invocation = buildGitAuthInvocation({
        token: "super-secret-token",
        source: "managed_connection",
        secretName: null,
        verifiedGithubIdentity: { userId, login: "octocat" },
      });
      expect(invocation.env.GIT_AUTHOR_EMAIL).toBe("");
      expect(invocation.env.GIT_COMMITTER_EMAIL).toBe("");
      expect(invocation.env.GIT_AUTHOR_NAME).toBe("");
      expect(publishedConfig(invocation)["user.email"]).toBe("");
    }
  });

  it("withholds the commit identity when the login is not a valid GitHub login", () => {
    // `user.name` and the address both carry the login verbatim, so an invented or malformed
    // value must not reach git config even when the numeric id is well-formed.
    for (const login of ["", "  ", "etqan bot", "octo@cat", "octo\ncat", "-octocat", "octocat-", "a--b", "x".repeat(40)]) {
      const invocation = buildGitAuthInvocation({
        token: "super-secret-token",
        source: "managed_connection",
        secretName: null,
        verifiedGithubIdentity: { userId: "12345", login },
      });
      expect(invocation.env.GIT_AUTHOR_EMAIL).toBe("");
      expect(invocation.env.GIT_AUTHOR_NAME).toBe("");
      expect(publishedConfig(invocation)["user.name"]).toBe("");
    }
  });

  it("keeps publishing the identity for a well-formed account, including hyphenated logins", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "managed_connection",
      secretName: null,
      verifiedGithubIdentity: { userId: "5732579", login: "al-bisher" },
    });
    expect(invocation.env.GIT_AUTHOR_EMAIL).toBe("5732579+al-bisher@users.noreply.github.com");
    expect(invocation.env.GIT_COMMITTER_EMAIL).toBe("5732579+al-bisher@users.noreply.github.com");
  });

  it("publishes an empty ident, not an absent one, when a managed identity is unverified", () => {
    // Omitting these keys is what left the hole: git reads the author from the environment
    // before any configuration, so an invocation that published nothing simply let the host's
    // value stand and committed under it. Empty overrides the inherited value, and the empty
    // `user.*` pair covers the managed launcher, whose shell profile unsets the empty quartet
    // again before git runs. Either way the commit stops with nothing written.
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "managed_connection",
      secretName: null,
      githubIdentity: { userId: "100000001", login: "Tessalol" },
    });
    expect(invocation.env.GIT_AUTHOR_NAME).toBe("");
    expect(invocation.env.GIT_AUTHOR_EMAIL).toBe("");
    expect(invocation.env.GIT_COMMITTER_NAME).toBe("");
    expect(invocation.env.GIT_COMMITTER_EMAIL).toBe("");
    expect(publishedConfig(invocation)["user.name"]).toBe("");
    expect(publishedConfig(invocation)["user.email"]).toBe("");
    // Empty is not a disguised ident: nothing anywhere in the environment carries the claim.
    expect(JSON.stringify(invocation.env)).not.toContain("100000001");
  });

  it("blocks the commit when the launcher's shell profile has already unset the quartet", () => {
    // The managed launcher writes a profile that unsets empty `GIT_AUTHOR_*` before the shell
    // hands off to git, which would strip the environment half of the guard above. With the
    // `user.*` pair published empty, the commit still has no ident to find and is refused
    // instead of falling back to whatever the host would auto-detect.
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "managed_connection",
      secretName: null,
    });
    const unsets = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]
      .filter((key) => !invocation.env[key])
      .map((key) => key);
    // Every value the launcher would strip has to be one it strips, i.e. already empty.
    expect(unsets).toHaveLength(4);
    expect(publishedConfig(invocation)["user.email"]).toBe("");
  });

  it("publishes a real ident instead of the empty quartet once verification succeeds", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "managed_connection",
      secretName: null,
      verifiedGithubIdentity: { userId: "5732579", login: "albisher" },
    });
    expect(invocation.env.GIT_AUTHOR_EMAIL).toBe("5732579+albisher@users.noreply.github.com");
    expect(invocation.env.GIT_AUTHOR_NAME).toBe("albisher");
    expect(publishedConfig(invocation)["user.email"]).toBe("5732579+albisher@users.noreply.github.com");
  });

  it("leaves the ambient ident alone for credentials that were never a managed connection", () => {
    // A company secret or a server-environment token has no tenant claim to reconcile, so
    // blanking the quartet would break a legitimate ambient-ident commit that this fix never
    // targeted.
    for (const source of ["company_secret", "server_env"] as const) {
      const invocation = buildGitAuthInvocation({
        token: "super-secret-token",
        source,
        secretName: source === "company_secret" ? "deploy-key" : null,
      });
      expect(invocation.env.GIT_AUTHOR_NAME, source).toBeUndefined();
      expect(invocation.env.GIT_AUTHOR_EMAIL, source).toBeUndefined();
      expect(invocation.env.GIT_COMMITTER_EMAIL, source).toBeUndefined();
      expect(publishedConfig(invocation)["user.email"], source).toBeUndefined();
    }
  });
});

describe("verifiedNoreplyEmail", () => {
  it("builds the address only from a well-formed verified identity", () => {
    expect(verifiedNoreplyEmail({ userId: "5732579", login: "albisher" }))
      .toBe("5732579+albisher@users.noreply.github.com");
    expect(verifiedNoreplyEmail(undefined)).toBeNull();
    expect(verifiedNoreplyEmail({ userId: "5732579", login: "" })).toBeNull();
  });
});

describe("resolveVerifiedGitHubIdentity", () => {
  function jsonResponse(body: unknown, ok = true) {
    return { ok, status: ok ? 200 : 401, json: async () => body } as unknown as Response;
  }
  function statusResponse(status: number, headers: Record<string, string> = {}) {
    // A real `Response` always carries `headers`; the identity check reads the rate-limit
    // headers off a 403, so a stub without them would not describe anything GitHub can send.
    return {
      ok: false,
      status,
      headers: new Headers(headers),
      json: async () => ({ message: "nope" }),
    } as unknown as Response;
  }

  it("returns the id and login GitHub reports for the token", async () => {
    resetGitHubIdentityCache();
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 5732579, login: "albisher" }));
    const identity = await resolveVerifiedGitHubIdentity("tok-a", { now: 1_000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(identity).toMatchObject({ userId: "5732579", login: "albisher" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-a");
  });

  it("serves a cached answer for the same token and re-verifies after the TTL", async () => {
    resetGitHubIdentityCache();
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 5732579, login: "albisher" }));
    const cast = fetchImpl as unknown as typeof fetch;
    await resolveVerifiedGitHubIdentity("tok-b", { now: 1_000, fetchImpl: cast });
    await resolveVerifiedGitHubIdentity("tok-b", { now: 2_000, fetchImpl: cast });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await resolveVerifiedGitHubIdentity("tok-b", { now: 1_000 + 11 * 60_000, fetchImpl: cast });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    resetGitHubIdentityCache();
  });

  it("never serves one token's cached identity for another", async () => {
    resetGitHubIdentityCache();
    const first = vi.fn(async () => jsonResponse({ id: 5732579, login: "albisher" }));
    const second = vi.fn(async () => jsonResponse({ id: 100000001, login: "stranger" }));
    await resolveVerifiedGitHubIdentity("tok-c", { now: 1_000, fetchImpl: first as unknown as typeof fetch });
    const identity = await resolveVerifiedGitHubIdentity("tok-d", { now: 1_000, fetchImpl: second as unknown as typeof fetch });
    expect(identity).toMatchObject({ userId: "100000001", login: "stranger" });
    expect(first).toHaveBeenCalledTimes(1);
    resetGitHubIdentityCache();
  });

  it("returns null instead of guessing when GitHub cannot answer", async () => {
    resetGitHubIdentityCache();
    for (const [label, fetchImpl] of [
      ["401", async () => statusResponse(401)],
      ["network error", async () => { throw new Error("ECONNREFUSED"); }],
      ["non-integer id", async () => jsonResponse({ id: "not-a-number", login: "albisher" })],
      ["zero id", async () => jsonResponse({ id: 0, login: "albisher" })],
      ["missing login", async () => jsonResponse({ id: 5732579 })],
      ["invalid login", async () => jsonResponse({ id: 5732579, login: "not a login" })],
      ["empty token", async () => { throw new Error("must not be called"); }],
    ] as const) {
      const identity = await resolveVerifiedGitHubIdentity(
        label === "empty token" ? "" : `tok-${label}`,
        { now: 1_000, fetchImpl: fetchImpl as unknown as typeof fetch },
      );
      expect(identity, label).toBeNull();
    }
    resetGitHubIdentityCache();
  });

  it("reads a rate-limited 403 as an unanswered question, not a refused token", async () => {
    // GitHub spends the same 403 on "this token is not an account" and on "stop asking". Reading
    // the second one as the first would tell an operator to replace a credential that works.
    // The rate-limit headers are the only thing that tells them apart.
    resetGitHubIdentityCache();
    const rateLimited = await resolveGitHubIdentity("rate-limited", {
      now: 1_000,
      fetchImpl: (async () => statusResponse(403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1790966439",
      })) as unknown as typeof fetch,
    });
    expect(rateLimited.status).toBe("unreachable");
    if (rateLimited.status === "unreachable") {
      expect(rateLimited.reason).toMatch(/rate limit/i);
      // The operator-facing reason must not tell them to replace a working credential.
      expect(rateLimited.reason).not.toMatch(/reject/i);
    }

    // A 403 with quota left is a real refusal and must keep being one.
    const refused = await resolveGitHubIdentity("still-refused", {
      now: 1_000,
      fetchImpl: (async () => statusResponse(403, { "x-ratelimit-remaining": "4999" })) as unknown as typeof fetch,
    });
    expect(refused.status).toBe("rejected");
    resetGitHubIdentityCache();
  });

  it("separates a rejected credential from an unanswered question", async () => {
    // The distinction the whole refusal contract rests on. A 401/403 is GitHub stating that
    // the token is not an account, which no retry will change; a 5xx or a rate limit is the
    // absence of an answer, which says nothing about the token at all.
    resetGitHubIdentityCache();
    const expectations: [string, number, "rejected" | "unreachable"][] = [
      ["401", 401, "rejected"],
      ["403", 403, "rejected"],
      ["429", 429, "unreachable"],
      ["500", 500, "unreachable"],
      ["502", 502, "unreachable"],
    ];
    for (const [label, status, expected] of expectations) {
      const fetchImpl = vi.fn(async () => statusResponse(status));
      const resolution = await resolveGitHubIdentity(`tri-${label}`, {
        now: 1_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(resolution.status, label).toBe(expected);
    }
    const thrown = await resolveGitHubIdentity("tri-offline", {
      now: 1_000,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(thrown.status).toBe("unreachable");
    resetGitHubIdentityCache();
  });

  it("reports a verified answer in the same shape it caches", async () => {
    resetGitHubIdentityCache();
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 5732579, login: "albisher" }));
    const cast = fetchImpl as unknown as typeof fetch;
    const first = await resolveGitHubIdentity("shape-tok", { now: 1_000, fetchImpl: cast });
    expect(first.status).toBe("verified");
    expect(first.status === "verified" && first.identity).toMatchObject({ userId: "5732579", login: "albisher" });
    // The second call is served from the cache, so a status flip would prove the cache was
    // bypassed rather than the answer being refetched.
    const second = await resolveGitHubIdentity("shape-tok", { now: 2_000, fetchImpl: cast });
    expect(second.status).toBe("verified");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resetGitHubIdentityCache();
  });
});

describe("reconcileGitHubIdentity", () => {
  const verifiedResolution = { status: "verified", identity: { userId: "5732579", login: "albisher", verifiedAt: 0 } } as const;

  it("publishes the token's own identity when the tenant record agrees", () => {
    expect(reconcileGitHubIdentity({
      claimed: { userId: "5732579", login: "albisher" },
      resolution: verifiedResolution,
    })).toEqual({ outcome: "verified", identity: { userId: "5732579", login: "albisher" } });
  });

  it("withholds the ident when GitHub rejected the token outright", () => {
    // GitHub answered, and the answer was that these credentials are not an account. The
    // credential cannot be refused here without also failing every read for a token that is
    // merely misconfigured, but it must not carry an ident either — and it must say why, so
    // the operator knows to issue a new token rather than to retry.
    const result = reconcileGitHubIdentity({
      claimed: { userId: "100000001", login: "etqan-bot" },
      resolution: { status: "rejected", reason: "GitHub rejected the credential (HTTP 401)" },
    });
    expect(result.outcome).toBe("unverified");
    expect(result.outcome === "unverified" && result.error).toMatch(/rejected the credential/i);
  });

  it("withholds only the ident when GitHub could not be asked at all", () => {
    // A network fault says nothing about the token, so reads keep working. The caller pairs
    // this with an ident that is published empty rather than omitted, which stops git
    // substituting the ambient one.
    const result = reconcileGitHubIdentity({
      claimed: { userId: "100000001", login: "etqan-bot" },
      resolution: { status: "unreachable", reason: "GitHub could not be reached to verify the credential" },
    });
    expect(result.outcome).toBe("unverified");
    expect(result.outcome === "unverified" && result.error).toMatch(/could not be verified/i);
  });

  it("refuses a tenant record whose id belongs to a different account", () => {
    // The exact shape of the standing defect: the record says 100000001, the token is somebody
    // else. Publishing the record would put the commit in the stranger's name, and dropping it
    // while still releasing the token would put it in the host's name instead.
    const result = reconcileGitHubIdentity({
      claimed: { userId: "100000001", login: "etqan-bot" },
      resolution: verifiedResolution,
    });
    expect(result.outcome).toBe("contradicted");
    expect(result.outcome === "contradicted" && result.error).toContain("100000001");
    expect(result.outcome === "contradicted" && result.error).toContain("5732579");
  });

  it("refuses a tenant record whose login was renamed on GitHub", () => {
    const result = reconcileGitHubIdentity({
      claimed: { userId: "5732579", login: "old-login" },
      resolution: { status: "verified", identity: { userId: "5732579", login: "new-login", verifiedAt: 0 } },
    });
    expect(result.outcome).toBe("contradicted");
    expect(result.outcome === "contradicted" && result.error).toContain("old-login");
  });

  it("accepts a record with no id or login, since the verified identity is authoritative", () => {
    expect(reconcileGitHubIdentity({ claimed: null, resolution: verifiedResolution })).toEqual({
      outcome: "verified",
      identity: { userId: "5732579", login: "albisher" },
    });
  });

  it("never puts token material in the error it returns", () => {
    const result = reconcileGitHubIdentity({
      claimed: { userId: "100000001", login: "etqan-bot" },
      resolution: verifiedResolution,
    });
    expect(result.outcome === "contradicted" && result.error).not.toMatch(/gho_|ghp_|github_pat_/);
  });
});

describe("a managed commit with no verified identity (real git, no network)", () => {
  /**
   * Commit a file in a throwaway repository with the invocation's own environment, then report
   * whether git wrote a commit and whose identity it recorded.
   *
   * This is the proof that matters for the defect: unit assertions on the environment say which
   * keys were published, but only git says whether a commit still happens and what it is
   * attributed to. The ambient identity here is deliberately present and different, because that
   * is the case that misattributes silently.
   */
  async function commitWith(
    credential: Parameters<typeof buildGitAuthInvocation>[0],
    ambient: { name: string; email: string },
    options: { launcherProfileRan?: boolean } = {},
  ) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-ident-"));
    try {
      const invocation = buildGitAuthInvocation(credential);
      const invocationEnv = { ...invocation.env };
      // The host's identity, which is exactly what git would silently borrow.
      const ambientEnv: NodeJS.ProcessEnv = options.launcherProfileRan ? {} : {
        GIT_AUTHOR_NAME: ambient.name,
        GIT_AUTHOR_EMAIL: ambient.email,
        GIT_COMMITTER_NAME: ambient.name,
        GIT_COMMITTER_EMAIL: ambient.email,
      };
      if (options.launcherProfileRan) {
        // The managed launcher strips `GIT_*` ident variables from the environment and its shell
        // profile then unsets the empty ones it left behind, so by the time git runs none of
        // them exist. Reproduce that here instead of asserting on it.
        for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
          delete invocationEnv[key];
        }
      }
      // Start from an environment with no git identity in it at all. The host this runs on
      // injects its own `GIT_CONFIG_*` and `GIT_*` ident variables into every process, and
      // inheriting them would decide the outcome before the invocation did — which is the same
      // environment-outranks-config mechanism as the defect, and would make this test assert
      // whatever the machine happened to be configured with instead of what was published.
      const baseEnv: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (/^(GIT_|EMAIL$)/.test(key)) continue;
        baseEnv[key] = value;
      }
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...ambientEnv,
        ...invocationEnv,
      };
      if (options.launcherProfileRan) {
        // With the environment cleared, git falls back to configuration and then to
        // auto-detection. Give the repository an ident of its own so the test proves the empty
        // pair outranks one, instead of passing because the host happened to have none.
        // `init` has to come first: before a repository exists `git config user.*` is a global
        // write, and the global config here is `/dev/null`, so the ident would be discarded
        // silently and this case would prove nothing.
        const seeded = spawnSync("git", ["init", "--quiet"], { cwd, env });
        const named = spawnSync("git", ["config", "user.name", ambient.name], { cwd, env });
        const emailed = spawnSync("git", ["config", "user.email", ambient.email], { cwd, env });
        expect({ init: seeded.status, name: named.status, email: emailed.status })
          .toEqual({ init: 0, name: 0, email: 0 });
        // Read the ident back out of the repository so a silently-dropped write fails this case
        // instead of quietly restoring the behaviour under test.
        const readBack = spawnSync("git", ["config", "--local", "--get", "user.email"], { cwd, env, encoding: "utf8" });
        expect(readBack.stdout.trim()).toBe(ambient.email);
      }
      const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => { stdout += String(chunk); });
          child.stderr.on("data", (chunk) => { stderr += String(chunk); });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        },
      );
      if (!options.launcherProfileRan) await run(["init", "--quiet"]);
      await fs.writeFile(path.join(cwd, "README.md"), "managed commit\n");
      await run(["add", "README.md"]);
      const committed = await run(["commit", "--quiet", "-m", "managed change"]);
      const head = committed.code === 0
        ? (await run(["log", "-1", "--format=%an <%ae>"])).stdout.trim()
        : "";
      return { committed, head };
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }

  it("refuses to commit rather than borrow the ambient identity", async () => {
    // The record says 100000001 and the token could not be verified. Publishing no ident at all
    // leaves this commit succeeding under `ambient-owner`, so a bot's push lands in a person's
    // name. Publishing an empty ident stops it.
    const result = await commitWith(
      {
        token: "super-secret-token",
        source: "managed_connection",
        secretName: null,
        githubIdentity: { userId: "100000001", login: "Tessalol" },
      },
      { name: "ambient-owner", email: "ambient-owner@example.com" },
    );
    expect(result.committed.code).not.toBe(0);
    expect(result.head).toBe("");
    expect(result.committed.stderr).toMatch(/empty ident|unable to auto-detect|identity unknown|no name was given/i);
    // Nothing was written under the ambient identity, which is the whole point: the failure is
    // a refusal, not a differently-attributed commit.
    expect(result.committed.stderr).not.toContain("ambient-owner");
  });

  it("still refuses after the launcher profile strips the empty quartet", async () => {
    // The residual hole this closes: the managed launcher unsets empty `GIT_*` ident variables
    // in its shell profile, so the environment half of the guard does not survive to git. The
    // empty `user.*` pair does, and the repository here carries an ident of its own precisely so
    // this cannot pass by accident — without the pair the commit succeeds under it.
    const result = await commitWith(
      { token: "super-secret-token", source: "managed_connection", secretName: null },
      { name: "ambient-owner", email: "ambient-owner@example.com" },
      { launcherProfileRan: true },
    );
    expect(result.committed.code).not.toBe(0);
    expect(result.head).toBe("");
    expect(result.committed.stderr).toMatch(/identity unknown|empty ident|unable to auto-detect|no name was given/i);
  });

  it("still commits under the verified identity when one was published", async () => {
    // The guard above must not cost the healthy path its commits: with a verified identity the
    // pair is published, so the commit happens and carries that identity rather than the
    // ambient one.
    const result = await commitWith(
      {
        token: "super-secret-token",
        source: "managed_connection",
        secretName: null,
        verifiedGithubIdentity: { userId: "5732579", login: "albisher" },
      },
      { name: "ambient-owner", email: "ambient-owner@example.com" },
    );
    expect(result.committed.code).toBe(0);
    expect(result.head).toBe("albisher <5732579+albisher@users.noreply.github.com>");
  });

  it("leaves non-managed credentials free to use the ambient identity", async () => {
    // A company secret has no tenant claim to reconcile, so this fix must not take its commits
    // away. This is the regression the scoping in `buildGitAuthInvocation` exists to avoid.
    const result = await commitWith(
      { token: "super-secret-token", source: "company_secret", secretName: "deploy-key" },
      { name: "ambient-owner", email: "ambient-owner@example.com" },
    );
    expect(result.committed.code).toBe(0);
    expect(result.head).toBe("ambient-owner <ambient-owner@example.com>");
  });
});

describe("credential helper execution (real git, no network)", () => {
  async function runCredentialFill(description: string) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-cred-fill-"));
    try {
      const invocation = buildGitAuthInvocation({
        token: "abc123",
        source: "company_secret",
        secretName: "GITHUB_TOKEN",
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

  it("stays silent for non-auth failures even when a credential was used", () => {
    // A credential present during an unrelated failure (network outage, target-path
    // collision) must not be blamed for it.
    expect(describeGitAuthFailure({
      error: "fatal: destination path '/x/y' already exists and is not an empty directory.",
      used: { source: "company_secret", secretName: "GH_TOKEN" },
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
