import { describe, expect, it } from "vitest";
import { indexAgentsById } from "./ReviewQueueCard";

describe("indexAgentsById", () => {
  it("reads each agent once however many requests look one up", () => {
    const AGENTS = 2000;
    const REQUESTS = 500;
    let reads = 0;
    const agents = Array.from({ length: AGENTS }, (_, index) => ({
      get id() {
        reads += 1;
        if (reads > AGENTS) throw new Error(`agent ids were read ${reads} times for ${AGENTS} agents`);
        return `agent-${index}`;
      },
      name: `Agent ${index}`,
    }));

    const byId = indexAgentsById(agents);
    const found = Array.from({ length: REQUESTS }, (_, index) => byId.get(`agent-${(index * 7) % AGENTS}`));

    expect(reads).toBe(AGENTS);
    expect(found.every((agent) => agent !== undefined)).toBe(true);
    expect(byId.get("agent-missing")).toBeUndefined();
  });
});
