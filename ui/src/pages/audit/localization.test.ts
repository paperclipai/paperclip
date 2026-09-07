import { afterEach, describe, expect, it } from "vitest";
import { i18n, t } from "@/i18n";
import { formatActivityVerb, formatIssueActivityAction } from "@/lib/activity-format";
import { describeRunRetryState } from "@/lib/runRetryState";
import { formatVisibleDurationMinutes } from "@/components/timeline/WorkTimelineChart";

afterEach(() => { void i18n.changeLanguage("en"); });

describe("Russian activity and finance localization", () => {
  it.each([
    [1, "1 запуск", "1 провайдер", "1 неделя"],
    [2, "2 запуска", "2 провайдера", "2 недели"],
    [5, "5 запусков", "5 провайдеров", "5 недель"],
    [21, "21 запуск", "21 провайдер", "21 неделя"],
    [22, "22 запуска", "22 провайдера", "22 недели"],
    [25, "25 запусков", "25 провайдеров", "25 недель"],
  ])("uses Russian count forms for %i", async (count, runs, providers, weeks) => {
    await i18n.changeLanguage("ru");
    expect(t("localizationActivity.runs", { count })).toBe(runs);
    expect(t("localizationActivity.providerCount", { count })).toBe(providers);
    expect(formatVisibleDurationMinutes(Number(count) * 7 * 24 * 60)).toBe("Видимый период: " + weeks);
  });

  it("formats complete issue changes with translated values and preserved references", async () => {
    await i18n.changeLanguage("ru");
    expect(formatActivityVerb("issue.updated", {
      status: "in_progress", _previous: { status: "todo" },
    })).toContain("смена статуса с «");
    expect(formatActivityVerb("issue.updated", { priority: "high" })).not.toContain("high");
    expect(formatIssueActivityAction("issue.blockers_updated", {
      addedBlockedByIssues: [{ identifier: "PAP-123" }], removedBlockedByIssues: [],
    })).toBe("добавление блокирующей задачи: PAP-123");
    expect(formatIssueActivityAction("issue.reviewers_updated", {
      addedParticipants: [{ type: "agent" }, { type: "agent" }], removedParticipants: [],
    })).toBe("добавление 2 проверяющих");
    expect(formatActivityVerb("future.action")).toBe("future action");
  });

  it("updates retry copy at read time and keeps the linked run ID", async () => {
    const run = { status: "scheduled_retry", scheduledRetryAttempt: 2, retryOfRunId: "run-original", scheduledRetryReason: "transient_failure" };
    await i18n.changeLanguage("ru");
    expect(describeRunRetryState(run)).toMatchObject({
      badgeLabel: "Повторная попытка запланирована",
      detail: "Попытка 2 · Временный сбой",
      secondary: "Ожидается назначение времени повторной попытки",
      retryOfRunId: "run-original",
    });
    await i18n.changeLanguage("en");
    expect(describeRunRetryState(run)?.badgeLabel).toBe("Retry scheduled");
  });
});
