// LET-504 — Pure-function coverage for the manual agent builder state
// model. Stepper transitions, summary derivation, and unavailable-row
// classification are exercised here so the React surface only has to
// cover render-level behavior.

import { describe, expect, it } from "vitest";
import {
  AGENT_BUILDER_STEPS,
  DEFAULT_AGENT_BUILDER_STATE,
  availabilityBadgeText,
  getInvocationChannelRows,
  getStepIndex,
  getToolGroupCards,
  isAvailabilityDisabled,
  isFinalStep,
  isFirstStep,
  nextStep,
  previousStep,
  summarizeAgentBuilder,
} from "./agent-builder-state";

describe("stepper transitions", () => {
  it("walks identity → model → invocations → tools → skills → knowledge", () => {
    const order: string[] = [];
    let id = AGENT_BUILDER_STEPS[0]!.id;
    for (let i = 0; i < AGENT_BUILDER_STEPS.length; i += 1) {
      order.push(id);
      id = nextStep(id);
    }
    expect(order).toEqual(["identity", "model", "invocations", "tools", "skills", "knowledge"]);
  });

  it("clamps nextStep at the final step", () => {
    expect(nextStep("knowledge")).toBe("knowledge");
  });

  it("clamps previousStep at the first step", () => {
    expect(previousStep("identity")).toBe("identity");
  });

  it("reports isFirstStep / isFinalStep correctly", () => {
    expect(isFirstStep("identity")).toBe(true);
    expect(isFirstStep("model")).toBe(false);
    expect(isFinalStep("knowledge")).toBe(true);
    expect(isFinalStep("tools")).toBe(false);
  });

  it("reports zero-based index", () => {
    expect(getStepIndex("identity")).toBe(0);
    expect(getStepIndex("knowledge")).toBe(5);
  });
});

describe("summarizeAgentBuilder", () => {
  it("uses 'Unnamed agent' until a name is entered", () => {
    const summary = summarizeAgentBuilder(DEFAULT_AGENT_BUILDER_STATE);
    expect(summary.displayName).toBe("Unnamed agent");
    expect(summary.canCreate).toBe(false);
  });

  it("redacts secret-like values out of the live preview name", () => {
    const summary = summarizeAgentBuilder({
      ...DEFAULT_AGENT_BUILDER_STATE,
      name: "Bot Bearer abcdefghijklmnopqrst",
    });
    // The redactor strips bearer-token-like substrings; we only assert that
    // the original secret-like sequence does not appear verbatim.
    expect(summary.displayName).not.toContain("abcdefghijklmnopqrst");
  });

  it("flips canCreate once name and model are present", () => {
    expect(
      summarizeAgentBuilder({ ...DEFAULT_AGENT_BUILDER_STATE, name: "Research Analyst" }).canCreate,
    ).toBe(true);
    expect(
      summarizeAgentBuilder({
        ...DEFAULT_AGENT_BUILDER_STATE,
        name: "Research Analyst",
        model: "",
      }).canCreate,
    ).toBe(false);
  });

  it("only counts thread and scheduled toward invocation total", () => {
    const off = summarizeAgentBuilder({ ...DEFAULT_AGENT_BUILDER_STATE, scheduledEnabled: false });
    expect(off.invocationCount).toBe(1);
    expect(off.invocationLabel).toBe("1 invocation");

    const on = summarizeAgentBuilder({ ...DEFAULT_AGENT_BUILDER_STATE, scheduledEnabled: true });
    expect(on.invocationCount).toBe(2);
    expect(on.invocationLabel).toBe("2 invocations");
  });

  it("never claims real integrations until any are connected", () => {
    const summary = summarizeAgentBuilder(DEFAULT_AGENT_BUILDER_STATE);
    expect(summary.integrationCount).toBe(0);
    expect(summary.integrationLabel.toLowerCase()).toContain("none connected");
    expect(summary.integrationLabel.toLowerCase()).not.toContain("backend gap");
  });

  it("reflects selected tools and pinned skills counts", () => {
    const summary = summarizeAgentBuilder({
      ...DEFAULT_AGENT_BUILDER_STATE,
      selectedToolIds: ["shell", "web-search"],
      selectedSkillKeys: ["sk-one"],
    });
    expect(summary.toolCount).toBe(2);
    expect(summary.toolLabel).toBe("2 tools selected");
    expect(summary.skillsLabel).toBe("Discovery on, 1 pinned");
  });

  it("encodes thinking and budget labels", () => {
    const summary = summarizeAgentBuilder({
      ...DEFAULT_AGENT_BUILDER_STATE,
      extendedThinking: false,
      perQueryBudgetCents: 250,
    });
    expect(summary.thinkingLabel).toBe("Extended thinking off");
    expect(summary.budgetLabel).toContain("$2.50");
  });
});

describe("invocation channel availability", () => {
  it("marks thread and scheduled as available, everything else as not-available", () => {
    const rows = getInvocationChannelRows({ agentSaved: false });
    const map = Object.fromEntries(rows.map((row) => [row.id, row.availability.kind]));
    expect(map.thread).toBe("available");
    expect(map.scheduled).toBe("available");
    expect(map.slack).toBe("connect");
    expect(map.telegram).toBe("connect");
    expect(map.email).toBe("backend-gap");
  });

  it("flips webhook to save-first while the agent is unsaved", () => {
    const unsaved = getInvocationChannelRows({ agentSaved: false }).find((r) => r.id === "webhook")!;
    expect(unsaved.availability.kind).toBe("save-first");
    const saved = getInvocationChannelRows({ agentSaved: true }).find((r) => r.id === "webhook")!;
    expect(saved.availability.kind).toBe("backend-gap");
  });

  it("never invents a fake-success badge for unavailable rows", () => {
    const rows = getInvocationChannelRows({ agentSaved: false });
    for (const row of rows) {
      if (row.availability.kind === "available") continue;
      const text = availabilityBadgeText(row.availability);
      expect(text).not.toBe("Available");
      expect(isAvailabilityDisabled(row.availability)).toBe(true);
    }
  });
});

describe("tool group cards", () => {
  it("splits cards into execution / research / data groups", () => {
    const cards = getToolGroupCards({ agentSaved: false });
    const groups = new Set(cards.map((card) => card.group));
    expect(groups).toEqual(new Set(["execution", "research", "data"]));
  });

  it("flips browser and warehouse to save-first when the agent is unsaved", () => {
    const cards = getToolGroupCards({ agentSaved: false });
    const browser = cards.find((c) => c.id === "browser")!;
    const warehouse = cards.find((c) => c.id === "warehouse")!;
    expect(browser.availability.kind).toBe("save-first");
    expect(warehouse.availability.kind).toBe("save-first");
  });
});
