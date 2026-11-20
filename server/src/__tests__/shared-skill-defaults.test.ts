import { describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../middleware/logger.js", () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: vi.fn() }));
import { readPaperclipSkillSyncPreference, writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import type { Db } from "@paperclipai/db";
import {
  SHARED_SKILL_DEFAULTS,
  resolveSharedSkillDefaultKeys,
  sharedSkillDefaultKeys,
} from "../services/shared-skill-defaults.js";

const db = {} as Db;
const input = { companyId: "company-1", agentId: "agent-1" };
const ALL_VOICE_TOOLS = [
  "voice_get_style_guide", "voice_save_style_guide", "voice_add_source_doc",
  "voice_get_humanizer_checklist", "voice_list_voices", "voice_add_humanizer_entry",
];
const ALL_KEYS = [
  "shared/personal-voice-add", "shared/personal-voice-apply", "shared/personal-voice-list",
  "shared/personal-voice-show", "shared/personal-voice-flag-slop",
];

describe("sharedSkillDefaultKeys", () => {
  it("enables exactly the five voice skills for an agent with the voice tools", () => {
    expect(sharedSkillDefaultKeys([...ALL_VOICE_TOOLS, "unrelated_tool"]).sort()).toEqual([...ALL_KEYS].sort());
  });

  it("enables nothing for an agent without them", () => {
    expect(sharedSkillDefaultKeys([])).toEqual([]);
    expect(sharedSkillDefaultKeys(["slack_post", "linear_get_issue"])).toEqual([]);
  });

  it("enables only the skills whose required tools are all present", () => {
    expect(sharedSkillDefaultKeys(["voice_get_style_guide"])).toEqual(["shared/personal-voice-show"]);
    // add needs the guide, the save and the archive tools together.
    expect(sharedSkillDefaultKeys(["voice_get_style_guide", "voice_save_style_guide"])).toEqual(["shared/personal-voice-show"]);
  });

  it("matches a tool that carries a server prefix, but not a lookalike name", () => {
    expect(sharedSkillDefaultKeys(["rh-mcp_voice_list_voices"])).toEqual(["shared/personal-voice-list"]);
    expect(sharedSkillDefaultKeys(["my_voice_list_voices_v2", "xvoice_list_voices"])).toEqual([]);
  });

  it("switches on nothing outside the table", () => {
    const slugs = SHARED_SKILL_DEFAULTS.map((entry) => entry.slug).sort();
    expect(slugs).toEqual(ALL_KEYS.map((key) => key.replace("shared/", "")).sort());
    expect(sharedSkillDefaultKeys(["any_tool"], [{ slug: "no-tools-needed", requiredTools: [] }])).toEqual(["shared/no-tools-needed"]);
  });
});

describe("resolveSharedSkillDefaultKeys", () => {
  it("returns the keys when configured and the agent has the tools", async () => {
    const allowedToolNames = vi.fn(async () => ALL_VOICE_TOOLS);
    const keys = await resolveSharedSkillDefaultKeys(db, input, { isConfigured: () => true, allowedToolNames });
    expect([...keys].sort()).toEqual([...ALL_KEYS].sort());
    expect(allowedToolNames).toHaveBeenCalledWith("company-1", "agent-1");
  });

  it("does nothing, and skips the tool lookup, when shared skills are not configured", async () => {
    const allowedToolNames = vi.fn(async () => ALL_VOICE_TOOLS);
    expect(await resolveSharedSkillDefaultKeys(db, input, { isConfigured: () => false, allowedToolNames })).toEqual([]);
    expect(allowedToolNames).not.toHaveBeenCalled();
  });

  it("adds nothing and does not throw when the lookup fails", async () => {
    warn.mockClear();
    const allowedToolNames = vi.fn(async () => { throw new Error("database unavailable: secret-detail"); });
    await expect(resolveSharedSkillDefaultKeys(db, input, { isConfigured: () => true, allowedToolNames })).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-detail");
  });
});

describe("the run overlay", () => {
  // The run merges these keys with writePaperclipSkillSyncPreference on a copy of the run configuration.
  it("builds the run's desired set without touching the saved preference", () => {
    const saved = Object.freeze({ paperclipSkillSync: Object.freeze({ explicit: true, desiredSkills: ["company/team/own-skill"] }) });
    const before = JSON.stringify(saved);
    const existing = readPaperclipSkillSyncPreference(saved).desiredSkillEntries;
    const run = writePaperclipSkillSyncPreference(saved, [...existing, "shared/personal-voice-show", "company/team/own-skill"]);
    expect(JSON.stringify(saved)).toBe(before);
    expect(readPaperclipSkillSyncPreference(run).desiredSkills.sort())
      .toEqual(["company/team/own-skill", "shared/personal-voice-show"]);
  });
});
