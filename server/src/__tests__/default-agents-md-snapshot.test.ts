import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
} from "../services/default-agent-instructions";

describe("default/AGENTS.md pre-flight section (BLO-6151)", () => {
  it("contains the Wake Pre-flight heading and canonical slug pattern", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    const agentsMd = bundle["AGENTS.md"];

    expect(agentsMd).toBeDefined();
    expect(agentsMd).toContain("## Wake Pre-flight");
    expect(agentsMd).toContain(
      "paperclip/decisions/{companyId}/{agent.id}/{issueIdentifier}",
    );
  });

  it("declares the body-grep marker (NOT metadata, per T1 Gate 3)", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    const agentsMd = bundle["AGENTS.md"];

    expect(agentsMd).toContain("[gstack-preflight] frame stable since");
    // Must NOT instruct the agent to set comment metadata — server rejects.
    expect(agentsMd).not.toMatch(/"metadata"\s*:\s*\{/);
  });

  it("uses identical sentinel token in step 6 filter and step 7a body (catches split)", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    const agentsMd = bundle["AGENTS.md"];

    // The step-6 compare filter and the step-7a comment body MUST share the
    // exact same `[gstack-preflight]` prefix. If they drift, the CALM path
    // breaks silently because step 6 stops recognizing the agent's own
    // marker comments.
    expect(agentsMd).toContain("body does NOT start with `[gstack-preflight]`");
    expect(agentsMd).toContain('"[gstack-preflight] frame stable since');
  });

  it("includes the two SWEEP_CLASS reasons in the inclusion list", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    const agentsMd = bundle["AGENTS.md"];

    expect(agentsMd).toContain("issue_blockers_resolved_sweep");
    expect(agentsMd).toContain("issue_dependencies_blocked");
  });

  it("does NOT classify heartbeat_timer or interval_elapsed as SWEEP_CLASS", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    const agentsMd = bundle["AGENTS.md"];

    const sweepMatch = agentsMd.match(
      /SWEEP_CLASS reasons:[\s\S]*?then run the short-circuit/,
    );
    expect(sweepMatch).not.toBeNull();
    const sweepSection = sweepMatch![0];

    expect(sweepSection).not.toMatch(/^- `heartbeat_timer`/m);
    expect(sweepSection).not.toMatch(/^- `interval_elapsed`/m);
  });

  it("places pre-flight between identity and Execution Contract", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    const agentsMd = bundle["AGENTS.md"];

    const identityIdx = agentsMd.indexOf(
      "You are an agent at Paperclip company.",
    );
    const preflightIdx = agentsMd.indexOf("## Wake Pre-flight");
    const contractIdx = agentsMd.indexOf("## Execution Contract");

    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(preflightIdx).toBeGreaterThan(identityIdx);
    expect(contractIdx).toBeGreaterThan(preflightIdx);
  });

  it("references the two-write pattern + post-comment re-read (Gate 4 compensation)", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    const agentsMd = bundle["AGENTS.md"];

    expect(agentsMd).toContain("Fall-through write protocol");
    expect(agentsMd).toContain("pending_substantive_run");
    expect(agentsMd).toContain("Re-read");
  });
});
