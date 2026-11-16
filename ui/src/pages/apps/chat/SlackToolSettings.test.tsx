// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SlackToolCapabilities } from "@paperclipai/shared";
import { SlackCapabilitiesView } from "./SlackToolSettings";

function guidance(action?: "enable" | "reconnect") {
  const capabilities: SlackToolCapabilities = {
    grantedScopes: ["chat:write"], missingScopes: [], tools: [],
    missingGroups: [{ group: "file_upload", label: "File upload", description: "Upload attachments.",
      scopes: ["files:write"], toolNames: ["slack_upload_file"], action }],
  };
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(<SlackCapabilitiesView capabilities={capabilities} />);
  return element.textContent ?? "";
}

describe("Slack permission group guidance", () => {
  it("asks to turn on a group not yet requested, then reconnect", () => {
    expect(guidance("enable")).toContain("Turn on this group");
    expect(guidance("enable")).toContain("reconnect");
  });
  it.each(["enable", "reconnect", undefined] as const)("shows the label once and the description for action %s", action => {
    const text = guidance(action);
    expect(text.match(/File upload/g)).toHaveLength(1);
    expect(text).toContain("Upload attachments.");
  });
  it("treats older payloads without an action as enable then reconnect", () => {
    expect(guidance()).toContain("Turn on this group");
    expect(guidance()).toContain("reconnect");
  });
  it("asks only to reconnect for an already-requested group awaiting its grant", () => {
    expect(guidance("reconnect")).toContain("already requested");
    expect(guidance("reconnect")).toContain("reconnect");
    expect(guidance("reconnect")).not.toContain("Turn on");
    expect(guidance("reconnect")).toContain("slack_upload_file");
  });
});

describe("Slack DM reconnect notice (TECH-8783)", () => {
  it("renders reconnect notice when dmReconnectRequired is true", () => {
    const capabilities: SlackToolCapabilities = {
      grantedScopes: ["chat:write"],
      missingScopes: ["im:write"],
      dmReconnectRequired: true,
      tools: [],
    };
    const element = document.createElement("div");
    element.innerHTML = renderToStaticMarkup(<SlackCapabilitiesView capabilities={capabilities} />);
    expect(element.textContent).toContain("Reconnect Slack to grant DM permission");
    expect(element.textContent).toContain("slack_open_dm will fail until you reconnect");
  });

  it("hides reconnect notice when dmReconnectRequired is false or undefined", () => {
    const capabilities: SlackToolCapabilities = {
      grantedScopes: ["chat:write", "im:write"],
      missingScopes: [],
      dmReconnectRequired: false,
      tools: [],
    };
    const element = document.createElement("div");
    element.innerHTML = renderToStaticMarkup(<SlackCapabilitiesView capabilities={capabilities} />);
    expect(element.textContent).not.toContain("Reconnect Slack to grant DM permission");
  });
});
