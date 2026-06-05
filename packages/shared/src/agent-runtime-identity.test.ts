import { describe, expect, it } from "vitest";
import type { Agent, AgentRuntimeIdentity } from "./index.js";

const runtimeIdentity: AgentRuntimeIdentity = {
  adapter: "hermes_local",
  profileSlug: "acme-reviewer",
};

const agent = {} as Agent;
const profileSlug: string | undefined = agent.metadata?.runtimeIdentity?.profileSlug;

describe("agent runtime identity type", () => {
  it("allows agent metadata to expose a runtime identity profile slug", () => {
    expect(runtimeIdentity.profileSlug).toBe("acme-reviewer");
    expect(profileSlug).toBeUndefined();
  });
});
