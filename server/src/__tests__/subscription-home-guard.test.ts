import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  allowsSharedSubscriptionHome,
  findSubscriptionHomeConflicts,
  listSubscriptionHomeBindings,
  normalizeSubscriptionHomePath,
} from "../services/subscription-home-guard.js";

describe("listSubscriptionHomeBindings", () => {
  it("returns bindings for plain string subscription-home env values", () => {
    const bindings = listSubscriptionHomeBindings({
      env: {
        CODEX_HOME: "/auth-homes/codex-aleks",
        CLAUDE_CONFIG_DIR: "/auth-homes/claude-aleks",
        HOME: "/auth-homes/aleks",
        OPENAI_API_KEY: "sk-should-be-ignored",
      },
    });
    expect(bindings).toEqual([
      { envKey: "CODEX_HOME", homePath: "/auth-homes/codex-aleks" },
      { envKey: "CLAUDE_CONFIG_DIR", homePath: "/auth-homes/claude-aleks" },
      { envKey: "HOME", homePath: "/auth-homes/aleks" },
    ]);
  });

  it("supports plain env binding records and skips secret refs", () => {
    const bindings = listSubscriptionHomeBindings({
      env: {
        CLAUDE_CONFIG_DIR: { type: "plain", value: "/auth-homes/claude-paul" },
        CODEX_HOME: { type: "secret_ref", secretId: "abc" },
      },
    });
    expect(bindings).toEqual([
      { envKey: "CLAUDE_CONFIG_DIR", homePath: "/auth-homes/claude-paul" },
    ]);
  });

  it("returns nothing for missing env, empty values, or non-object configs", () => {
    expect(listSubscriptionHomeBindings({})).toEqual([]);
    expect(listSubscriptionHomeBindings(null)).toEqual([]);
    expect(listSubscriptionHomeBindings({ env: { HOME: "   " } })).toEqual([]);
  });

  it("skips env keys resolved from secrets when requested", () => {
    const bindings = listSubscriptionHomeBindings(
      { env: { HOME: "/resolved-from-secret", CODEX_HOME: "/plain" } },
      { skipEnvKeys: new Set(["HOME"]) },
    );
    expect(bindings).toEqual([{ envKey: "CODEX_HOME", homePath: "/plain" }]);
  });
});

describe("normalizeSubscriptionHomePath", () => {
  it("expands ~ and resolves relative segments", () => {
    expect(normalizeSubscriptionHomePath("~/auth/claude")).toBe(
      path.join(os.homedir(), "auth", "claude"),
    );
    expect(normalizeSubscriptionHomePath("~")).toBe(os.homedir());
    expect(normalizeSubscriptionHomePath("/a/b/../c/")).toBe("/a/c");
  });
});

describe("findSubscriptionHomeConflicts", () => {
  const candidateBindings = listSubscriptionHomeBindings({
    env: { CLAUDE_CONFIG_DIR: "/auth-homes/claude-aleks" },
  });

  it("flags another active agent binding the same resolved path", () => {
    const conflicts = findSubscriptionHomeConflicts({
      candidateBindings,
      otherAgents: [
        {
          id: "agent-b",
          name: "Outreach",
          status: "idle",
          adapterConfig: { env: { CLAUDE_CONFIG_DIR: "/auth-homes/claude-aleks/" } },
        },
      ],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      envKey: "CLAUDE_CONFIG_DIR",
      otherEnvKey: "CLAUDE_CONFIG_DIR",
      homePath: "/auth-homes/claude-aleks",
      otherAgentId: "agent-b",
      otherAgentName: "Outreach",
    });
  });

  it("flags cross-key collisions on the same resolved path", () => {
    const conflicts = findSubscriptionHomeConflicts({
      candidateBindings,
      otherAgents: [
        {
          id: "agent-c",
          adapterConfig: { env: { HOME: "/auth-homes/claude-aleks" } },
        },
      ],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ envKey: "CLAUDE_CONFIG_DIR", otherEnvKey: "HOME" });
  });

  it("does not flag distinct homes or agents without explicit subscription env", () => {
    const conflicts = findSubscriptionHomeConflicts({
      candidateBindings,
      otherAgents: [
        { id: "agent-d", adapterConfig: { env: { CLAUDE_CONFIG_DIR: "/auth-homes/claude-paul" } } },
        { id: "agent-e", adapterConfig: { env: { OPENAI_API_KEY: "sk-x" } } },
        { id: "agent-f", adapterConfig: {} },
      ],
    });
    expect(conflicts).toEqual([]);
  });

  it("skips agents that explicitly allow shared subscription homes", () => {
    const conflicts = findSubscriptionHomeConflicts({
      candidateBindings,
      otherAgents: [
        {
          id: "agent-g",
          adapterConfig: {
            allowSharedSubscriptionHome: true,
            env: { CLAUDE_CONFIG_DIR: "/auth-homes/claude-aleks" },
          },
        },
      ],
    });
    expect(conflicts).toEqual([]);
  });

  it("returns no conflicts when the candidate declares no bindings", () => {
    expect(
      findSubscriptionHomeConflicts({
        candidateBindings: [],
        otherAgents: [
          { id: "agent-h", adapterConfig: { env: { HOME: "/auth-homes/aleks" } } },
        ],
      }),
    ).toEqual([]);
  });
});

describe("allowsSharedSubscriptionHome", () => {
  it("requires an explicit boolean true", () => {
    expect(allowsSharedSubscriptionHome({ allowSharedSubscriptionHome: true })).toBe(true);
    expect(allowsSharedSubscriptionHome({ allowSharedSubscriptionHome: "true" })).toBe(false);
    expect(allowsSharedSubscriptionHome({})).toBe(false);
    expect(allowsSharedSubscriptionHome(null)).toBe(false);
  });
});
