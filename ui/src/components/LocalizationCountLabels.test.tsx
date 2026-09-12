// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { PipelineHealthWarning } from "@paperclipai/shared";
import { i18n, t } from "@/i18n";
import { StageHealthWarnings } from "./PipelineHealthWarnings";
import { StatusIcon } from "./StatusIcon";
import { ZeroResultsRecovery } from "./search/ZeroResultsRecovery";
import type { SearchFilters } from "@/lib/search-filters";

afterEach(() => { void i18n.changeLanguage("en"); });

describe("Single-item copy versus Russian one plural category", () => {
  it.each([1, 2, 5, 11, 21, 22, 25, 101, 111])("retains a stage warning count of %i", (count) => {
    void i18n.changeLanguage("ru");
    const warnings: PipelineHealthWarning[] = Array.from({ length: count }, (_, index) => ({
      code: "paused_agent", stageId: `stage-${index}`, stageKey: "review", stageName: "Raw stage",
      message: "Raw custom diagnostic",
    }));
    const html = renderToStaticMarkup(<StageHealthWarnings warnings={warnings} />);
    const heading = html.match(/<h2\b[^>]*>(.*?)<\/h2>/s)?.[1] ?? "";
    expect(heading).not.toContain("localizationOperations.");
    if (count === 1) expect(heading).toContain(t("localizationOperations.healthStageTitleSingle"));
    else expect(heading).toMatch(new RegExp(`\\b${count}\\b`));
    expect(html.match(/Raw custom diagnostic/g)).toHaveLength(count);
  });

  it.each([1, 2, 5, 11, 21, 22, 25, 101, 111])("retains an unnamed stalled-review count of %i", (count) => {
    void i18n.changeLanguage("ru");
    const html = renderToStaticMarkup(<StatusIcon status="blocked" blockerAttention={{
      state: "stalled", reason: "stalled_review", unresolvedBlockerCount: count,
      coveredBlockerCount: 0, attentionBlockerCount: 0, stalledBlockerCount: count,
      sampleBlockerIdentifier: null, sampleStalledBlockerIdentifier: null,
    }} />);
    expect(html).toContain("var(--status-task-icon-blocked)");
    expect(html).not.toContain("localizationIssuePanels.");
    const title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? html.match(/aria-label="([^"]*)"/)?.[1] ?? "";
    if (count === 1) expect(title).toBe(t("localizationIssuePanels.blockedReviewSingle"));
    else expect(title).toMatch(new RegExp(`\\b${count}\\b`));
  });

  it.each([1, 2, 5, 6])("renders %i active filter dimensions without mutating their values", (count) => {
    void i18n.changeLanguage("ru");
    const dimensions: SearchFilters[] = [
      { status: ["todo"] }, { priority: ["high"] }, { assigneeAgentId: "agent-id" },
      { projectId: "project-id" }, { labelId: "label-id" }, { updatedWithin: "7d" },
    ];
    const filters = Object.assign({}, ...dimensions.slice(0, count)) as SearchFilters;
    const before = JSON.stringify(filters);
    const html = renderToStaticMarkup(<ZeroResultsRecovery query="raw query" filters={filters}
      zeroResults={{ unfilteredTotal: 117, loosenSuggestions: [] }}
      lookups={{ agentName: () => undefined, userName: () => undefined, projectName: () => undefined, labelName: () => undefined, currentUserId: null }}
      onChange={() => {}} onClearAll={() => {}} />);
    expect(html).toContain("raw query");
    expect(html).toContain(t(count === 1 ? "localizationFilters.hiddenByFiltersSingle" : "localizationFilters.hiddenByFilters", { count }));
    expect(JSON.stringify(filters)).toBe(before);
  });

  it.each([21, 101])("keeps %i if further filter dimensions are added", (count) => {
    void i18n.changeLanguage("ru");
    expect(t("localizationFilters.hiddenByFilters", { count })).toContain(`${count} активный фильтр`);
  });
});
