import { describe, expect, it } from "vitest";

const {
  normalizeTopicKey,
  selectTopicWithCooldown,
  selectTopicAvoidingPublished,
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
});
