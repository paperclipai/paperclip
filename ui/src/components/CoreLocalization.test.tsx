// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal } from "@paperclipai/shared";
import { setLocale } from "../i18n";
import { goalLevelLabel } from "../lib/goal-display";
import { FrontDoor } from "./FrontDoor";
import { GoalTree } from "./GoalTree";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";
import { Stepper } from "./onboarding/Stepper";
import { CredentialModeLink } from "./onboarding/CredentialModeLink";
import { ThemeProvider } from "../context/ThemeContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("core localized UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    setLocale("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setLocale("en");
  });

  it("translates first-run choices but returns the original path identifiers", async () => {
    const onChoose = vi.fn();
    await act(async () => root.render(<FrontDoor onChoose={onChoose} />));
    await act(async () => setLocale("ru"));
    expect(container.textContent).toContain("Создать организацию");
    expect(container.textContent).toContain("Добавить агентов в организацию");
    await act(async () => container.querySelectorAll("button")[1].click());
    expect(onChoose).toHaveBeenCalledWith("grow");
    await act(async () => setLocale("en"));
    expect(container.textContent).toContain("Add agents to your org");
  });

  it("updates step accessibility and credential labels without changing destinations", async () => {
    const jump = vi.fn();
    const change = vi.fn();
    await act(async () => root.render(<>
      <Stepper step={2} canJumpToStep={() => true} onJumpToStep={jump} />
      <CredentialModeLink mode="subscription" onChange={change} />
    </>));
    await act(async () => setLocale("ru"));
    expect(container.textContent).toContain("Шаг 2 из 3");
    const step = container.querySelector<HTMLButtonElement>('[aria-label="Подключите модель"]')!;
    expect(step.getAttribute("aria-current")).toBe("step");
    await act(async () => step.click());
    expect(jump).toHaveBeenCalledWith(2);
    await act(async () => container.querySelectorAll("button")[3].click());
    expect(change).toHaveBeenCalledWith("api");
    await act(async () => setLocale("en"));
    expect(container.textContent).toContain("Use API key instead");
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it("keeps goal titles, identifiers and collapsed state across a language change", async () => {
    const parent: Goal = {
      id: "goal-parent", companyId: "company-1", title: "Raw parent title",
      description: null, level: "company", status: "active", parentId: null,
      ownerAgentId: null, createdAt: new Date(0), updatedAt: new Date(0),
    };
    const child: Goal = { ...parent, id: "goal-child", title: "Raw child title", parentId: parent.id, level: "task" };
    const select = vi.fn();
    await act(async () => root.render(<GoalTree goals={[parent, child]} onSelect={select} />));
    await act(async () => container.querySelector("button")!.click());
    await act(async () => setLocale("ru"));
    expect(container.textContent).toContain("Организация");
    expect(container.textContent).toContain("Raw parent title");
    expect(container.textContent).not.toContain("Raw child title");
    expect(container.querySelector("button")!.getAttribute("aria-label")).toBe("Подцели: Raw parent title");
    expect(container.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    expect(goalLevelLabel("custom-level")).toBe("custom-level");
    await act(async () => container.querySelector("button")!.parentElement!.click());
    expect(select).toHaveBeenCalledWith(parent);
    expect(parent.level).toBe("company");
    await act(async () => setLocale("en"));
    expect(container.textContent).toContain("Organization");
  });

  it("localizes approval metadata without rewriting the approval payload", async () => {
    const payload = Object.freeze({
      scopeType: "company", scopeName: "Raw Company", windowKind: "calendar_month_utc",
      metric: "billed_cents", budgetAmount: 10000, observedAmount: 12345,
      guidance: "Untranslated user guidance with API_KEY=raw",
    });
    await act(async () => root.render(<ThemeProvider><ApprovalPayloadRenderer type="budget_override_required" payload={payload} /></ThemeProvider>));
    await act(async () => setLocale("ru"));
    expect(container.textContent).toContain("Календарный месяц (UTC)");
    expect(container.textContent).toContain("Начисленные расходы");
    expect(container.textContent).toContain(payload.guidance);
    expect(container.textContent).toContain(payload.scopeName);
    expect(approvalLabel("request_board_approval", { title: "Raw title" })).toBe("Одобрение совета директоров: Raw title");
    expect(payload.metric).toBe("billed_cents");
    await act(async () => setLocale("en"));
    expect(container.textContent).toContain("Calendar month (UTC)");
  });
});
