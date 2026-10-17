import { describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(routes: Record<string, () => Response>) {
  const urls: string[] = [];
  return {
    urls,
    fetchImpl: async (url: string) => {
      urls.push(url);
      const path = url.replace(/^https:\/\/[^/]+\/api\/v1\/cloud/, "").split("?")[0];
      const handler = routes[path];
      if (!handler) throw new Error(`unexpected ${url}`);
      return handler();
    },
  };
}

const baseCtx = { companyId: "company-1", adapterType: "qoder_cloud_agents" };

describe("qoder_cloud_agents testEnvironment", () => {
  it("fails without contacting Qoder when the token is missing", async () => {
    const fake = fakeFetch({});
    const result = await testEnvironment({ ...baseCtx, config: { env: {} } }, { fetchImpl: fake.fetchImpl });
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toEqual(["qoder_cloud_agents_token_missing"]);
    expect(fake.urls).toHaveLength(0);
  });

  it("passes when the token, model and environment all check out", async () => {
    const fake = fakeFetch({
      "/agents": () => json({ data: [] }),
      "/models": () => json({ data: [{ id: "ultimate" }] }),
      "/environments": () => json({ data: [{ id: "env_1" }] }),
    });
    const result = await testEnvironment({
      ...baseCtx,
      config: {
        env: { QODER_ACCESS_TOKEN: { type: "plain", value: "pt-secret" } },
        apiBaseUrl: "https://api.qoder.com.cn",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        model: "ultimate",
        environmentId: "env_1",
      },
    }, { fetchImpl: fake.fetchImpl });
    expect(result.status).toBe("pass");
    expect(result.checks.map((check) => check.code)).toEqual([
      "qoder_cloud_agents_repo_present",
      "qoder_cloud_agents_auth_ok",
      "qoder_cloud_agents_model_ok",
      "qoder_cloud_agents_environment_ok",
    ]);
    expect(fake.urls.every((url) => url.startsWith("https://api.qoder.com.cn/api/v1/cloud/"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("pt-secret");
  });

  it("fails on a rejected token and skips the dependent probes", async () => {
    const fake = fakeFetch({
      "/agents": () => json({ type: "error", error: { type: "authentication_error", message: "Invalid token." } }, 401),
    });
    const result = await testEnvironment({
      ...baseCtx,
      config: { env: { QODER_ACCESS_TOKEN: "pt-bad" }, model: "ultimate" },
    }, { fetchImpl: fake.fetchImpl });
    expect(result.status).toBe("fail");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ code: "qoder_cloud_agents_auth_failed", message: "Invalid token." });
    expect(fake.urls).toHaveLength(1);
  });

  it.each(["https://", "https://github.com", "not a url", "ftp://host/org/repo"])(
    "rejects the repository URL %j that execute would also reject",
    async (repoUrl) => {
      const fake = fakeFetch({ "/agents": () => json({ data: [] }) });
      const result = await testEnvironment({
        ...baseCtx,
        config: { env: { QODER_ACCESS_TOKEN: "pt-secret" }, repoUrl },
      }, { fetchImpl: fake.fetchImpl });
      expect(result.status).toBe("fail");
      expect(result.checks.map((check) => check.code)).toContain("qoder_cloud_agents_repo_invalid");
    },
  );

  it("refuses to send the token to a non-https apiBaseUrl", async () => {
    const fake = fakeFetch({});
    const result = await testEnvironment({
      ...baseCtx,
      config: { env: { QODER_ACCESS_TOKEN: "pt-secret" }, apiBaseUrl: "http://api.qoder.com" },
    }, { fetchImpl: fake.fetchImpl });
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toEqual(["qoder_cloud_agents_api_base_url_insecure"]);
    expect(fake.urls).toHaveLength(0);
  });

  it("warns when the configured environment is self-hosted", async () => {
    const fake = fakeFetch({
      "/agents": () => json({ data: [] }),
      "/environments": () => json({ data: [{ id: "env_byoc", config: { type: "self_hosted" } }] }),
    });
    const result = await testEnvironment({
      ...baseCtx,
      config: { env: { QODER_ACCESS_TOKEN: "pt-secret" }, environmentId: "env_byoc" },
    }, { fetchImpl: fake.fetchImpl });
    expect(result.status).toBe("warn");
    expect(result.checks.map((check) => check.code)).toEqual([
      "qoder_cloud_agents_auth_ok",
      "qoder_cloud_agents_environment_self_hosted",
    ]);
  });

  it("warns on an unknown model or environment and rejects SSH repository URLs", async () => {
    const fake = fakeFetch({
      "/agents": () => json({ data: [] }),
      "/models": () => json({ data: [{ id: "ultimate" }] }),
      "/environments": () => json({ data: [] }),
    });
    const result = await testEnvironment({
      ...baseCtx,
      config: {
        env: { QODER_ACCESS_TOKEN: "pt-secret" },
        repoUrl: "git@github.com:paperclipai/paperclip.git",
        model: "missing",
        environmentId: "env_missing",
      },
    }, { fetchImpl: fake.fetchImpl });
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => [check.code, check.level])).toEqual([
      ["qoder_cloud_agents_repo_invalid", "error"],
      ["qoder_cloud_agents_auth_ok", "info"],
      ["qoder_cloud_agents_model_unknown", "warn"],
      ["qoder_cloud_agents_environment_unknown", "warn"],
    ]);
  });
});
