import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  TOOL_ACCESS_ACTIVITY_ACTIONS,
  TOOL_AUDIT_EVENT_TYPES,
  TOOL_CONNECTION_LIFECYCLE_EVENT_TYPES,
} from "@paperclipai/shared";
import { i18n, t } from "@/i18n";
import en from "@/i18n/locales/en.json";
import ru from "@/i18n/locales/ru.json";
import { formatActivityVerb, formatIssueActivityAction } from "./activity-format";

const formatterSource = readFileSync(new URL("./activity-format.ts", import.meta.url), "utf8");
const fallbackActions = [...formatterSource
  .match(/const LOCALIZED_FALLBACK_ACTIVITY_ACTIONS = new Set<string>\(\[([\s\S]*?)\n\]\);/)![1]
  .matchAll(/"([a-z_.]+)"/g)].map((match) => match[1]);

function readActionTable(name: string): Map<string, string> {
  const body = formatterSource.match(new RegExp(`const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`))![1];
  return new Map([...body.matchAll(/"([a-z_.]+)": "([^"]+)"/g)].map((match) => [match[1], match[2]]));
}

const rowActions = readActionTable("ACTIVITY_ROW_VERBS");
const detailActions = readActionTable("ISSUE_ACTIVITY_LABELS");
const structuredActions = new Set(["issue.blockers_updated", "issue.reviewers_updated", "issue.approvers_updated"]);
const gatewayRowActions = new Set([
  "tool_gateway.call_completed", "tool_gateway.call_allowed", "tool_gateway.call_denied",
  "tool_gateway.approval_requested", "tool_gateway.session_created", "tool_gateway.session_rejected",
  "tool_gateway.discovery",
]);
const enEvents: Record<string, string> = en.localizationActivityEvents;
const ruEvents: Record<string, string> = ru.localizationActivityEvents;
const eventKey = (action: string) => action.replace(/\./g, "_");

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("activity event fallback localization", () => {
  it("keeps exact action identities and collision-free catalog keys in parity", () => {
    const keys = fallbackActions.map(eventKey);
    expect(new Set(fallbackActions).size).toBe(fallbackActions.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(enEvents).sort()).toEqual([...keys].sort());
    expect(Object.keys(ruEvents).sort()).toEqual([...keys].sort());
    for (const action of fallbackActions) {
      expect(enEvents[eventKey(action)]).toBe(action.replace(/[._]/g, " "));
      expect(ruEvents[eventKey(action)], action).toMatch(/[А-Яа-яЁё]/);
    }
  });

  it.each(fallbackActions)("switches %s EN → RU → EN without changing event details", async (action) => {
    const details = Object.freeze({ provider: "OpenAI", title: "RAW user title", correlationId: "raw_id.key" });
    const originalDetails = JSON.stringify(details);
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      const catalog = locale === "ru" ? ruEvents : enEvents;
      for (const [format, table, isRow] of [
        [formatActivityVerb, rowActions, true],
        [formatIssueActivityAction, detailActions, false],
      ] as const) {
        // These pre-existing handlers express actor/participant context and retain precedence.
        if (structuredActions.has(action) || (isRow && gatewayRowActions.has(action))) continue;
        const mappedKey = table.get(action);
        expect(format(action, details), `${locale} ${isRow ? "row" : "detail"} ${action}`)
          .toBe(mappedKey ? t(mappedKey) : catalog[eventKey(action)]);
      }
    }
    expect(JSON.stringify(details)).toBe(originalDetails);
  });

  it("renders the dashboard read receipt naturally in Russian", async () => {
    await i18n.changeLanguage("ru");
    expect(formatActivityVerb("issue.read_marked")).toBe("задача отмечена как прочитанная");
    expect(formatIssueActivityAction("issue.read_unmarked")).toBe("задача отмечена как непрочитанная");
  });

  it.each(["future_plugin.custom_event", "issue_read.marked", "issue.read.marked", "Custom user event", "OpenAI.custom_event", "issue.monitor_future_event"])(
    "retains the existing unknown-action fallback for %s", async (action) => {
      for (const locale of ["en", "ru"]) {
        await i18n.changeLanguage(locale);
        expect(formatActivityVerb(action)).toBe(action.replace(/[._]/g, " "));
        expect(formatIssueActivityAction(action)).toBe(action.replace(/[._]/g, " "));
      }
    },
  );

  it("preserves the service name on an unknown monitor event", async () => {
    await i18n.changeLanguage("ru");
    expect(formatIssueActivityAction("issue.monitor_future_event", { serviceName: "UserService.v2" }))
      .toBe(t("localizationActivity.monitorService", { action: "issue monitor future event", service: "UserService.v2" }));
  });

  it("uses the original readable fallback when both catalogs lack a known event", async () => {
    const key = "issue_read_marked";
    const bundles = ["en", "ru"].map((locale) => ({
      locale,
      events: i18n.getResource(locale, "translation", "localizationActivityEvents") as Record<string, string>,
    }));
    const saved = bundles.map(({ events }) => events[key]);
    try {
      for (const { events } of bundles) delete events[key];
      for (const locale of ["en", "ru"]) {
        await i18n.changeLanguage(locale);
        expect(formatActivityVerb("issue.read_marked")).toBe("issue read marked");
        expect(formatIssueActivityAction("issue.read_marked")).toBe("issue read marked");
      }
    } finally {
      bundles.forEach(({ events }, index) => { events[key] = saved[index]; });
    }
  });

  it("keeps mapped and detail-aware actions ahead of fallback labels", async () => {
    for (const locale of ["en", "ru"]) {
      await i18n.changeLanguage(locale);
      expect(formatActivityVerb("issue.created")).toBe(t("localizationActivity.activity_row_verbs_issue_created"));
      expect(formatIssueActivityAction("issue.created")).toBe(t("localizationActivity.issue_activity_labels_issue_created"));
      expect(formatActivityVerb("tool_gateway.call_completed", { tool: "OpenAI", source: "test" }))
        .toBe(t("localizationActivity.toolCompleted_test", { tool: "OpenAI" }));
      expect(formatIssueActivityAction("issue.blockers_updated", {
        addedBlockedByIssues: [{ identifier: "RAW-22" }], removedBlockedByIssues: [],
      })).toBe(t("localizationActivity.change_added_blockerSingle", { label: "RAW-22" }));
      expect(formatActivityVerb("issue.thread_interaction_accepted", { interactionKind: "suggest_tasks" }))
        .toBe(t("localizationActivity.reviewOnEntity", { label: t("localizationActivity.interaction_accepted_labels_suggest_tasks") }));
    }
  });
});

