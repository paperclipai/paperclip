import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { createInstance } from "i18next";
import { afterEach, describe, expect, it } from "vitest";
import { ISSUE_DISPLAY_STATUSES, ISSUE_PRIORITIES, ISSUE_WORK_MODES, statusCardUpdateStatusSchema, statusCardUpdateTriggerSchema } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { formatIssueChangeValue } from "@/lib/issue-change-receipt";
import { buildFilterChips } from "@/lib/search-filters";
import { assignedLabel } from "@/pages/tools/profiles/profile-summary";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const locales = ["en", "zh-CN"] as const;
afterEach(async () => { await i18n.changeLanguage("en"); });

// Check each locale's own resource, never English fallback or defaultValue.
// Derive the domain from shared enums, so a future status/work-mode addition
// fails this gate until its catalog entry exists.
function missingKeys(keys: string[], locale: string, instance = i18n, count?: number) {
  return keys.filter(key => !instance.exists(key, { lng: locale, fallbackLng: false, count }));
}
const displayDomains = {
  activity: [...new Set([...ISSUE_DISPLAY_STATUSES, ...ISSUE_PRIORITIES, ...ISSUE_WORK_MODES, "idle"])].map(value => `display:activity_value_${value}`),
  search: [...new Set([...ISSUE_DISPLAY_STATUSES, ...ISSUE_PRIORITIES, "idle"])].map(value => `display:search_value_${value}`),
};

// Inspect the real dynamic call arguments, including both conditional arms and
// all lookup-map values. New finite map entries cannot silently escape the gate.
type AstNode = { type: string; value?: unknown; name?: string; id?: AstNode; init?: AstNode; callee?: AstNode; arguments?: AstNode[]; properties?: Array<{ value?: { type: string; value?: unknown } }> };
function* nodes(value: unknown): Generator<AstNode> {
  if (!value || typeof value !== "object") return;
  if ("type" in value && typeof value.type === "string") yield value as AstNode;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) for (const entry of child) yield* nodes(entry);
    else if (child && typeof child === "object") yield* nodes(child);
  }
}
function dynamicLiteralKeys(path: string, callee: string) {
  const ast = parseSync(path, source(path), { sourceType: "module" });
  expect(ast.errors).toEqual([]);
  const keys = new Set<string>();
  for (const node of nodes(ast.program)) {
    const argument = node.arguments?.[0];
    if (node.type !== "CallExpression" || node.callee?.name !== callee || !argument || argument.type === "Literal") continue;
    for (const child of nodes(argument)) {
      if (child.type === "Literal" && typeof child.value === "string" && /^(shell|agents):/.test(child.value)) keys.add(child.value);
    }
  }
  return [...keys];
}

function nounMapKeys(path: string, functionName: string) {
  const ast = parseSync(path, source(path), { sourceType: "module" });
  expect(ast.errors).toEqual([]);
  const fn = [...nodes(ast.program)].find(node => node.type === "FunctionDeclaration" && node.id?.name === functionName);
  expect(fn, `${path}: finite plural helper`).toBeDefined();
  const map = [...nodes(fn)].find(node => node.type === "VariableDeclarator" && node.id?.name === "key");
  expect(map?.init?.type).toBe("ObjectExpression");
  // Read property values, not a count_* regex: even a newly named finite key
  // must be checked, and quoted noun property names are not catalog keys.
  return (map?.init?.properties ?? []).map(property => {
    expect(property.value?.type).toBe("Literal");
    expect(typeof property.value?.value).toBe("string");
    return `agents:${property.value!.value}`;
  });
}

