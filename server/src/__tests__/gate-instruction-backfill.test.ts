import { describe, expect, it } from "vitest";
import { decideGateBackfillAction } from "../services/gate-instruction-backfill.js";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

const DEFAULT = "GENERIC DEFAULT AGENTS.md CONTENT";

describe("decideGateBackfillAction", () => {
  it("reseeds a gate agent on the generic default seed", () => {
    for (const urlKey of ["architect", "code-reviewer", "wiring-expert"]) {
      expect(
        decideGateBackfillAction({
          urlKey,
          mode: "managed",
          currentEntryContent: DEFAULT,
          defaultEntryContent: DEFAULT,
        }),
      ).toEqual({ action: "reseed", bundleRole: urlKey });
    }
  });

  it("skips non-gate identities (fast path)", () => {
    expect(
      decideGateBackfillAction({ urlKey: "ceo", mode: "managed", currentEntryContent: DEFAULT, defaultEntryContent: DEFAULT }),
    ).toEqual({ action: "skip", reason: "not-a-gate-agent" });
    expect(
      decideGateBackfillAction({ urlKey: "backend", mode: "managed", currentEntryContent: DEFAULT, defaultEntryContent: DEFAULT }),
    ).toEqual({ action: "skip", reason: "not-a-gate-agent" });
    expect(
      decideGateBackfillAction({ urlKey: null, mode: "managed", currentEntryContent: DEFAULT, defaultEntryContent: DEFAULT }),
    ).toEqual({ action: "skip", reason: "not-a-gate-agent" });
  });

  it("never clobbers custom-edited content", () => {
    expect(
      decideGateBackfillAction({
        urlKey: "architect",
        mode: "managed",
        currentEntryContent: "# Architect — heavily customized by the operator",
        defaultEntryContent: DEFAULT,
      }),
    ).toEqual({ action: "skip", reason: "custom-or-already-seeded" });
  });

  it("skips an already-role-seeded gate agent (idempotent)", () => {
    expect(
      decideGateBackfillAction({
        urlKey: "code-reviewer",
        mode: "managed",
        currentEntryContent: "# Code Reviewer\n…role bundle…",
        defaultEntryContent: DEFAULT,
      }),
    ).toEqual({ action: "skip", reason: "custom-or-already-seeded" });
  });

  it("skips external / unmanaged / unknown-mode bundles", () => {
    expect(
      decideGateBackfillAction({ urlKey: "architect", mode: "external", currentEntryContent: DEFAULT, defaultEntryContent: DEFAULT }),
    ).toEqual({ action: "skip", reason: "not-managed:external" });
    expect(
      decideGateBackfillAction({ urlKey: "architect", mode: null, currentEntryContent: DEFAULT, defaultEntryContent: DEFAULT }),
    ).toEqual({ action: "skip", reason: "not-managed:none" });
  });

  it("skips a missing / unreadable entry (conservative — operator must fix)", () => {
    expect(
      decideGateBackfillAction({ urlKey: "wiring-expert", mode: "managed", currentEntryContent: null, defaultEntryContent: DEFAULT }),
    ).toEqual({ action: "skip", reason: "entry-missing" });
  });
});

describe("backfill idempotency invariant — real seed contents", () => {
  it("each gate-role entry differs from the default entry, so re-seeded agents skip on rerun", async () => {
    const def = (await loadDefaultAgentInstructionsBundle("default"))["AGENTS.md"];
    for (const role of ["architect", "code-reviewer", "wiring-expert"] as const) {
      const roleEntry = (await loadDefaultAgentInstructionsBundle(role))["AGENTS.md"];
      expect(roleEntry).not.toBe(def);
      // The decider must skip an agent already holding the role content.
      expect(
        decideGateBackfillAction({ urlKey: role, mode: "managed", currentEntryContent: roleEntry, defaultEntryContent: def }),
      ).toEqual({ action: "skip", reason: "custom-or-already-seeded" });
    }
  });
});
