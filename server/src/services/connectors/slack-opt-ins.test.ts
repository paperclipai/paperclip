import { describe, expect, it } from "vitest";
import {
  SLACK_DEFAULT_BOT_SCOPES,
  SLACK_OPT_IN_SCOPE_GROUPS,
  SLACK_TOOLS,
  slackBotScopes,
  slackOptInGroupsFromScopes,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import {
  assertSlackToolEnabledForSetup,
  slackEnabledOptInGroups,
  isSlackLegacyInstall,
  isSlackToolEnabledForSetup,
  sameSlackOptInGroups,
  slackEnabledToolsForSetup,
  slackEndpointOptInsChanged,
  slackVerificationOptInScopes,
} from "./slack-opt-ins.js";

function names(groups: SlackOptInScopeGroup[]): string[] {
  // Gating reads the installed set only; a request alone installs nothing.
  return slackEnabledToolsForSetup({
    slackOptInScopeGroups: groups,
    slackInstalledOptInScopeGroups: groups,
  })
    .map((tool) => String(tool.name))
    .sort();
}

describe("Slack tool opt-in gating", () => {
  it("offers every tool except the three gated ones by default", () => {
    const enabled = new Set(names([]));
    for (const name of ["slack_create_channel", "slack_invite", "slack_upload_file"]) {
      expect(enabled.has(name)).toBe(false);
    }
    expect(enabled.has("slack_open_dm")).toBe(true);
    for (const name of ["slack_history", "slack_thread", "slack_post_message", "slack_reactions", "slack_pins", "slack_canvases"]) {
      if (SLACK_TOOLS.some((tool) => tool.name === name)) expect(enabled.has(name)).toBe(true);
    }
    // Only the gated tools are excluded from the full catalog.
    expect(enabled.size).toBe(SLACK_TOOLS.length - 3);
  });

  it("adds exactly the tools each group unlocks, and keeps search enabled", () => {
    expect(names(["channel_management"])).toEqual(
      names([]).concat(["slack_create_channel", "slack_invite"]).sort(),
    );
    expect(names(["file_upload"])).toEqual(names([]).concat("slack_upload_file").sort());
    // search:read.* comes from the personal-search OAuth flow, never the manifest.
    expect(isSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: [] }, { name: "slack_search", scopes: ["search:read.public", "search:read.files"] })).toBe(true);
  });

  it("treats each alternative in an `a|b` requirement as sufficient", () => {
    const channelTools = SLACK_TOOLS.filter((tool) => ["slack_create_channel", "slack_invite"].includes(tool.name));
    for (const tool of channelTools) {
      expect(isSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: [] }, tool)).toBe(false);
      expect(isSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: ["channel_management"] }, tool)).toBe(true);
    }
  });

  it("disables a group the operator removed even when Slack kept its grant", () => {
    // Requested: nothing. Installed: channel management. Slack may keep the
    // scope on the existing installation, but the operator asked for it off.
    expect(isSlackToolEnabledForSetup({
      slackOptInScopeGroups: [],
      slackInstalledOptInScopeGroups: ["channel_management"],
    }, { name: "slack_create_channel", scopes: ["channels:manage|groups:write"] })).toBe(false);
    expect(slackEnabledOptInGroups({
      slackOptInScopeGroups: [],
      slackInstalledOptInScopeGroups: ["channel_management"],
    })).toEqual([]);
  });

  it("does not offer a tool Slack has not granted yet", () => {
    // Requested: file upload. Installed: nothing. Slack has no files:write.
    expect(isSlackToolEnabledForSetup({
      slackOptInScopeGroups: ["file_upload"],
      slackInstalledOptInScopeGroups: [],
    }, { name: "slack_upload_file", scopes: ["files:write"] })).toBe(false);
  });

  it("rejects a non-enabled tool with a clear error naming the group", () => {
    expect(() => assertSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: [] }, "slack_upload_file"))
      .toThrow("slack_upload_file is not enabled for this agent");
    expect(() => assertSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: [] }, "slack_upload_file"))
      .toThrow("File upload");
  });

  it("allows an installed tool through the guard", () => {
    expect(() => assertSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: ["file_upload"] }, "slack_upload_file")).not.toThrow();
  });

  it("rejects an unknown tool name as a client error, not an authorization one", () => {
    expect(() => assertSlackToolEnabledForSetup(undefined, "not_a_slack_tool"))
      .toThrow("Unknown Slack tool: not_a_slack_tool");
    // A 403 would tell the caller to seek access it can never be granted.
    expect(() => assertSlackToolEnabledForSetup(undefined, "not_a_slack_tool"))
      .toThrow(expect.objectContaining({ status: 400, details: { code: "unknown_slack_tool" } }));
  });

  it("defaults a new endpoint with no fields to no opt-in groups", () => {
    // S1: nothing requested, nothing installed, no prior install.
    expect(names([])).toEqual(slackEnabledToolsForSetup({ slackInstalledOptInScopeGroups: [] }).map(tool => String(tool.name)).sort());
    expect(slackEnabledToolsForSetup({}).map(tool => String(tool.name))).not.toContain("slack_upload_file");
    expect(slackEnabledToolsForSetup({}).map(tool => String(tool.name))).not.toContain("slack_create_channel");
  });

  it("keeps a requested-but-not-installed group gated", () => {
    const setup = { slackOptInScopeGroups: ["file_upload" as const], slackInstalledOptInScopeGroups: [] };
    expect(slackEnabledToolsForSetup(setup).map(tool => String(tool.name))).not.toContain("slack_upload_file");
    expect(() => assertSlackToolEnabledForSetup(setup, "slack_upload_file")).toThrow("not enabled for this agent");
  });

  it("keeps the legacy full grant only for a prior install", () => {
    // S3: gating, capabilities and the tool list share one resolution.
    const legacy = slackEnabledToolsForSetup({}, { legacyInstall: true }).map(tool => String(tool.name));
    expect(legacy).toContain("slack_upload_file");
    expect(legacy).toContain("slack_create_channel");
    expect(slackEnabledToolsForSetup({}).map(tool => String(tool.name))).not.toContain("slack_upload_file");
  });

  it("matches the request helper's scope set", () => {
    expect(slackBotScopes(["channel_management", "file_upload"])).toEqual(
      expect.arrayContaining(["channels:manage", "groups:write", "files:write"]),
    );
  });
});