describe("bounded dynamic localization domains", () => {
  it.each(locales)("has every live finite activity/search key without fallback (%s)", locale => {
    expect(source("lib/issue-change-receipt.ts")).toContain("display:activity_value_${trimmed}");
    expect(source("lib/search-filters.ts")).toContain("display:search_value_${value}");
    expect(missingKeys([...displayDomains.activity, ...displayDomains.search], locale)).toEqual([]);
  });
  it("does not let defaultValue or English fallback hide a future missing key", () => {
    expect(missingKeys(["display:activity_value_future_mode_missing"], "zh-CN")).toEqual(["display:activity_value_future_mode_missing"]);
  });
  it.each(locales)("renders skill-test activity and monitoring filters from real helpers (%s)", async locale => {
    await i18n.changeLanguage(locale);
    expect(formatIssueChangeValue("skill_test", { field: "workMode" })).toBe(locale === "en" ? "skill test" : "技能测试");
    const chips = buildFilterChips({ status: ["monitoring"] }, { agentName: () => undefined, userName: () => undefined, projectName: () => undefined, labelName: () => undefined, currentUserId: null });
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe(locale === "en" ? "Status: Monitoring" : "状态：监测中");
    // Unrecognized server/user input keeps the established diagnostic humanization.
    expect(formatIssueChangeValue("future_mode", { field: "workMode" })).toBe("future mode");
  });
  it.each(locales)("checks every finite key in the real status-card dynamic calls (%s)", locale => {
    const keys = dynamicLiteralKeys("pages/StatusCards/StatusCardDetailDrawer.tsx", "translateShell");
    const schemaKeys = [
      ...statusCardUpdateTriggerSchema.options.map(value => `shell:card_trigger_${value}`),
      ...statusCardUpdateStatusSchema.options.filter(value => value !== "ok").map(value => `shell:card_status_${value}`),
      "shell:card_revision_changes", "shell:card_update_changes",
    ];
    expect(keys.sort()).toEqual(schemaKeys.sort());
    for (const count of [0, 1, 2]) {
      expect(keys.filter(key => !i18n.exists(key, { lng: locale, fallbackLng: false, count }))).toEqual([]);
    }
  });
  it.each(locales)("renders full revision/update count phrases for zero, one and two (%s)", async locale => {
    await i18n.changeLanguage(locale);
    for (const revision of [false, true]) for (const count of [0, 1, 2]) {
      const key = revision ? "shell:card_revision_changes" : "shell:card_update_changes";
      const expected = locale === "en"
        ? `Integrated in this ${revision ? "revision" : "update"} (${count} ${count === 1 ? "change" : "changes"})`
        : `${revision ? "此修订" : "此次更新"}中已整合的变更（${count} 项）`;
      expect(i18n.t(key, { count })).toBe(expected);
    }
  });
  it.each(locales)("keeps exact English enum labels and localizes Chinese status/trigger labels (%s)", async locale => {
    await i18n.changeLanguage(locale);
    const labels = { failed: "失败", running: "运行中", interval: "定时触发", manual: "手动触发", reactive: "变更触发", restore: "恢复触发" };
    for (const [value, zh] of Object.entries(labels)) {
      expect(i18n.t(`shell:card_${value === "failed" || value === "running" ? "status" : "trigger"}_${value}`)).toBe(locale === "en" ? value : zh);
    }
  });
  it.each(locales)("checks every finite noun-map count key in both real helper callsites (%s)", locale => {
    for (const [path, name] of [["pages/tools/GatewaysTab.tsx", "pluralize"], ["pages/tools/profiles/profile-summary.ts", "plural"]]) {
      const keys = nounMapKeys(path, name);
      expect(keys.length).toBeGreaterThanOrEqual(4);
      for (const count of [0, 1, 2]) expect(missingKeys(keys, locale, i18n, count)).toEqual([]);
    }
  });
  it.each(locales)("renders assignment/connection plurals including zero (%s)", async locale => {
    await i18n.changeLanguage(locale);
    for (const count of [0, 1, 2]) for (const noun of ["assignment", "connection"]) {
      const expected = locale === "en" ? `${count} ${noun}${count === 1 ? "" : "s"}` : `${count} ${noun === "assignment" ? "项分配" : "个连接"}`;
      expect(i18n.t(`agents:count_${noun}`, { count })).toBe(expected);
      if (noun === "assignment" && count > 0) {
        expect(assignedLabel({ accessMode: "selected", allowedToolCount: 0, allowedApplicationCount: 0, excludedToolCount: 0, totalToolCount: 0, assignmentCount: count, appliesToAgentCount: 0, isCompanyDefault: false }).text).toBe(expected);
      }
    }
  });
  it("fails the domain gate when a real plural variant is removed despite an English fallback", async () => {
    const zh = { ...i18n.getResourceBundle("zh-CN", "agents") };
    delete zh.count_connection_other;
    const isolated = createInstance();
    await isolated.init({ lng: "zh-CN", fallbackLng: "en", initAsync: false, resources: { en: { agents: i18n.getResourceBundle("en", "agents") }, "zh-CN": { agents: zh } } });
    expect(isolated.t("agents:count_connection", { count: 2 })).toBe("2 connections");
    expect(missingKeys(nounMapKeys("pages/tools/GatewaysTab.tsx", "pluralize"), "zh-CN", isolated, 2)).toEqual(["agents:count_connection"]);
  });
});
