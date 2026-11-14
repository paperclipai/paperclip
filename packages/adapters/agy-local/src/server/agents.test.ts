import { describe, expect, it } from "vitest";
import { parseAgyAgentsOutput } from "./agents.js";

describe("parseAgyAgentsOutput", () => {
  it("parses single agent without description", () => {
    const raw = `Available agents:\nflutter_a11y_agent\n`;
    expect(parseAgyAgentsOutput(raw)).toEqual([
      { id: "flutter_a11y_agent", label: "flutter_a11y_agent" },
    ]);
  });

  it("parses multiple agents with descriptions and ANSI codes", () => {
    const raw = `
\x1b[32mAvailable agents:\x1b[0m
  research            Expert research assistant for code and documentation
  flutter_a11y_agent  Accessibility expert for Flutter
  custom_agent
`;
    expect(parseAgyAgentsOutput(raw)).toEqual([
      {
        id: "research",
        label: "research (Expert research assistant for code and documentation)",
        description: "Expert research assistant for code and documentation",
      },
      {
        id: "flutter_a11y_agent",
        label: "flutter_a11y_agent (Accessibility expert for Flutter)",
        description: "Accessibility expert for Flutter",
      },
      {
        id: "custom_agent",
        label: "custom_agent",
      },
    ]);
  });

  it("handles empty or error output", () => {
    expect(parseAgyAgentsOutput("")).toEqual([]);
    expect(parseAgyAgentsOutput("No agents found")).toEqual([
      { id: "No", label: "No (agents found)", description: "agents found" },
    ]);
  });
});
