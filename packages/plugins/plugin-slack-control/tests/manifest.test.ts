import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { namespace } from "./helpers.js";

describe("installable manifest contracts", () => {
  it("keeps Slack offline until configured, with IM-only events and minimal scopes", async () => {
    const slack = JSON.parse(await readFile(new URL("../slack-app-manifest.json", import.meta.url), "utf8"));
    expect(slack.display_information.name.length).toBeLessThanOrEqual(35);
    expect(slack.settings.socket_mode_enabled).toBe(true);
    expect(slack.settings.event_subscriptions).toEqual({ bot_events: ["message.im"] });
    expect(slack.oauth_config.scopes.bot).toEqual(["chat:write", "im:history", "im:read"]);
    expect(slack.features.app_home.messages_tab_read_only_enabled).toBe(false);
    expect(JSON.stringify(slack)).not.toMatch(/xapp-|xoxb-|https:\/\/|hireable|joe@|support@/i);
  });
  it("uses a company-scoped board-only diagnostics route and the derived SQL namespace", async () => {
    expect(manifest.apiRoutes?.[0]).toMatchObject({ auth: "board", method: "GET", companyResolution: { from: "query", key: "companyId" } });
    const derived = `plugin_slack_control_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;
    expect(derived).toBe(namespace);
    expect(manifest.database?.coreReadTables).toEqual(["companies"]);
    const migration = await readFile(new URL("../migrations/001_inbox.sql", import.meta.url), "utf8");
    expect(migration).toContain(`CREATE TABLE ${derived}.inbox`);
    expect(migration).toContain("PRIMARY KEY (company_id, event_key)");
    expect(migration).toContain("PRIMARY KEY (company_id, workspace_id, channel_id, thread_ts)");
  });
});
