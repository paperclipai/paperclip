import { describe, it, expect } from "vitest";
import { shouldPublishActivityAction } from "./activity-log.js";

describe("activity-log lifecycle blocklist (WS-3)", () => {
  it("does not auto-publish plugin.installed actions to the bus", () => {
    expect(shouldPublishActivityAction("plugin.installed")).toBe(false);
  });

  it("does not auto-publish plugin.uninstalled actions to the bus", () => {
    expect(shouldPublishActivityAction("plugin.uninstalled")).toBe(false);
  });

  it("does not auto-publish plugin.enabled actions to the bus", () => {
    expect(shouldPublishActivityAction("plugin.enabled")).toBe(false);
  });

  it("does not auto-publish plugin.disabled actions to the bus", () => {
    expect(shouldPublishActivityAction("plugin.disabled")).toBe(false);
  });

  it("still publishes other PLUGIN_EVENT_TYPES actions (issue.created)", () => {
    expect(shouldPublishActivityAction("issue.created")).toBe(true);
  });

  it("still publishes other PLUGIN_EVENT_TYPES actions (agent.status_changed)", () => {
    expect(shouldPublishActivityAction("agent.status_changed")).toBe(true);
  });

  it("still publishes mapped actions (issue_comment_added → issue.comment.created)", () => {
    expect(shouldPublishActivityAction("issue_comment_added")).toBe(true);
  });

  it("returns false for unknown actions", () => {
    expect(shouldPublishActivityAction("unknown.action")).toBe(false);
  });
});
