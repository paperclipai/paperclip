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
const tailRuntimeActions = [...formatterSource
  .match(/const TAIL_RUNTIME_ACTIVITY_ACTIONS = new Set<string>\(\[([\s\S]*?)\n\]\);/)![1]
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
  it("covers the exact new runtime action identities in both catalogs", () => {
    const keys = tailRuntimeActions.map(eventKey);
    expect(tailRuntimeActions).toHaveLength(18);
    expect(new Set(tailRuntimeActions).size).toBe(tailRuntimeActions.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(en.sep28TailRuntime.activity).sort()).toEqual([...keys].sort());
    expect(Object.keys(ru.sep28TailRuntime.activity).sort()).toEqual([...keys].sort());
  });

  it.each(tailRuntimeActions)("projects %s RU → EN → RU without changing raw payloads or near-match actions", async (action) => {
    const details = Object.freeze({
      provider: "OpenAI", title: "RAW user title", action: "Keep_raw.action", reason: "User-provided English reason",
      receipt: Object.freeze({ operation: "RawOperation", stateRevision: 3 }),
    });
    const event = Object.freeze({ action, details });
    const original = JSON.stringify(event);
    const key = eventKey(action);
    for (const locale of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(locale);
      const catalog: Record<string, string> = locale === "ru" ? ru.sep28TailRuntime.activity : en.sep28TailRuntime.activity;
      const expected = catalog[key];
      expect(expected).toBeTruthy();
      if (locale === "en") expect(expected).toBe(action.replace(/[._]/g, " "));
      else expect(expected).toMatch(/[А-Яа-яЁё]/);
      for (const format of [formatActivityVerb, formatIssueActivityAction]) {
        expect(format(action, details)).toBe(expected);
        for (const unknown of [action.replace(/\./g, "_"), `${action}.custom`, `custom.${action}`]) {
          expect(format(unknown, details)).toBe(unknown.replace(/[._]/g, " "));
        }
      }
      expect(JSON.stringify(event)).toBe(original);
    }
  });

  it("keeps English activity status casing while projecting settled conversations in RU → EN → RU", async () => {
    const settled = Object.freeze({ status: "in_review", externalConversationState: "waiting" });
    const review = Object.freeze({ status: "in_review" });
    const raw = Object.freeze({ status: "User_RAW_Status", priority: "User_RAW_Priority" });
    const original = JSON.stringify([settled, review, raw]);
    for (const locale of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(locale);
      const idle = locale === "en" ? "idle" : t("status.idle");
      const inReview = locale === "en" ? "in review" : t("status.in_review");
      expect(formatActivityVerb("issue.updated", settled)).toBe(t("localizationActivity.changed_status_Verb", { to: idle }));
      expect(formatIssueActivityAction("issue.updated", settled)).toBe(t("localizationActivity.changed_status_Action", { to: idle }));
      expect(formatActivityVerb("issue.updated", review)).toBe(t("localizationActivity.changed_status_Verb", { to: inReview }));
      expect(formatActivityVerb("issue.updated", raw)).toContain("User RAW Status");
      expect(JSON.stringify([settled, review, raw])).toBe(original);
    }
  });

  it("localizes announcement dismissal by its exact first-party action without changing event details", async () => {
    const details = Object.freeze({ title: "Keep this English announcement title", announcementId: "announcement.release.v1" });
    const original = JSON.stringify(details);
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      for (const format of [formatActivityVerb, formatIssueActivityAction]) {
        expect(format("announcement.dismissed", details)).toBe(locale === "ru" ? "объявление скрыто" : "announcement dismissed");
        expect(format("announcement_dismissed", details)).toBe("announcement dismissed");
        expect(format("announcement.dismissed.custom", details)).toBe("announcement dismissed custom");
      }
      expect(JSON.stringify(details)).toBe(original);
    }
  });

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
    expect(formatActivityVerb("issue.read_marked")).toBe("отметка «Прочитано»");
    expect(formatIssueActivityAction("issue.read_unmarked")).toBe("задача отмечена как непрочитанная");
  });

  it("describes interruption of the current run to send queued comments, not interruption of the queue", async () => {
    await i18n.changeLanguage("ru");
    expect(formatActivityVerb("issue.queued_comments_interrupted"))
      .toBe("текущий запуск прерван для отправки комментариев из очереди");
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
    const key = "email_received";
    const bundles = ["en", "ru"].map((locale) => ({
      locale,
      events: i18n.getResource(locale, "translation", "localizationActivityEvents") as Record<string, string>,
    }));
    const saved = bundles.map(({ events }) => events[key]);
    try {
      for (const { events } of bundles) delete events[key];
      for (const locale of ["en", "ru"]) {
        await i18n.changeLanguage(locale);
        expect(formatActivityVerb("email.received")).toBe("email received");
        expect(formatIssueActivityAction("email.received")).toBe("email received");
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
  const known = new Set([...fallbackActions, ...tailRuntimeActions, ...rowActions.keys(), ...detailActions.keys()]);

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
      ...["connected", "pause", "resume", "remove"].map((type) => `email_endpoint.${type}`),
      ...["received", "queued", "sent", "resolved"].map((type) => `email.${type}`),
      "workspace_login_handoff_issued",
    ];
    expect(generated.filter((action) => !known.has(action))).toEqual([]);
  });
});
