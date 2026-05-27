import { describe, it, expect } from "vitest";
import manifest from "../manifest.js";

describe("manifest.tools", () => {
  const expected = [
    // Orchestration tools (Phase 1-5)
    "escalate_to_human",
    "handoff_to_agent",
    "discuss_with_agent",
    "process_media",
    "register_command",
    "register_watch",
    "remove_watch",
    "list_watch_templates",
    // Slack-API tools (Task 9)
    "slack_post_message",
    "slack_update_message",
    "slack_react",
    "slack_send_dm",
    "slack_list_channels",
    "slack_join_channel",
    "slack_list_users",
    "slack_get_user_info",
    "slack_get_thread_replies",
    "slack_search_messages",
    "slack_upload_file",
  ];

  it("declares all 19 tools with required metadata", () => {
    expect(manifest.tools).toBeDefined();
    expect(manifest.tools?.length).toBe(expected.length);
  });

  it.each(expected)("declares tool %s", (name) => {
    const tool = manifest.tools?.find((t) => t.name === name);
    expect(tool, `manifest.tools missing ${name}`).toBeDefined();
    expect(tool?.displayName).toBeTruthy();
    expect(tool?.description).toBeTruthy();
    expect(tool?.parametersSchema).toBeDefined();
  });
});

describe("manifest.instanceConfigSchema", () => {
  it("documents the escalation channel and dedupe window", () => {
    const properties = manifest.instanceConfigSchema?.properties as Record<string, unknown>;
    expect(properties.escalationChatId).toBeDefined();
    expect(properties.escalationDedupeWindowMs).toBeDefined();
  });
});
