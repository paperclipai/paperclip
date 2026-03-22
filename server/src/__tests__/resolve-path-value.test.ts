import { describe, expect, it } from "vitest";
import {
  expandAgentHomeInText,
  renderTemplate,
  resolvePathValue,
} from "@paperclipai_dld/adapter-utils/server-utils";

describe("resolvePathValue", () => {
  it("returns empty string for arrays instead of JSON (avoids [] path prefixes)", () => {
    const data: Record<string, unknown> = {
      context: { paperclipWorkspaces: [] as unknown[] },
    };
    expect(resolvePathValue(data, "context.paperclipWorkspaces")).toBe("");
  });
});

describe("expandAgentHomeInText", () => {
  it("replaces ${AGENT_HOME} before $AGENT_HOME and leaves text unchanged when home is empty", () => {
    expect(expandAgentHomeInText("${AGENT_HOME}/x $AGENT_HOME/y", "/home/a")).toBe("/home/a/x /home/a/y");
    expect(expandAgentHomeInText("$AGENT_HOME/x", "")).toBe("$AGENT_HOME/x");
  });
});

describe("renderTemplate", () => {
  it("does not prefix paths with [] when paperclipWorkspaces is empty", () => {
    const data: Record<string, unknown> = {
      context: { paperclipWorkspaces: [] },
    };
    const out = renderTemplate(
      "ROOT={{context.paperclipWorkspaces}}/instances/default/workspaces/x",
      data,
    );
    expect(out).toBe("ROOT=/instances/default/workspaces/x");
  });
});