describe("Slack installed groups derived from the token's grant", () => {
  it("counts a group only when every one of its scopes was granted", () => {
    // channels:manage + groups:write are both needed.
    expect(slackOptInGroupsFromScopes(["channels:manage"])).toEqual([]);
    expect(slackOptInGroupsFromScopes(["channels:manage", "groups:write"])).toEqual(["channel_management"]);
    expect(slackOptInGroupsFromScopes(["files:write"])).toEqual(["file_upload"]);
    expect(slackOptInGroupsFromScopes([])).toEqual([]);
  });

  it("leaves a partially granted group's tools gated", () => {
    // Slack granted only part of channel management, so the marker omits it.
    const installed = slackOptInGroupsFromScopes([...SLACK_DEFAULT_BOT_SCOPES, "channels:manage"]);
    expect(installed).not.toContain("channel_management");
    const setup = { slackOptInScopeGroups: ["channel_management" as const], slackInstalledOptInScopeGroups: installed };
    expect(isSlackToolEnabledForSetup(setup, { name: "slack_create_channel", scopes: ["channels:manage|groups:write"] })).toBe(false);
    expect(() => assertSlackToolEnabledForSetup(setup, "slack_create_channel")).toThrow("not enabled for this agent");
  });
});

describe("Slack opt-in change detection", () => {
  it("never reports an untouched legacy install as changed", () => {
    // Neither field: the implied request is the full grant it already holds.
    expect(slackEndpointOptInsChanged({}, { legacyInstall: true })).toBe(false);
    expect(slackEndpointOptInsChanged(undefined, { legacyInstall: true })).toBe(false);
  });

  it("reports a genuine add", () => {
    expect(slackEndpointOptInsChanged({ slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: [] })).toBe(true);
  });

  it("reports a genuine remove", () => {
    expect(slackEndpointOptInsChanged({ slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: ["file_upload"] })).toBe(true);
    // A legacy install's first trim: the edit snapshots the implied full grant
    // as installed before writing the request, so the trim is pending.
    expect(slackEndpointOptInsChanged({
      slackOptInScopeGroups: [],
      slackInstalledOptInScopeGroups: ["channel_management", "file_upload"],
    })).toBe(true);
  });

  it("does not count duplicate or reordered entries as a change", () => {
    expect(slackEndpointOptInsChanged({
      slackOptInScopeGroups: ["file_upload", "channel_management", "file_upload"],
      slackInstalledOptInScopeGroups: ["channel_management", "file_upload"],
    })).toBe(false);
    expect(sameSlackOptInGroups(["file_upload", "file_upload"], ["file_upload"])).toBe(true);
    expect(sameSlackOptInGroups(["file_upload", "file_upload"], ["file_upload", "channel_management"])).toBe(false);
  });
});

