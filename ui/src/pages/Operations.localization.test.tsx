// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineHealthWarning } from "@paperclipai/shared";
import { i18n, t } from "@/i18n";
import type { PipelineCaseEvent } from "../api/pipelines";
import { PipelineHealthBar, pipelineHealthWarningMessage } from "../components/PipelineHealthWarnings";
import { formatPipelineItemEvent } from "../lib/pipeline-item-detail";
import { breakdownSummarySentence, pieceNounPlural } from "../lib/pipeline-breakdown";
import { environmentDisplayLabel } from "../lib/managed-sandbox-environment";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  void i18n.changeLanguage("en");
});

describe("Pipeline, team, and environment localization", () => {
  it.each([[1, "источник", "песочницу"], [2, "источника", "песочницы"], [5, "источников", "песочниц"], [21, "источник", "песочницу"], [22, "источника", "песочницы"], [25, "источников", "песочниц"]])(
    "keeps Russian count forms and deletion meaning for %i",
    (count, source, sandbox) => {
      void i18n.changeLanguage("ru");
      expect(t("localizationOperations.externalSourceCount", { count })).toContain(`${count} внешн`);
      expect(t("localizationOperations.externalSourceCount", { count })).toMatch(new RegExp(source + "$"));
      expect(t("localizationOperations.destroyAndDelete", { count })).toBe(`Уничтожить ${count} ${sandbox} и удалить`);
      expect(t("localizationOperations.destroyReusableSandboxes", { count })).toContain("Рабочие области останутся открытыми");
    },
  );

  it("updates a mounted health warning without changing its stage action or raw message", () => {
    const warning: PipelineHealthWarning = {
      code: "paused_agent", stageId: "raw-stage-id", stageKey: "review", stageName: "User stage",
      message: "Agent Red is paused, so this step won't run until they're back. Reassign it if you can't wait.",
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onSelectStage = vi.fn();
    act(() => root?.render(<PipelineHealthBar warnings={[warning]} onSelectStage={onSelectStage} />));
    expect(container.textContent).toContain("Agent Red is paused");
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Работа участника «Agent Red» приостановлена.");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Открыть настройки этапа «User stage»"]');
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(onSelectStage).toHaveBeenCalledWith("raw-stage-id");
    expect(pipelineHealthWarningMessage({ ...warning, message: "Raw custom diagnostic" })).toBe("Raw custom diagnostic");
    expect(warning.message).toContain("Agent Red is paused");
    act(() => { void i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("Agent Red is paused");
  });

  it("uses complete activity and breakdown templates while preserving names and machine fields", () => {
    const event: PipelineCaseEvent = {
      id: "event-id", companyId: "company-id", caseId: "case-id", type: "case.transitioned", actorType: "system",
      fromStage: { id: "from-id", key: "draft", name: "Draft", kind: "working" },
      toStage: { id: "to-id", key: "done", name: "Done", kind: "done" },
      payload: { reason: "children_terminal", transitionClass: "automatic" }, createdAt: "2026-08-19", updatedAt: "2026-08-19",
    };
    const config = { targetPipelineId: "pipeline-id", targetStageKey: "raw-key", pieceNoun: "часть", inheritFields: [], advanceTo: "review", waitForPieces: true, whenFinishedMoveTo: "done" };
    const names = { targetPipelineName: "User pipeline", entryStageName: "Draft", advanceToName: "Review", whenFinishedName: "Done", inheritedFieldLabels: ["Raw field"] };
    expect(formatPipelineItemEvent(event)).toBe("Moved from Draft to Done — automatic (all child items done).");
    void i18n.changeLanguage("ru");
    expect(formatPipelineItemEvent(event)).toBe("Элемент перемещён с этапа «Draft» на этап «Done» — автоматически (все дочерние элементы завершены).");
    expect(pieceNounPlural("часть")).toBe("часть");
    expect(breakdownSummarySentence(config, names)).toContain("части типа «часть»");
    expect(breakdownSummarySentence(config, names)).toContain("«User pipeline» → «Draft»");
    expect(environmentDisplayLabel({ name: "Raw environment", driver: "ssh", metadata: {} })).toBe("Raw environment · SSH");
    expect(event.payload).toEqual({ reason: "children_terminal", transitionClass: "automatic" });
    expect(config.pieceNoun).toBe("часть");
    void i18n.changeLanguage("en");
    expect(pieceNounPlural("piece")).toBe("pieces");
    expect(environmentDisplayLabel({ name: "Raw environment", driver: "ssh", metadata: {} })).toBe("Raw environment · ssh");
  });
});
