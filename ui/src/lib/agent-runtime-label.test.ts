import { describe, expect, it } from "vitest";
import { isCrewAiAgent, isLangGraphAgent, runtimeLabelForAgent } from "./agent-runtime-label";

describe("agent runtime label detection", () => {
  it("detects CrewAI via capabilities hint", () => {
    const agent = {
      adapterType: "http",
      capabilities: "Runs CrewAI pipelines for research workflows",
      adapterConfig: {},
    };
    expect(isCrewAiAgent(agent as never)).toBe(true);
    expect(runtimeLabelForAgent(agent as never, "HTTP")).toBe("CrewAI (HTTP)");
  });

  it("detects CrewAI via URL hint", () => {
    const agent = {
      adapterType: "http",
      capabilities: null,
      adapterConfig: { url: "https://crewai-runner.internal/execute" },
    };
    expect(isCrewAiAgent(agent as never)).toBe(true);
  });

  it("detects CrewAI via runtime header", () => {
    const agent = {
      adapterType: "http",
      capabilities: null,
      adapterConfig: { headers: { "x-agent-runtime": "CrewAI" } },
    };
    expect(isCrewAiAgent(agent as never)).toBe(true);
  });

  it("detects CrewAI via runtime profile", () => {
    const agent = {
      adapterType: "http",
      capabilities: null,
      adapterConfig: { runtimeProfile: "http+crewai" },
    };
    expect(isCrewAiAgent(agent as never)).toBe(true);
  });

  it("does not detect CrewAI for non-http adapters", () => {
    const agent = {
      adapterType: "claude_local",
      capabilities: "CrewAI mention should be ignored",
      adapterConfig: {},
    };
    expect(isCrewAiAgent(agent as never)).toBe(false);
    expect(runtimeLabelForAgent(agent as never, "Claude")).toBe("Claude");
  });

  it("detects LangGraph via runtime profile", () => {
    const agent = {
      adapterType: "http",
      capabilities: null,
      adapterConfig: { runtimeProfile: "http+langgraph" },
    };
    expect(isLangGraphAgent(agent as never)).toBe(true);
    expect(runtimeLabelForAgent(agent as never, "HTTP")).toBe("LangGraph (HTTP)");
  });
});
