import { describe, expect, it } from "vitest";
import { models as DIRECT_MODELS } from "../index.js";
import { parseClaudeModelId, sortClaudeModels } from "./model-order.js";

const ids = (models: { id: string }[]) => models.map((model) => model.id);

describe("sortClaudeModels", () => {
  it("keeps the advertised list in the order it is declared", () => {
    // The static list is hand-ordered the way the picker shows it; the sort must agree with it.
    expect(sortClaudeModels(DIRECT_MODELS)).toEqual(DIRECT_MODELS);
  });

  it("puts the newest release of each family first, then older releases grouped by family", () => {
    const discovered = [
      { id: "claude-opus-4-8-20260529", label: "Claude Opus 4.8" },
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { id: "claude-3-7-sonnet-20250219", label: "Claude Sonnet 3.7" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      { id: "claude-3-5-haiku-20241022", label: "Claude Haiku 3.5" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ];

    expect(ids(sortClaudeModels(discovered))).toEqual([
      // newest release per family, by decreasing capability
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-4-20250514",
      "claude-haiku-4-5-20251001",
      // older releases, grouped by family, newest first, alias before dated snapshot
      "claude-opus-4-8",
      "claude-opus-4-8-20260529",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-haiku-20241022",
    ]);
  });

  it("orders dated snapshots of one release newest first, after the bare alias", () => {
    const snapshots = [
      { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5 (Sep)" },
      { id: "claude-sonnet-4-5-20251115", label: "Claude Sonnet 4.5 (Nov)" },
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    ];

    expect(ids(sortClaudeModels(snapshots))).toEqual([
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-20251115",
      "claude-sonnet-4-5-20250929",
    ]);
  });

  it("reads Bedrock region prefixes and revision suffixes", () => {
    const bedrock = [
      { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
      { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
      { id: "us.anthropic.claude-fable-5-1", label: "Bedrock Fable 5.1" },
    ];

    expect(ids(sortClaudeModels(bedrock))).toEqual([
      "us.anthropic.claude-fable-5-1",
      "us.anthropic.claude-opus-4-6-v1",
      "us.anthropic.claude-sonnet-4-5-20250929-v2:0",
    ]);
  });

  it("keeps ids it cannot read at the end, in their incoming order", () => {
    const mixed = [
      { id: "proxy/custom-model", label: "Custom" },
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "another-custom", label: "Another" },
    ];

    expect(ids(sortClaudeModels(mixed))).toEqual(["claude-opus-5", "proxy/custom-model", "another-custom"]);
  });
});

describe("parseClaudeModelId", () => {
  it("reads the current and the legacy id schemes", () => {
    expect(parseClaudeModelId("claude-opus-4-8")).toMatchObject({ major: 4, minor: 8, pinned: false });
    expect(parseClaudeModelId("claude-opus-5")).toMatchObject({ major: 5, minor: 0, pinned: false });
    expect(parseClaudeModelId("claude-3-7-sonnet-20250219")).toMatchObject({ major: 3, minor: 7, pinned: true, snapshot: 20250219 });
    expect(parseClaudeModelId("claude-3-5-sonnet-latest")).toMatchObject({ major: 3, minor: 5, pinned: false });
    expect(parseClaudeModelId("claude-sonnet-5[1m]")).toMatchObject({ major: 5, minor: 0 });
    expect(parseClaudeModelId("us.anthropic.claude-opus-4-6-v1")).toMatchObject({ major: 4, minor: 6, pinned: true });
  });

  it("returns null for ids that are not Claude models", () => {
    expect(parseClaudeModelId("gpt-6-astra")).toBeNull();
    expect(parseClaudeModelId("claude-instant-1.2")).toBeNull();
    expect(parseClaudeModelId("arn:aws:bedrock:us-east-1:123:inference-profile/x")).toBeNull();
  });
});
