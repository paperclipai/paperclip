import { describe, it, expect } from "vitest";
import { getAgentIcon, AGENT_ICONS } from "./agent-icons.js";

describe("getAgentIcon", () => {
  it("returns the Bot icon for null input", () => {
    expect(getAgentIcon(null)).toBe(AGENT_ICONS.bot);
  });

  it("returns the Bot icon for undefined input", () => {
    expect(getAgentIcon(undefined)).toBe(AGENT_ICONS.bot);
  });

  it("returns the Bot icon for an empty string", () => {
    expect(getAgentIcon("")).toBe(AGENT_ICONS.bot);
  });

  it("returns the Bot icon for an unrecognized name", () => {
    expect(getAgentIcon("not-a-real-icon")).toBe(AGENT_ICONS.bot);
  });

  it("returns the correct icon for 'bot'", () => {
    expect(getAgentIcon("bot")).toBe(AGENT_ICONS.bot);
  });

  it("returns the correct icon for 'cpu'", () => {
    expect(getAgentIcon("cpu")).toBe(AGENT_ICONS.cpu);
  });

  it("returns the correct icon for 'brain'", () => {
    expect(getAgentIcon("brain")).toBe(AGENT_ICONS.brain);
  });

  it("returns the correct icon for 'rocket'", () => {
    expect(getAgentIcon("rocket")).toBe(AGENT_ICONS.rocket);
  });

  it("returns the correct icon for 'crown'", () => {
    expect(getAgentIcon("crown")).toBe(AGENT_ICONS.crown);
  });

  it("returns the correct icon for hyphenated names like 'git-branch'", () => {
    expect(getAgentIcon("git-branch")).toBe(AGENT_ICONS["git-branch"]);
  });

  it("returns the correct icon for 'message-square'", () => {
    expect(getAgentIcon("message-square")).toBe(AGENT_ICONS["message-square"]);
  });

  it("returns the correct icon for 'file-code'", () => {
    expect(getAgentIcon("file-code")).toBe(AGENT_ICONS["file-code"]);
  });

  it("returns a non-null object (React component) for any known icon", () => {
    const icon = getAgentIcon("zap");
    expect(icon).toBeTruthy();
    expect(icon).not.toBeNull();
  });

  it("returns a non-null object (React component) for the default icon", () => {
    const icon = getAgentIcon(null);
    expect(icon).toBeTruthy();
    expect(icon).not.toBeNull();
  });

  it("all AGENT_ICONS values are non-null (React components)", () => {
    for (const [name, icon] of Object.entries(AGENT_ICONS)) {
      expect(icon, `${name} should be non-null`).toBeTruthy();
    }
  });
});
