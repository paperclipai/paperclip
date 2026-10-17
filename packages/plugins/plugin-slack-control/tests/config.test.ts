import { describe, expect, it } from "vitest";
import { parseConfig, parseMessage } from "../src/config.js";
import { config, envelope } from "./helpers.js";

describe("explicit identity and input boundary", () => {
  it("starts disabled and accepts secret references only", () => {
    expect(parseConfig({})).toBeNull();
    expect(parseConfig(config)).toEqual(config);
    expect(() => parseConfig({ ...config, appToken: "xapp-private" })).toThrow();
    expect(() => parseConfig({ ...config, botToken: { type: "plain", value: "private" } })).toThrow();
    expect(() => parseConfig({ ...config, users: [...config.users, ...config.users] })).toThrow();
    expect(() => parseConfig({ ...config, projects: [{ ...config.projects[0], alias: "../../shell" }] })).toThrow();
    expect(() => parseConfig({ ...config, users: [{ ...config.users[0], actorAgentId: "spoofed" }] })).toThrow();
  });
  it("accepts a configured human's direct message", () => {
    expect(parseMessage(envelope(), config)?.userId).toBe("UTEST");
  });
  it.each([
    { channel_type: "channel" }, { channel_type: "mpim" }, { channel: "CTEST" },
    { subtype: "message_changed" }, { subtype: "message_deleted" }, { subtype: "bot_message" },
    { bot_id: "BTEST" }, { bot_profile: {} }, { app_id: "ATEST" }, { user: "UOTHER" },
    { user_team: "TOTHER" }, { hidden: true }, { text: "x".repeat(4001) }, { text: "  " },
    { ts: "bad" }, { thread_ts: "bad" },
  ])("rejects unsupported or untrusted event %j", (patch) => {
    expect(parseMessage(envelope(patch), config)).toBeNull();
  });
  it("rejects a different workspace or envelope kind", () => {
    expect(parseMessage({ ...envelope(), team_id: "TOTHER" }, config)).toBeNull();
    expect(parseMessage({ ...envelope(), type: "url_verification" }, config)).toBeNull();
    expect(parseMessage({ ...envelope(), event_id: "invalid" }, config)).toBeNull();
  });
});