describe("Slack token scope verification set", () => {
  it("checks a replacement token against the request, so a group can be removed", () => {
    const removing = { slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: ["file_upload" as const] };
    expect(slackVerificationOptInScopes(removing, "replacement")).toEqual([]);
    expect(slackVerificationOptInScopes(removing, "installed")).toEqual(["files:write"]);
  });

  it("checks a stored token against the recorded install, not a pending request", () => {
    const adding = { slackOptInScopeGroups: ["file_upload" as const], slackInstalledOptInScopeGroups: [] };
    expect(slackVerificationOptInScopes(adding, "installed")).toEqual([]);
    expect(slackVerificationOptInScopes(adding, "replacement")).toEqual(["files:write"]);
  });

  it("requires only the chat floor for a legacy install", () => {
    // The implied legacy grant is never required, for either kind of token.
    expect(slackVerificationOptInScopes({}, "installed")).toEqual([]);
    expect(slackVerificationOptInScopes({}, "replacement")).toEqual([]);
  });
});

describe("Slack legacy install definition", () => {
  it("is a connected bot on a row with neither opt-in field, for any setup method", () => {
    expect(isSlackLegacyInstall({ botExternalId: "UBOT", setup: {} })).toBe(true);
    expect(isSlackLegacyInstall({ botExternalId: "UBOT", setup: null })).toBe(true);
  });

  it("excludes a row that never connected a bot", () => {
    expect(isSlackLegacyInstall({ botExternalId: null, setup: {} })).toBe(false);
  });

  it("excludes a row with either opt-in field recorded", () => {
    expect(isSlackLegacyInstall({ botExternalId: "UBOT", setup: { slackOptInScopeGroups: [] } })).toBe(false);
    expect(isSlackLegacyInstall({ botExternalId: "UBOT", setup: { slackInstalledOptInScopeGroups: [] } })).toBe(false);
  });
});

/**
 * TECH-7988: gating is requested AND installed. Listing and dispatch both read
 * `slackEnabledOptInGroups`, so a tool can never be listed but rejected, nor
 * dispatchable while hidden.
 */
