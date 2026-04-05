import { describe, expect, it } from "vitest";

const {
  normalizeTopicKey,
  summarizeTopicSelectionPolicy,
  selectTopicWithCooldown,
  selectTopicAvoidingPublished,
  resolveTopicSelectionFromArgs,
  getTopicScoutStaleReason,
} = require("/Users/daehan/Documents/persona/paperclip/scripts/create_article_quality_loop_run.cjs");

describe("create_article_quality_loop_run topic cooldown", () => {
  it("skips a recently used top-ranked topic and selects the next candidate", () => {
    const topicScout = {
      generated_at: "2026-04-05T00:00:00.000Z",
      selected_topic: "NVIDIA Nemotron 3 Super: 5x Agentic AI Boost",
      selected_bucket: "ai_updates",
      selection_reason: "source=official, freshness=10",
      topic_scorecard: { total: 30 },
      top10_candidates: [
        {
          rank: 1,
          title: "NVIDIA Nemotron 3 Super: 5x Agentic AI Boost",
          bucket: "ai_updates",
          why_now: "source=official, freshness=10",
          topic_scorecard: { total: 30 },
        },
        {
          rank: 2,
          title: "OpenAI and Google MCP adoption changes workflow choices",
          bucket: "ai_updates",
          why_now: "source=tier_s, freshness=8",
          topic_scorecard: { total: 27 },
        },
      ],
    };

    const result = selectTopicWithCooldown(
      topicScout,
      [{ topic: "NVIDIA Nemotron 3 Super: 5x Agentic AI Boost", created_at: "2026-04-04T18:30:00.000Z" }],
      12,
    );

    expect(result.selectedTopic).toBe("OpenAI and Google MCP adoption changes workflow choices");
    expect(result.selectedRank).toBe(2);
    expect(result.cooldownApplied).toBe(true);
    expect(result.skippedRecentTopics).toHaveLength(1);
  });

  it("falls back to the top candidate when all candidates are inside cooldown", () => {
    const topicScout = {
      generated_at: "2026-04-05T00:00:00.000Z",
      selected_topic: "NVIDIA Nemotron 3 Super: 5x Agentic AI Boost",
      selected_bucket: "ai_updates",
      selection_reason: "source=official, freshness=10",
      topic_scorecard: { total: 30 },
      top10_candidates: [
        {
          rank: 1,
          title: "NVIDIA Nemotron 3 Super: 5x Agentic AI Boost",
          bucket: "ai_updates",
          why_now: "source=official, freshness=10",
          topic_scorecard: { total: 30 },
        },
      ],
    };

    const result = selectTopicWithCooldown(
      topicScout,
      [{ topic: "NVIDIA Nemotron 3 Super: 5x Agentic AI Boost", created_at: "2026-04-04T23:30:00.000Z" }],
      12,
    );

    expect(result.selectedTopic).toBe("NVIDIA Nemotron 3 Super: 5x Agentic AI Boost");
    expect(result.selectedRank).toBe(1);
    expect(result.cooldownApplied).toBe(true);
  });

  it("normalizes topic keys for matching", () => {
    expect(normalizeTopicKey("  NVIDIA   Nemotron 3 Super: 5x Agentic AI Boost  "))
      .toBe("nvidia nemotron 3 super: 5x agentic ai boost");
  });

  it("rejects stale dashboard data beyond the max age", () => {
    const reason = getTopicScoutStaleReason({ dashboard_age_hours: 321.3 }, 48);
    expect(reason).toBe("article_quality_loop_dashboard_stale:321.3h>48h");
  });

  it("does not reject fresh dashboard data within max age", () => {
    const reason = getTopicScoutStaleReason({ dashboard_age_hours: 6.5 }, 48);
    expect(reason).toBeNull();
  });

  it("skips already published titles and selects the next candidate", () => {
    const topicScout = {
      generated_at: "2026-04-05T00:00:00.000Z",
      selected_topic: "OpenAI·Google의 MCP 채택, 비즈니스 사용자가 먼저 체감할 변화 3가지",
      selected_bucket: "ai_updates",
      selection_reason: "source=official, freshness=10",
      topic_scorecard: { total: 30 },
      top10_candidates: [
        {
          rank: 1,
          title: "OpenAI·Google의 MCP 채택, 비즈니스 사용자가 먼저 체감할 변화 3가지",
          bucket: "ai_updates",
          why_now: "source=official, freshness=10",
          topic_scorecard: { total: 30 },
        },
        {
          rank: 2,
          title: "GTC Spotlights NVIDIA RTX PCs and DGX Sparks Running Latest Open Models and AI Agents Locally",
          bucket: "ai_updates",
          why_now: "source=official, freshness=3",
          topic_scorecard: { total: 24 },
        },
      ],
    };

    const result = selectTopicAvoidingPublished(
      topicScout,
      [],
      ["OpenAI·Google의 MCP 채택, 비즈니스 사용자가 먼저 체감할 변화 3가지"],
      12,
    );

    expect(result.selectedTopic).toBe("GTC Spotlights NVIDIA RTX PCs and DGX Sparks Running Latest Open Models and AI Agents Locally");
    expect(result.selectedRank).toBe(2);
    expect(result.skippedPublishedTopics).toHaveLength(1);
  });

  it("tags repeated unchanged winners as holdovers and carries grok exception streaks", () => {
    const policy = summarizeTopicSelectionPolicy(
      [
        {
          created_at: "2026-04-05T13:30:00.000Z",
          research_result_json: {
            source_registry: [{ url: "https://example.com/mcp" }],
            fact_pack: {
              claim_list: [{ claim: "Same thesis", evidence: "Same evidence" }],
            },
            uncertainty_ledger: [{ kind: "conflict", issue: "same" }],
          },
          artifacts: [
            {
              artifactKind: "grok_artifact_step_error",
              metadata: { mode: "trend-scan" },
            },
          ],
        },
      ],
      "https://example.com/mcp",
      "2026-04-05T15:00:00.000Z",
    );

    expect(policy.holdoverTag).toBe("delta / repeated holdover confirmation");
    expect(policy.repeatCount).toBe(2);
    expect(policy.grokExceptionStreak).toBe(1);
    expect(policy.hasNewSourceSignal).toBe(false);
  });

  it("skips suppressed stale holdovers and pivots to the next candidate", () => {
    const topicScout = {
      generated_at: "2026-04-05T16:00:00.000Z",
      selected_topic: "Same holdover topic",
      selected_bucket: "ai_updates",
      selection_reason: "source=official, freshness=10",
      top10_candidates: [
        {
          rank: 1,
          title: "Same holdover topic",
          link: "https://example.com/holdover",
          bucket: "ai_updates",
          why_now: "same topic again",
          topic_scorecard: { total: 30 },
        },
        {
          rank: 2,
          title: "Fresh fallback topic",
          link: "https://example.com/fresh",
          bucket: "ai_updates",
          why_now: "fresh source",
          topic_scorecard: { total: 26 },
        },
      ],
    };

    const sameEvidenceHistory = [
      {
        created_at: "2026-04-05T14:30:00.000Z",
        research_result_json: {
          source_registry: [{ url: "https://example.com/holdover" }],
          fact_pack: { claim_list: [{ claim: "A", evidence: "B" }] },
          uncertainty_ledger: [{ kind: "conflict", issue: "same" }],
        },
        artifacts: [{ artifactKind: "grok_artifact_step_error", metadata: { mode: "trend-scan" } }],
      },
      {
        created_at: "2026-04-05T12:30:00.000Z",
        research_result_json: {
          source_registry: [{ url: "https://example.com/holdover" }],
          fact_pack: { claim_list: [{ claim: "A", evidence: "B" }] },
          uncertainty_ledger: [{ kind: "conflict", issue: "same" }],
        },
        artifacts: [{ artifactKind: "grok_artifact_step_error", metadata: { mode: "trend-scan" } }],
      },
      {
        created_at: "2026-04-05T10:30:00.000Z",
        research_result_json: {
          source_registry: [{ url: "https://example.com/holdover" }],
          fact_pack: { claim_list: [{ claim: "A", evidence: "B" }] },
          uncertainty_ledger: [{ kind: "conflict", issue: "same" }],
        },
        artifacts: [{ artifactKind: "grok_trend_scan_json", metadata: { ok: true, mode: "trend-scan" } }],
      },
    ];

    const result = selectTopicAvoidingPublished(
      topicScout,
      [],
      [],
      12,
      {
        referenceAt: "2026-04-05T16:00:00.000Z",
        topicHistories: {
          [normalizeTopicKey("Same holdover topic")]: sameEvidenceHistory,
        },
      },
    );

    expect(result.selectedTopic).toBe("Fresh fallback topic");
    expect(result.selectedRank).toBe(2);
    expect(result.skippedSuppressedTopics).toEqual([
      expect.objectContaining({
        title: "Same holdover topic",
        holdoverTag: "suppressed stale holdover",
        repeatCount: 4,
      }),
    ]);
    expect(result.managerReviewRequired).toBe(false);
  });

  it("flags manager review when every available candidate is suppressed", () => {
    const topicScout = {
      generated_at: "2026-04-05T16:00:00.000Z",
      selected_topic: "Same holdover topic",
      selected_bucket: "ai_updates",
      selection_reason: "source=official, freshness=10",
      top10_candidates: [
        {
          rank: 1,
          title: "Same holdover topic",
          link: "https://example.com/holdover",
          bucket: "ai_updates",
          why_now: "same topic again",
          topic_scorecard: { total: 30 },
        },
      ],
    };

    const result = selectTopicAvoidingPublished(
      topicScout,
      [],
      [],
      12,
      {
        referenceAt: "2026-04-05T16:00:00.000Z",
        topicHistories: {
          [normalizeTopicKey("Same holdover topic")]: [
            {
              created_at: "2026-04-05T14:30:00.000Z",
              research_result_json: {
                source_registry: [{ url: "https://example.com/holdover" }],
                fact_pack: { claim_list: [{ claim: "A", evidence: "B" }] },
                uncertainty_ledger: [{ kind: "conflict", issue: "same" }],
              },
              artifacts: [{ artifactKind: "grok_artifact_step_error", metadata: { mode: "trend-scan" } }],
            },
            {
              created_at: "2026-04-05T12:30:00.000Z",
              research_result_json: {
                source_registry: [{ url: "https://example.com/holdover" }],
                fact_pack: { claim_list: [{ claim: "A", evidence: "B" }] },
                uncertainty_ledger: [{ kind: "conflict", issue: "same" }],
              },
              artifacts: [{ artifactKind: "grok_artifact_step_error", metadata: { mode: "trend-scan" } }],
            },
            {
              created_at: "2026-04-05T10:30:00.000Z",
              research_result_json: {
                source_registry: [{ url: "https://example.com/holdover" }],
                fact_pack: { claim_list: [{ claim: "A", evidence: "B" }] },
                uncertainty_ledger: [{ kind: "conflict", issue: "same" }],
              },
              artifacts: [{ artifactKind: "grok_trend_scan_json", metadata: { ok: true, mode: "trend-scan" } }],
            },
          ],
        },
      },
    );

    expect(result.selectedTopic).toBeNull();
    expect(result.managerReviewRequired).toBe(true);
    expect(result.selectionPolicy).toMatchObject({
      holdoverTag: "suppressed stale holdover",
      repeatCount: 4,
    });
  });

  it("honors explicit topic override without cooldown or published-title filtering", () => {
    const result = resolveTopicSelectionFromArgs(
      { topic: "Manual override topic", bucket: "market_strategy" },
      {
        selected_topic: "Old topic",
        selected_bucket: "ai_updates",
      },
      [{ topic: "Manual override topic", created_at: "2026-04-05T00:00:00.000Z" }],
      ["Manual override topic"],
      12,
    );

    expect(result.selectedTopic).toBe("Manual override topic");
    expect(result.selectedBucket).toBe("market_strategy");
    expect(result.selectionReason).toBe("manual_topic_override");
    expect(result.explicitTopic).toBe(true);
    expect(result.cooldownApplied).toBe(false);
    expect(result.skippedRecentTopics).toEqual([]);
    expect(result.skippedPublishedTopics).toEqual([]);
  });
});
