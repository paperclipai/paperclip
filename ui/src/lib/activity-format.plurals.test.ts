import type { Agent } from "@paperclipai/shared";
import { afterEach, describe, expect, it } from "vitest";
import { i18n, t } from "@/i18n";
import { formatActivityVerb, formatIssueActivityAction } from "./activity-format";

const counts = [1, 2, 5, 21, 22, 25, 101, 111] as const;
const entities = ["approver", "reviewer", "blocker"] as const;
const changes = ["added", "removed"] as const;
const surfaces = ["detail", "row"] as const;
const nounOne = { approver: "согласующего", reviewer: "проверяющего", blocker: "блокирующей задачи" };
const nounMany = { approver: "согласующих", reviewer: "проверяющих", blocker: "блокирующих задач" };
afterEach(async () => { await i18n.changeLanguage("en"); });

describe("structured activity participant counts", () => {
  for (const entity of entities) {
    for (const change of changes) {
      for (const surface of surfaces) {
        it.each(counts)(`${entity} ${change} ${surface}: preserves count/name for %i`, async (count) => {
          const agentMap = new Map<string, Agent>(Array.from({ length: count }, (_, index) => [
            `agent-${index}`, { id: `agent-${index}`, name: `RAW_NAME_${index} / «Key»` } as Agent,
          ]));
          const records = Array.from({ length: count }, (_, index) => entity === "blocker"
            ? { id: `raw-issue-${index}`, identifier: `RAW-${index}`, title: `RAW_TITLE_${index}` }
            : { type: "agent", agentId: `agent-${index}`, userId: null });
          const field = entity === "blocker" ? "BlockedByIssues" : "Participants";
          const details = { [`added${field}`]: change === "added" ? records : [], [`removed${field}`]: change === "removed" ? records : [] };
          const before = JSON.stringify(details);
          const action = `issue.${entity}s_updated`;
          const format = surface === "row" ? formatActivityVerb : formatIssueActivityAction;
          const rawName = entity === "blocker" ? "RAW-0" : "RAW_NAME_0 / «Key»";
          const enSuffix = surface === "row" ? (change === "added" ? " to" : " from") : "";
          await i18n.changeLanguage("en");
          expect(format(action, details, { agentMap })).toBe(count === 1
            ? `${change} ${entity} ${rawName}${enSuffix}`
            : `${change} ${count} ${entity}s${enSuffix}`);
          await i18n.changeLanguage("ru");
          const verb = change === "added" ? "добавление" : "удаление";
          const singular = count % 10 === 1 && count % 100 !== 11;
          const expected = count === 1
            ? `${verb} ${nounOne[entity]}: ${rawName}`
            : `${verb} ${count} ${singular ? nounOne[entity] : nounMany[entity]}`;
          expect(format(action, details, { agentMap })).toBe(expected);
          if (count > 1) {
            expect(format(action, details, { agentMap })).toContain(String(count));
            expect(format(action, details, { agentMap })).not.toContain(rawName);
          }
          expect(JSON.stringify(details)).toBe(before);
          expect(agentMap.get("agent-0")?.name).toBe("RAW_NAME_0 / «Key»");
          await i18n.changeLanguage("en");
          expect(format(action, details, { agentMap })).toBe(count === 1
            ? `${change} ${entity} ${rawName}${enSuffix}`
            : `${change} ${count} ${entity}s${enSuffix}`);
        });
      }
    }
  }

  it.each(entities)("retains count in every %s numeric plural category, including fractions", async (entity) => {
    await i18n.changeLanguage("ru");
    for (const change of changes) {
      for (const suffix of ["", "Row"]) {
        const key = `localizationActivity.change_${change}_${entity}${suffix}`;
        const verb = change === "added" ? "добавление" : "удаление";
        for (const count of [0, 1, 1.5, 2, 5, 21, 101, 111]) {
          const singular = count === 1.5 || (count % 10 === 1 && count % 100 !== 11);
          expect(t(key, { count })).toBe(`${verb} ${count} ${singular ? nounOne[entity] : nounMany[entity]}`);
        }
      }
    }
  });

  it("leaves mixed-change and empty-change wording unchanged", async () => {
    await i18n.changeLanguage("ru");
    for (const entity of entities) {
      const field = entity === "blocker" ? "BlockedByIssues" : "Participants";
      const one = entity === "blocker" ? { id: "RAW_ID" } : { type: "agent", agentId: "RAW_ID" };
      for (const [added, removed] of [[[], []], [[one], [one]]]) {
        const details = { [`added${field}`]: added, [`removed${field}`]: removed };
        expect(formatIssueActivityAction(`issue.${entity}s_updated`, details)).toBe(t(`localizationActivity.change_updated_${entity}`));
        expect(formatActivityVerb(`issue.${entity}s_updated`, details)).toBe(t(`localizationActivity.change_updated_${entity}Row`));
      }
    }
  });
});

