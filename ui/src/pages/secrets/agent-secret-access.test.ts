import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { buildSecretAgentUsage } from "./agent-secret-access";

function agent(id: string, adapterConfig: Record<string, unknown>, status = "active"): Agent {
  return { id, name: id, status, adapterConfig } as unknown as Agent;
}

describe("buildSecretAgentUsage", () => {
  it("indexes agents by the secrets and user secrets they hold", () => {
    const builder = agent("builder", {
      env: {
        GITHUB_TOKEN: { type: "secret_ref", secretId: "secret-github" },
        PLAIN: { type: "plain", value: "x" },
        PERSONAL: { type: "user_secret_ref", key: "PERSONAL_GH_TOKEN" },
      },
      "access.deploy": { type: "secret_ref", secretId: "secret-deploy" },
    });
    const reviewer = agent("reviewer", { env: { GH: { type: "secret_ref", secretId: "secret-github" } } });
    const gone = agent("gone", { env: { GH: { type: "secret_ref", secretId: "secret-github" } } }, "terminated");

    const usage = buildSecretAgentUsage([builder, reviewer, gone]);

    expect(usage.bySecretId.get("secret-github")?.map((entry) => entry.id)).toEqual(["builder", "reviewer"]);
    expect(usage.bySecretId.get("secret-deploy")?.map((entry) => entry.id)).toEqual(["builder"]);
    expect(usage.byUserSecretKey.get("PERSONAL_GH_TOKEN")?.map((entry) => entry.id)).toEqual(["builder"]);
  });

  it("lists an agent once per secret even when it binds it under two names", () => {
    const usage = buildSecretAgentUsage([
      agent("builder", {
        env: { A: { type: "secret_ref", secretId: "secret-1" }, B: { type: "secret_ref", secretId: "secret-1" } },
      }),
    ]);

    expect(usage.bySecretId.get("secret-1")).toHaveLength(1);
  });

  it("reads each binding a fixed number of times on a large organization", () => {
    const AGENTS = 1000;
    const BINDINGS_PER_AGENT = 30;
    const SECRETS = 400;
    const totalBindings = AGENTS * BINDINGS_PER_AGENT;
    // The index may look at a binding's type more than once, but never once per other agent or secret.
    const limit = totalBindings * 4;
    let reads = 0;
    const countedBinding = (secretId: string) => ({
      get type() {
        reads += 1;
        if (reads > limit) throw new Error(`read binding types ${reads} times; the limit is ${limit}`);
        return "secret_ref";
      },
      secretId,
    });
    const agents = Array.from({ length: AGENTS }, (_, agentIndex) =>
      agent(`agent-${agentIndex}`, {
        env: Object.fromEntries(
          Array.from({ length: BINDINGS_PER_AGENT }, (_, bindingIndex) => [
            `VAR_${bindingIndex}`,
            countedBinding(`secret-${(agentIndex * BINDINGS_PER_AGENT + bindingIndex) % SECRETS}`),
          ]),
        ),
      }),
    );

    const usage = buildSecretAgentUsage(agents);

    expect(usage.bySecretId.size).toBe(SECRETS);
    expect([...usage.bySecretId.values()].reduce((sum, list) => sum + list.length, 0)).toBe(totalBindings);
    expect(reads).toBeGreaterThanOrEqual(totalBindings);
    expect(reads).toBeLessThanOrEqual(limit);
  });
});
