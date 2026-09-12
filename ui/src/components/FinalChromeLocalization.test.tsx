// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaWindow, SourceTrustMetadata } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { BuiltInLifecycleChip } from "./BuiltInAgentBadges";
import { ClaudeSubscriptionPanel } from "./ClaudeSubscriptionPanel";
import { EnforcementBanner } from "./EnforcementBanner";
import { SourceTrustBadge } from "./SourceTrustBadge";

const listAudit = vi.hoisted(() => vi.fn());
vi.mock("@/api/tools", () => ({ toolsApi: { listAudit } }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("final agent chrome localization", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    listAudit.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    await i18n.changeLanguage("en");
  });

  async function render(node: ReactNode) {
    await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  }

  async function russian() {
    await act(async () => { await i18n.changeLanguage("ru"); });
  }

  it("updates lifecycle labels and tooltips without changing status", async () => {
    await render(<>
      <BuiltInLifecycleChip status="pending_approval" />
      <BuiltInLifecycleChip status="pending_approval" compact />
      <BuiltInLifecycleChip status="needs_setup" />
      <BuiltInLifecycleChip status="needs_setup" compact />
    </>);
    const badges = Array.from(container.querySelectorAll<HTMLElement>("[title]"));
    expect(badges.map((badge) => badge.textContent)).toEqual(["Pending approval", "Approval", "Needs setup", "Setup"]);
    expect(badges[0].title).toBe("Waiting on board hire approval before the feature can run");
    await russian();
    expect(badges.map((badge) => badge.textContent)).toEqual(["Ожидает одобрения", "Одобрение", "Нужна настройка", "Настройка"]);
    expect(badges[0].title).toContain("одобрения найма руководством");
    expect(badges[2].title).toContain("настроить адаптер и модель");
    expect(container.querySelectorAll("[title]")).toHaveLength(4);
  });

  it.each([
    [0, "вызовов"], [1, "вызов"], [2, "вызова"], [5, "вызовов"], [11, "вызовов"], [21, "вызов"],
  ] as const)("renders the complete denial phrase for %i without fetching or changing enforcement", async (count, noun) => {
    await render(<EnforcementBanner companyId="company-raw" recentDenialCount={count} forceVariant="denied-detected" />);
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe(`${count} governed tool ${count === 1 ? "call was" : "calls were"} denied or failed in the last hour. Access is enforced server-side by the tool gateway — open the affected connector to review what was blocked and why.`);
    const classes = status.className;
    await russian();
    expect(status.textContent).toContain(`${count} ${noun} `);
    expect(status.textContent).toContain("контролирует доступ на стороне сервера");
    expect(status.textContent).toContain("что было заблокировано и почему");
    expect(status.querySelector("span.font-medium")?.textContent).toBe(String(count));
    expect(status.className).toBe(classes);
    expect(listAudit).not.toHaveBeenCalled();
  });

  it("keeps the default-deny warning and preserves caller-owned presentational content", async () => {
    await render(<EnforcementBanner forceVariant="default" />);
    expect(container.textContent).toContain("everything else is denied by default");
    await russian();
    expect(container.textContent).toContain("только инструменты, разрешённые их профилями и политиками");
    expect(container.textContent).toContain("Всё остальное запрещено по умолчанию");
    await render(<EnforcementBanner tone="warning" title="Custom board message" body="External policy description" />);
    expect(container.textContent).toBe("Custom board messageExternal policy description");
    expect(listAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["comment", "Исходный комментарий"],
    ["document", "Исходный документ"],
    ["work product", "Исходный результат работы"],
    ["content", "Исходный контент"],
  ] as const)("localizes the %s trust boundary without changing metadata", async (artifactLabel, phrase) => {
    const sourceTrust: SourceTrustMetadata = { preset: "low_trust_review", disposition: "quarantined", sourceAgentId: "agent-raw" };
    const original = structuredClone(sourceTrust);
    await render(<SourceTrustBadge sourceTrust={sourceTrust} artifactLabel={artifactLabel} />);
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe(`Authored by a low-trust review agent. Raw ${artifactLabel} is not auto-shared with higher-trust agents.`);
    await russian();
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe(`Автор — агент проверки с низким уровнем доверия. ${phrase} не передаётся автоматически агентам с более высоким уровнем доверия.`);
    expect(container.querySelector('[aria-label]')?.getAttribute("aria-label")).toBe("Источник с низким доверием");
    expect(sourceTrust).toEqual(original);
  });

  it("localizes promotion dates while preserving the source trust record", async () => {
    const sourceTrust: SourceTrustMetadata = { preset: "low_trust_review", disposition: "promoted", promotedAt: "2026-08-31T12:34:00Z", promotedByActorId: "user-raw" };
    const original = structuredClone(sourceTrust);
    await render(<SourceTrustBadge sourceTrust={sourceTrust} />);
    expect(container.textContent).toContain(`Promoted from low-trust on ${new Date(sourceTrust.promotedAt!).toLocaleString("en")}.`);
    await russian();
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe(`Материал с низким уровнем доверия допущен к использованию ${new Date(sourceTrust.promotedAt!).toLocaleString("ru")}.`);
    expect(sourceTrust).toEqual(original);
  });

  it("localizes adapter-owned Claude quota labels and details without mutating values, sorting or bar widths", async () => {
    const windows: QuotaWindow[] = [
      { label: "Extra usage", usedPercent: null, resetsAt: null, valueLabel: "Not enabled", detail: "Extra usage not enabled • /extra-usage to enable" },
      { label: "Current week (Sonnet only)", usedPercent: 92, resetsAt: null, valueLabel: null, detail: "Resets Aug 31 at 3pm (UTC)" },
      { label: "Current session", usedPercent: 12.5, resetsAt: "2026-08-31T12:00:00Z", valueLabel: null, detail: null },
      { label: "Custom window", usedPercent: 2, resetsAt: null, valueLabel: null, detail: "Custom provider detail" },
    ];
    const original = structuredClone(windows);
    await render(<ClaudeSubscriptionPanel windows={windows} source="claude-cli" error="Custom provider error" />);
    expect(container.textContent).toContain("12.5% used");
    expect(container.textContent).toContain("Current session");
    expect(container.textContent!.indexOf("Current session")).toBeLessThan(container.textContent!.indexOf("Extra usage"));
    const bars = Array.from(container.querySelectorAll<HTMLElement>("[style]"));
    const widths = bars.map((bar) => bar.style.width);
    await russian();
    expect(container.textContent).toContain("Подписка Anthropic");
    expect(container.textContent).toContain("Текущий сеанс");
    expect(container.textContent).toContain("Использовано 12,5%");
    expect(container.textContent).toContain("Текущая неделя (только Sonnet)");
    expect(container.textContent).toContain("Дополнительное использование не включено • Включить: /extra-usage");
    expect(container.textContent).toContain("Resets Aug 31 at 3pm (UTC)");
    expect(container.textContent).toContain("Custom window");
    expect(container.textContent).toContain("Custom provider detail");
    expect(container.textContent).toContain("Custom provider error");
    expect(container.textContent).toContain("Claude CLI");
    expect(Array.from(container.querySelectorAll<HTMLElement>("[style]"))).toEqual(bars);
    expect(bars.map((bar) => bar.style.width)).toEqual(widths);
    expect(windows).toEqual(original);
  });

  it("preserves unknown quota values and details even within the known extra usage section", async () => {
    await russian();
    const windows: QuotaWindow[] = [
      { label: "Extra usage", usedPercent: null, resetsAt: null, valueLabel: "$12.00 / $100.00", detail: "constructor" },
      { label: "toString", usedPercent: 0, resetsAt: null, valueLabel: null, detail: "Unrecognized provider detail" },
    ];
    await render(<ClaudeSubscriptionPanel windows={windows} source="custom-provider" />);
    expect(container.textContent).toContain("$12.00 / $100.00");
    expect(container.textContent).toContain("Unrecognized provider detail");
    expect(container.textContent).toContain("custom-provider");
    expect(container.textContent).toContain("toString");
    expect(container.textContent).toContain("constructor");
  });
});
