import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEARTBEAT_PROMPT_TEMPLATE,
  buildHeartbeatPromptRenderData,
  resolveHeartbeatPromptTemplate,
} from "@paperclipai/adapter-utils/server-utils";

describe("resolveHeartbeatPromptTemplate", () => {
  it("returns the default prompt when template is empty", () => {
    expect(resolveHeartbeatPromptTemplate("")).toBe(DEFAULT_HEARTBEAT_PROMPT_TEMPLATE);
    expect(resolveHeartbeatPromptTemplate("   ")).toBe(DEFAULT_HEARTBEAT_PROMPT_TEMPLATE);
    expect(resolveHeartbeatPromptTemplate(null)).toBe(DEFAULT_HEARTBEAT_PROMPT_TEMPLATE);
  });

  it("prepends the default prompt when custom template omits the placeholder", () => {
    expect(resolveHeartbeatPromptTemplate("Custom suffix.")).toBe(
      `${DEFAULT_HEARTBEAT_PROMPT_TEMPLATE}\n\nCustom suffix.`,
    );
  });

  it("preserves explicit placeholder placement including spaced form", () => {
    expect(resolveHeartbeatPromptTemplate("Before {{defaultPrompt}} after")).toBe(
      "Before {{defaultPrompt}} after",
    );
    expect(resolveHeartbeatPromptTemplate("Before {{ defaultPrompt }} after")).toBe(
      "Before {{ defaultPrompt }} after",
    );
  });
});

describe("buildHeartbeatPromptRenderData", () => {
  it("builds defaultPrompt from the same render context", () => {
    const data = buildHeartbeatPromptRenderData({
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Cursor Coder",
      },
      runId: "run-1",
      context: {
        issueId: "issue-1",
      },
    });

    expect(data).toMatchObject({
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      company: { id: "company-1" },
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Cursor Coder",
      },
      run: { id: "run-1", source: "on_demand" },
      context: { issueId: "issue-1" },
    });

    expect(data.defaultPrompt).toBe(
      "You are agent agent-1 (Cursor Coder). Continue your Paperclip work.",
    );
  });
});