// Read-only guard for the server's own literal/conditional event codes. It does
// not scan user data or translate arbitrary plugin action strings. Finite codes
// formed with templates are checked against their shared contracts below.
function literalActionCandidates(source: string): string[] {
  return [...source.matchAll(/\baction:\s*([^,]*),/g)].flatMap((expression) =>
    [...expression[1].matchAll(/"([a-z_]+\.[a-z_.]+)"/g)].map((match) => match[1]),
  );
}

describe("activity event coverage", () => {
  const known = new Set([...fallbackActions, ...rowActions.keys(), ...detailActions.keys()]);

  it("requires labels when a new static or conditional server action is added", () => {
    const root = fileURLToPath(new URL("../../../server/src/", import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((entry) =>
      entry.endsWith(".ts") && !entry.includes("__tests__") && !/\.(test|spec)\.ts$/.test(entry),
    );
    const missing = new Set<string>();
    let checked = 0;
    for (const file of files) {
      for (const action of literalActionCandidates(readFileSync(`${root}/${file}`, "utf8"))) {
        checked += 1;
        if (!known.has(action)) missing.add(`${file}: ${action}`);
      }
    }
    expect(checked).toBeGreaterThan(400);
    expect([...missing].sort()).toEqual([]);
  });

  it("recognizes a future action in both branches of a conditional", () => {
    expect(literalActionCandidates('action: refreshed ? "plugin.future_refreshed" : "plugin.future_created", entityId: id,'))
      .toEqual(["plugin.future_refreshed", "plugin.future_created"]);
    expect(known.has("plugin.future_refreshed")).toBe(false);
  });

  it("covers finite generated action families and published tool activity codes", () => {
    const generated = [
      ...TOOL_ACCESS_ACTIVITY_ACTIONS,
      ...TOOL_AUDIT_EVENT_TYPES.map((type) => `tool_access.${type}`),
      ...TOOL_CONNECTION_LIFECYCLE_EVENT_TYPES.map((type) => `tool_connection.${type}`),
      ...["joined", "left", "starred", "unstarred"].map((type) => `resource_membership.${type}`),
      ...["executed", "failed", "skipped"].map((type) => `decision.effect_${type}`),
      ...["approved", "rejected", "withdrawn", "expired"].map((type) => `secret.proposal.${type}`),
      ...["start", "stop", "restart", "run"].map((type) => `project.workspace_runtime_${type}`),
      ...["start", "stop", "restart", "run", "repair"].map((type) => `execution_workspace.runtime_${type}`),
      "workspace_login_handoff_issued",
    ];
    expect(generated.filter((action) => !known.has(action))).toEqual([]);
  });
});