describe("Slack tool gating: requested and installed", () => {
  const channel = { name: "slack_create_channel", scopes: ["channels:manage|groups:write"] };
  const upload = { name: "slack_upload_file", scopes: ["files:write"] };
  const readTool = { name: "slack_history", scopes: ["channels:history"] };

  it("enables a group that is both requested and installed", () => {
    const setup = { slackOptInScopeGroups: ["channel_management" as const], slackInstalledOptInScopeGroups: ["channel_management" as const] };
    expect(slackEnabledOptInGroups(setup)).toEqual(["channel_management"]);
    expect(isSlackToolEnabledForSetup(setup, channel)).toBe(true);
    expect(() => assertSlackToolEnabledForSetup(setup, "slack_create_channel")).not.toThrow();
  });

  it("disables an ungated-by-default tool group that was never requested", () => {
    const setup = { slackOptInScopeGroups: [] as const, slackInstalledOptInScopeGroups: [] as const };
    expect(isSlackToolEnabledForSetup(setup, upload)).toBe(false);
    expect(() => assertSlackToolEnabledForSetup(setup, "slack_upload_file")).toThrow("not enabled for this agent");
  });

  it("disables requested-but-not-granted: Slack has no scope yet", () => {
    const setup = { slackOptInScopeGroups: ["file_upload" as const], slackInstalledOptInScopeGroups: [] as const };
    expect(slackEnabledOptInGroups(setup)).toEqual([]);
    expect(isSlackToolEnabledForSetup(setup, upload)).toBe(false);
  });

  it("disables granted-but-not-requested: the operator removed the group", () => {
    const setup = { slackOptInScopeGroups: [] as const, slackInstalledOptInScopeGroups: ["file_upload" as const] };
    expect(slackEnabledOptInGroups(setup)).toEqual([]);
    expect(isSlackToolEnabledForSetup(setup, upload)).toBe(false);
    expect(() => assertSlackToolEnabledForSetup(setup, "slack_upload_file")).toThrow("not enabled for this agent");
  });

  it("keeps ungated tools available regardless of opt-ins", () => {
    for (const setup of [
      { slackOptInScopeGroups: [] as const, slackInstalledOptInScopeGroups: [] as const },
      { slackOptInScopeGroups: ["file_upload" as const], slackInstalledOptInScopeGroups: [] as const },
    ]) {
      expect(isSlackToolEnabledForSetup(setup, readTool)).toBe(true);
    }
  });

  it("uses the implied full grant as the request only for a legacy install", () => {
    // Legacy: no request recorded, so the implied grant is also the request.
    const legacy = slackEnabledOptInGroups({},);
    expect(legacy).toEqual([]);
    expect(slackEnabledOptInGroups({}, { legacyInstall: true })).toEqual(SLACK_OPT_IN_SCOPE_GROUPS);
    // Once a request exists, it is authoritative and caps the legacy grant.
    expect(slackEnabledOptInGroups({ slackOptInScopeGroups: [] }, { legacyInstall: true })).toEqual([]);
    expect(slackEnabledOptInGroups({ slackOptInScopeGroups: ["file_upload"] }, { legacyInstall: true })).toEqual([]);
  });

  it("gates a manual app by its requested and granted groups the same way", () => {
    // A manual app has no registration row; only setup fields decide.
    const manualWithUpload = { slackOptInScopeGroups: ["file_upload" as const], slackInstalledOptInScopeGroups: ["file_upload" as const] };
    const manualMissingGrant = { slackOptInScopeGroups: ["file_upload" as const], slackInstalledOptInScopeGroups: [] as const };
    expect(isSlackToolEnabledForSetup(manualWithUpload, upload)).toBe(true);
    expect(isSlackToolEnabledForSetup(manualMissingGrant, upload)).toBe(false);
  });

  it("keeps listing and dispatch in agreement for every group combination", () => {
    const groups = ["channel_management", "file_upload"] as const;
    const subsets = (items: readonly (typeof groups)[number][]) =>
      items.reduce<(typeof groups)[number][][]>((acc, group) => [...acc, ...acc.map(set => [...set, group])], [[]]);
    for (const requested of subsets(groups)) {
      for (const installed of subsets(groups)) {
        const setup = { slackOptInScopeGroups: requested, slackInstalledOptInScopeGroups: installed };
        const listed = new Set(slackEnabledToolsForSetup(setup).map(tool => String(tool.name)));
        for (const tool of SLACK_TOOLS) {
          // The guard every dispatch path calls must match the listing exactly.
          const dispatchable = (() => {
            try { assertSlackToolEnabledForSetup(setup, tool.name); return true; } catch { return false; }
          })();
          expect(dispatchable).toBe(listed.has(tool.name));
          expect(dispatchable).toBe(isSlackToolEnabledForSetup(setup, tool));
        }
      }
    }
  });
});

describe("Legacy proactive_dms opt-in row compatibility (TECH-8783)", () => {
  it("handles legacy row with proactive_dms in both fields without throwing", () => {
    const setup = {
      slackOptInScopeGroups: ["proactive_dms" as never],
      slackInstalledOptInScopeGroups: ["proactive_dms" as never],
    };
    expect(() => slackEnabledToolsForSetup(setup)).not.toThrow();
    const tools = slackEnabledToolsForSetup(setup).map((t) => t.name);
    expect(tools).toContain("slack_open_dm");
  });

  it("never reports an untouched legacy install with proactive_dms as changed", () => {
    expect(
      slackEndpointOptInsChanged(
        {
          slackOptInScopeGroups: ["proactive_dms" as never],
          slackInstalledOptInScopeGroups: ["proactive_dms" as never],
        },
        { legacyInstall: true },
      ),
    ).toBe(false);
  });

  it("returns empty verification opt-in scopes for legacy installed proactive_dms", () => {
    expect(
      slackVerificationOptInScopes(
        {
          slackInstalledOptInScopeGroups: ["proactive_dms" as never],
        },
        "installed",
      ),
    ).toEqual([]);
  });
});
