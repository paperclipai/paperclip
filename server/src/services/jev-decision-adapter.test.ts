import { APITimeoutError } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { JevDecisionAdapter } from "./jev-decision-adapter.js";
import { JEV_ISSUE_LANE_MODEL, type JevIssueLane } from "./jev-issue-lane-policy.js";

const lanes: JevIssueLane[] = [
  "engineering",
  "provider",
  "studio",
  "needs_review",
  "no_match",
];

function response(choice: JevIssueLane, confidence = 0.9) {
  const remainder = (1 - confidence) / (lanes.length - 1);
  return {
    model: JEV_ISSUE_LANE_MODEL,
    answers: {
      issue_lane: {
        type: "choice" as const,
        choice,
        confidence,
        probabilities: Object.fromEntries(
          lanes.map((lane) => [lane, lane === choice ? confidence : remainder]),
        ),
      },
    },
    usage: { input_tokens: 25, output_tokens: 5 },
  };
}

function observation(issueIdentifier: string, overrides: Partial<{
  runId: string;
  issueStatus: string;
  unresolvedDependencyCount: number;
  duplicateRun: boolean;
}> = {}) {
  return {
    runId: overrides.runId ?? `run-${issueIdentifier}`,
    issueIdentifier,
    issueStatus: overrides.issueStatus ?? "in_progress",
    unresolvedDependencyCount: overrides.unresolvedDependencyCount ?? 0,
    duplicateRun: overrides.duplicateRun ?? false,
  };
}

function adapterFor(choice: JevIssueLane, confidence = 0.9) {
  let clock = 100;
  const systemOne = vi.fn().mockResolvedValue(response(choice, confidence));
  const adapter = new JevDecisionAdapter({
    enabled: true,
    apiKey: "test-only",
    client: { systemOne } as never,
    now: () => (clock += 25),
  });
  return { adapter, systemOne };
}

describe("JevDecisionAdapter shadow issue-lane suggestions", () => {
  it.each([
    ["engineering", "JEV-TRIAL-ENGINEERING", "engineering"],
    ["provider", "JEV-TRIAL-PROVIDER", "provider"],
    ["Studio", "JEV-TRIAL-STUDIO", "studio"],
    ["ambiguous", "JEV-TRIAL-AMBIGUOUS", "needs_review"],
    ["no-match", "JEV-TRIAL-NO-MATCH", "no_match"],
  ] as const)("records the %s corpus case", async (_caseName, identifier, lane) => {
    const { adapter, systemOne } = adapterFor(lane);

    const receipt = await adapter.suggestIssueLane(observation(identifier));

    expect(receipt).toEqual({
      suggestedLane: lane,
      probabilities: expect.objectContaining({ [lane]: 0.9 }),
      modelVersion: JEV_ISSUE_LANE_MODEL,
      elapsedMs: 25,
      tokens: { input: 25, output: 5, total: 30 },
      errorCategory: null,
    });
    expect(systemOne).toHaveBeenCalledTimes(1);
    const request = systemOne.mock.calls[0]![0];
    expect(request).toEqual(expect.objectContaining({
      model: JEV_ISSUE_LANE_MODEL,
      state: {
        approved_sanitized_issue_summary: expect.any(String),
        policy_version: "tyr-issue-lanes-v1",
      },
    }));
    expect(JSON.stringify(request)).not.toContain(identifier);
  });

  it("converts a low-confidence lane to needs_review", async () => {
    const { adapter } = adapterFor("engineering", 0.55);
    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING")),
    ).resolves.toMatchObject({ suggestedLane: "needs_review" });
  });

  it.each([
    ["blocked", { issueStatus: "blocked" }],
    ["dependency-blocked", { unresolvedDependencyCount: 1 }],
    ["duplicate", { duplicateRun: true }],
  ] as const)("does not call TypeSafe for %s work", async (_caseName, overrides) => {
    const { adapter, systemOne } = adapterFor("engineering");
    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING", overrides)),
    ).resolves.toBeNull();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("observes an already-running wake at most once", async () => {
    const { adapter, systemOne } = adapterFor("engineering");
    const running = observation("JEV-TRIAL-ENGINEERING", { runId: "run-one-wake" });

    const [first, duplicate] = await Promise.all([
      adapter.suggestIssueLane(running),
      adapter.suggestIssueLane(running),
    ]);

    expect(first?.suggestedLane).toBe("engineering");
    expect(duplicate).toBeNull();
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it("does not call TypeSafe for an unapproved issue summary", async () => {
    const { adapter, systemOne } = adapterFor("engineering");
    await expect(
      adapter.suggestIssueLane(observation("TYR-UNREVIEWED")),
    ).resolves.toBeNull();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("fails open with a bounded timeout category", async () => {
    const systemOne = vi.fn().mockRejectedValue(new APITimeoutError(1_500));
    const adapter = new JevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      client: { systemOne } as never,
      now: (() => {
        let value = 0;
        return () => (value += 1_500);
      })(),
    });

    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-PROVIDER")),
    ).resolves.toEqual({
      suggestedLane: null,
      probabilities: null,
      modelVersion: JEV_ISSUE_LANE_MODEL,
      elapsedMs: 1_500,
      tokens: null,
      errorCategory: "timeout",
    });
  });

  it.each([
    ["unexpected model", { model: "provider-controlled-value" }],
    ["negative usage", { usage: { input_tokens: -1, output_tokens: 5 } }],
  ])("rejects %s without copying provider fields into the receipt", async (_caseName, override) => {
    const systemOne = vi.fn().mockResolvedValue({
      ...response("engineering"),
      ...override,
    });
    const adapter = new JevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      client: { systemOne } as never,
      now: (() => {
        let value = 0;
        return () => (value += 10);
      })(),
    });

    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING")),
    ).resolves.toEqual({
      suggestedLane: null,
      probabilities: null,
      modelVersion: JEV_ISSUE_LANE_MODEL,
      elapsedMs: 10,
      tokens: null,
      errorCategory: "invalid_response",
    });
  });

  it("stays disabled without the explicit feature flag and credential", async () => {
    const systemOne = vi.fn();
    const adapter = new JevDecisionAdapter({
      enabled: false,
      client: { systemOne } as never,
    });
    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING")),
    ).resolves.toBeNull();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("stays disabled when enabled without a credential", async () => {
    const adapter = new JevDecisionAdapter({ enabled: true, apiKey: "" });
    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING")),
    ).resolves.toBeNull();
  });
});
