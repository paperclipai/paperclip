import { describe, expect, it } from "vitest";
import {
  ANTI_EARLY_STOP_HEADING,
  ANTI_EARLY_STOP_INSTRUCTIONS,
  appendAntiEarlyStopInstructions,
} from "./anti-early-stop-instructions.js";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";
import { buildOnboardingFirstAgentInstructionsBundle } from "./onboarding-first-task-assets.js";
import { listBuiltInAgentDefinitions, validateBuiltInAgentDefinitions } from "./built-in-agents.js";

// K-20104. Unattended runs end early when a turn closes with a status update
// instead of a tool call, because the harness reads `stop_reason: "end_turn"` as
// "done". These tests pin the prompt-side guard and the runtime guard it leans on.
describe("anti-early-stop instructions", () => {
  it("appends the block last so it survives the rest of the system prompt", () => {
    const appended = appendAntiEarlyStopInstructions("# Role\n\nDo the thing.");
    expect(appended.startsWith("# Role\n\nDo the thing.")).toBe(true);
    expect(appended.trimEnd().endsWith(ANTI_EARLY_STOP_INSTRUCTIONS.trimEnd())).toBe(true);
  });

  it("requires the status note to ride along with the next tool call", () => {
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).toContain(
      "Put a status note in the *same* message as your next tool call",
    );
  });

  it("tells the model to delete the stall-the-run closing offers", () => {
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).toContain("unless you'd prefer otherwise");
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).toMatch(/Delete any closing offer/);
  });

  it("scopes out the risky/irreversible confirmation requirement", () => {
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).toContain(
      "This never overrides confirmation. Risky, destructive, or irreversible actions still need",
    );
  });

  it("scopes out human-in-the-loop waits", () => {
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).toContain(
      "It also does not apply while a human is present to answer",
    );
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).toContain("ask_user_questions");
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).toContain("request_confirmation");
  });

  it("is idempotent, so reconcile and stock updates cannot double-append", () => {
    const once = appendAntiEarlyStopInstructions("# Role");
    expect(appendAntiEarlyStopInstructions(once)).toBe(once);
  });

  it("treats a hand-copied heading as already present", () => {
    const handEdited = `# Role\n\n${ANTI_EARLY_STOP_HEADING}\n\nMy own words.`;
    expect(appendAntiEarlyStopInstructions(handEdited)).toBe(handEdited);
  });

  it("names the bounded re-run it is protecting against", () => {
    // The promise is only honest while the runtime keeps re-running plan_only runs.
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).toContain("plan_only");
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).toContain("bounded number of times");
  });

  it("does not promise a re-run the runtime will not deliver", () => {
    // `classifyRunLiveness` only returns `plan_only` when the described future work
    // is judged runnable; otherwise it returns `needs_followup`, and
    // `ACTIONABLE_LIVENESS_STATES` is {plan_only, empty_response} — so
    // `needs_followup` gets no continuation. Claiming an unconditional re-run is a
    // control the prompt believes exists and the runtime does not provide.
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).toContain("needs_followup");
    expect(ANTI_EARLY_STOP_INSTRUCTIONS).not.toMatch(/recorded as `plan_only` and re-runs you a bounded number of times\.\s*$/m);
  });
});

describe("built-in instruction bundles carry the block", () => {
  it("puts it in the default and CEO onboarding bundles", async () => {
    for (const role of ["default", "ceo"] as const) {
      const bundle = await loadDefaultAgentInstructionsBundle(role);
      const entry = bundle["AGENTS.md"]!;
      expect(entry, role).toContain(ANTI_EARLY_STOP_HEADING);
      // Last in the system prompt, not somewhere the tail can drown it out.
      expect(entry.trimEnd().endsWith(ANTI_EARLY_STOP_INSTRUCTIONS.trimEnd())).toBe(true);
    }
  });

  it("keeps the existing default execution contract intact", async () => {
    const entry = (await loadDefaultAgentInstructionsBundle("default"))["AGENTS.md"]!;
    expect(entry).toContain("Start actionable work in the same heartbeat.");
    expect(entry).toContain("Keep the work moving until it is done.");
    expect(entry).toContain('kind: "request_confirmation"');
  });

  it("puts it in the onboarding first-agent chief-of-staff bundle", async () => {
    const bundle = await buildOnboardingFirstAgentInstructionsBundle({
      agentName: "Ada",
      organizationName: "Acme",
    });
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files["AGENTS.md"]).toContain("You are Ada, chief of staff for Acme.");
    expect(bundle.files["AGENTS.md"]!.trimEnd().endsWith(ANTI_EARLY_STOP_INSTRUCTIONS.trimEnd())).toBe(true);
  });

  it("puts it in every bundled built-in agent's entry file", () => {
    const bundled = listBuiltInAgentDefinitions().filter((definition) => definition.bundle);
    expect(bundled.length).toBeGreaterThan(0);
    for (const definition of bundled) {
      const entry = definition.bundle!.instructions.entryFile;
      const content = definition.bundle!.instructions.files[entry]!;
      expect(content, definition.key).toContain(ANTI_EARLY_STOP_HEADING);
      expect(content.trimEnd().endsWith(ANTI_EARLY_STOP_INSTRUCTIONS.trimEnd()), definition.key).toBe(true);
    }
  });

  it("appends exactly once per bundled entry file", () => {
    for (const definition of listBuiltInAgentDefinitions()) {
      const entry = definition.bundle?.instructions.entryFile;
      if (!entry) continue;
      const content = definition.bundle!.instructions.files[entry]!;
      const occurrences = content.split(ANTI_EARLY_STOP_HEADING).length - 1;
      expect(occurrences, definition.key).toBe(1);
    }
  });

  it("stays single after the bundle is assembled twice", async () => {
    // Idempotency has to hold on the real assembly path, not just the raw helper.
    // Bundles are re-assembled on reconcile and re-materialized on stock updates,
    // so `validateBuiltInAgentDefinitions` runs more than once per agent over its
    // life. Re-running it must not grow the block.
    const [first, second] = [
      validateBuiltInAgentDefinitions(listBuiltInAgentDefinitions()),
      validateBuiltInAgentDefinitions(listBuiltInAgentDefinitions()),
    ];
    for (const pass of [first, second]) {
      for (const definition of pass) {
        const entry = definition.bundle?.instructions.entryFile;
        if (!entry) continue;
        const content = definition.bundle!.instructions.files[entry]!;
        const occurrences = content.split(ANTI_EARLY_STOP_HEADING).length - 1;
        expect(occurrences, `${definition.key} on re-assembly`).toBe(1);
      }
    }

    // The default bundle is read from disk on every call, so it is the one path
    // that can genuinely see the same source twice.
    const a = (await loadDefaultAgentInstructionsBundle("default"))["AGENTS.md"]!;
    const b = (await loadDefaultAgentInstructionsBundle("default"))["AGENTS.md"]!;
    expect(a).toBe(b);
    expect(a.split(ANTI_EARLY_STOP_HEADING).length - 1).toBe(1);
  });
});
