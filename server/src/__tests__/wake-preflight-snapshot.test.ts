import { describe, expect, it } from "vitest";
import { loadWakePreflightContent } from "../services/default-agent-instructions.js";

describe("_shared/WAKE-PREFLIGHT.md (BLO-6151)", () => {
  it("contains the Wake Pre-flight heading and canonical slug pattern", async () => {
    const content = await loadWakePreflightContent();
    expect(content).toContain("## Wake Pre-flight");
    expect(content).toContain(
      "paperclip/decisions/{companyId}/{agent.id}/{issueIdentifier}",
    );
  });

  it("declares the body-grep marker (NOT metadata, per T1 Gate 3)", async () => {
    const content = await loadWakePreflightContent();
    expect(content).toContain("[gstack-preflight] frame stable since");
    expect(content).not.toMatch(/"metadata"\s*:\s*\{/);
  });

  it("uses identical sentinel token in step 6 filter and step 7a body (catches split)", async () => {
    const content = await loadWakePreflightContent();
    expect(content).toContain("body does NOT start with `[gstack-preflight]`");
    expect(content).toContain('"[gstack-preflight] frame stable since');
  });

  it("includes the two SWEEP_CLASS reasons in the inclusion list", async () => {
    const content = await loadWakePreflightContent();
    expect(content).toContain("issue_blockers_resolved_sweep");
    expect(content).toContain("issue_dependencies_blocked");
  });

  it("does NOT classify heartbeat_timer or interval_elapsed as SWEEP_CLASS", async () => {
    const content = await loadWakePreflightContent();
    const sweepMatch = content.match(
      /SWEEP_CLASS reasons:[\s\S]*?then run the short-circuit/,
    );
    expect(sweepMatch).not.toBeNull();
    const sweepSection = sweepMatch![0];
    expect(sweepSection).not.toMatch(/^- `heartbeat_timer`/m);
    expect(sweepSection).not.toMatch(/^- `interval_elapsed`/m);
  });

  it("references the two-write pattern + post-comment re-read (Gate 4 compensation)", async () => {
    const content = await loadWakePreflightContent();
    expect(content).toContain("Fall-through write protocol");
    expect(content).toContain("pending_substantive_run");
    expect(content).toContain("Re-read");
  });
});

describe("default bundle composition (BLO-6151)", () => {
  it("default role: bundle composes Wake Pre-flight + body so new agents materialize with preflight on disk", async () => {
    const { loadDefaultAgentInstructionsBundle } = await import(
      "../services/default-agent-instructions.js"
    );
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    const agentsMd = bundle["AGENTS.md"];
    expect(agentsMd.startsWith("## Wake Pre-flight")).toBe(true);
    expect(agentsMd).toContain("[gstack-preflight] frame stable since");
    expect(agentsMd).toContain("You are an agent at Paperclip company.");
    expect(agentsMd).toContain("## Execution Contract");
    // Preflight must come BEFORE identity opener, identity BEFORE execution contract.
    const preflightIdx = agentsMd.indexOf("## Wake Pre-flight");
    const identityIdx = agentsMd.indexOf("You are an agent at Paperclip company.");
    const contractIdx = agentsMd.indexOf("## Execution Contract");
    expect(preflightIdx).toBe(0);
    expect(identityIdx).toBeGreaterThan(preflightIdx);
    expect(contractIdx).toBeGreaterThan(identityIdx);
  });

  it("ceo role: bundle does NOT compose Wake Pre-flight (CEO has its own multi-file bundle, not in sweep population)", async () => {
    const { loadDefaultAgentInstructionsBundle } = await import(
      "../services/default-agent-instructions.js"
    );
    const bundle = await loadDefaultAgentInstructionsBundle("ceo");
    expect(bundle["AGENTS.md"]).not.toContain("## Wake Pre-flight");
    expect(bundle["AGENTS.md"]).not.toContain("[gstack-preflight]");
  });

  it("composition is idempotent: an already-prefixed body is not double-prepended", async () => {
    const { composeAgentsMdWithPreflight, loadWakePreflightContent } = await import(
      "../services/default-agent-instructions.js"
    );
    const preflight = await loadWakePreflightContent();
    const alreadyComposed = `## Wake Pre-flight ...\n\nrest of file\n`;
    expect(composeAgentsMdWithPreflight(preflight, alreadyComposed)).toBe(alreadyComposed);
  });

  it("default/AGENTS.md source file (without composition) is preflight-free", async () => {
    // The on-disk source default body stays clean; composition is the only path
    // that adds Wake Pre-flight. This test guards against accidentally restoring
    // Wake Pre-flight to default/AGENTS.md (which would cause double-prepend
    // via composition).
    const fs = await import("node:fs/promises");
    const url = new URL(
      "../onboarding-assets/default/AGENTS.md",
      import.meta.url,
    );
    const raw = await fs.readFile(url, "utf8");
    expect(raw).not.toContain("## Wake Pre-flight");
    expect(raw).not.toContain("[gstack-preflight]");
    expect(raw).toContain("You are an agent at Paperclip company.");
    expect(raw).toContain("## Execution Contract");
  });
});
