import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { applyIssueFilters, defaultIssueFilterState, issueFilterLabel, issueQuickFilterPresets } from "@/lib/issue-filters";
import { taskView } from "@/lib/task-views";
import { StatusIcon } from "./StatusIcon";
import { IssueStatusBadge } from "./StatusBadge";
import { KanbanBoard, resolveKanbanTargetStatus } from "./KanbanBoard";

const monitor = Object.freeze({ id: "monitor_RAW", status: "in_progress", displayStatus: "monitoring" }) as Issue;
const running = Object.freeze({ id: "running_RAW", status: "in_progress", displayStatus: "in_progress" }) as Issue;

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("Monitoring localization", () => {
  it("translates icon, picker trigger and badge without changing the canonical status", async () => {
    const onChange = vi.fn();
    for (const language of ["en", "ru", "en"]) {
      await i18n.changeLanguage(language);
      const label = language === "ru" ? "Мониторинг" : "Monitoring";
      const html = renderToStaticMarkup(<StatusIcon {...monitor} showLabel onChange={onChange} />);
      const badge = renderToStaticMarkup(<IssueStatusBadge {...monitor} />);
      expect(html).toContain(label);
      expect(html).toContain("lucide-clock");
      expect(html).toContain("var(--status-task-icon-monitoring)");
      expect(html).not.toContain("animate-spin");
      expect(badge).toContain(`>${label}<`);
      expect(badge).toContain("var(--status-task-monitoring)");
      expect(monitor.status).toBe("in_progress");
      expect(onChange).not.toHaveBeenCalled();
    }
  });

  it("keeps Monitoring in the active views and filters by display state in both locales", async () => {
    for (const language of ["ru", "en"]) {
      await i18n.changeLanguage(language);
      expect(issueFilterLabel("monitoring")).toBe(language === "ru" ? "Мониторинг" : "Monitoring");
      const active = taskView("active");
      const preset = issueQuickFilterPresets.find(item => item.statuses.includes("monitoring"))!;
      expect(active.statuses).toEqual(preset.statuses);
      expect(applyIssueFilters([monitor, running], { ...defaultIssueFilterState, statuses: ["monitoring"] })).toEqual([monitor]);
      expect(applyIssueFilters([monitor, running], { ...defaultIssueFilterState, statuses: active.statuses! })).toEqual([monitor, running]);
      expect(monitor.displayStatus).toBe("monitoring");
    }
  });

  it("translates the board lane while keeping Monitoring unavailable as a mutation target", async () => {
    const onUpdateIssue = vi.fn();
    for (const language of ["en", "ru"]) {
      await i18n.changeLanguage(language);
      const html = renderToStaticMarkup(<KanbanBoard issues={[]} agents={[]} onUpdateIssue={onUpdateIssue} />);
      expect(html).toContain(language === "ru" ? "Мониторинг" : "Monitoring");
      expect(resolveKanbanTargetStatus("monitoring", [monitor])).toBeNull();
      expect(resolveKanbanTargetStatus(monitor.id, [monitor])).toBeNull();
      expect(resolveKanbanTargetStatus("in_progress", [monitor])).toBe("in_progress");
      expect(onUpdateIssue).not.toHaveBeenCalled();
    }
  });
});
