import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { TaskTreeControlDialog } from "./TaskTreeControls";

vi.mock("./ui/dialog", () => {
  const Group = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Group,
    DialogContent: Group,
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    DialogFooter: Group,
    DialogHeader: Group,
    DialogTitle: Group,
  };
});

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("Resume preview localization", () => {
  it.each([1, 2, 5, 21, 22, 25])("describes removing the pause from %i tasks without promising execution", async count => {
    const onApply = vi.fn();
    const onWakeAgentsChange = vi.fn();
    for (const scope of ["leaf", "subtree"] as const) {
      for (const locale of ["en", "ru", "en"]) {
        await i18n.changeLanguage(locale);
        const html = renderToStaticMarkup(<TaskTreeControlDialog
          open onOpenChange={vi.fn()} mode="resume" scope={scope}
          affectedCount={count} affectedAgentCount={0}
          loading={false} pending={false} valid wakeAgents
          onWakeAgentsChange={onWakeAgentsChange} onRetry={vi.fn()} onApply={onApply}
        />);
        const noun = count === 1 || count === 21 ? "задачи" : "задач";
        expect(html).toContain(locale === "ru"
          ? `<p>Пауза будет снята с ${count} ${noun}.</p>`
          : `<p>The pause will be removed from ${count} task${count === 1 ? "" : "s"}.</p>`);
        expect(html).toContain('type="checkbox" disabled=""');
        expect(html).not.toContain('checked=""');
        expect(onApply).not.toHaveBeenCalled();
        expect(onWakeAgentsChange).not.toHaveBeenCalled();
      }
    }
  });
});
