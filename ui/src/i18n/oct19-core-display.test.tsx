// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "@/i18n";
import { CsvPreview } from "@/components/CsvPreview";
import { HtmlArtifactPreview } from "@/components/HtmlArtifactPreview";
import { RuntimeTestCard } from "@/components/RuntimeTestCard";
import { CostEstimateLabel } from "@/components/CostEstimateLabel";
import { DecisionHistoryTable } from "@/components/decision-models/DecisionHistory";
import { decisionHistoryValueDisplay } from "@/lib/decision-history-display";
import { formatDetailedCents } from "@/lib/utils";
import { AccountQuotaPanels } from "@/components/AccountQuotaPanels";
import { AgentLifecycleStatus, agentLifecycleRefetchInterval } from "@/components/AgentLifecycleStatus";
import { FilePreviewModeToggle } from "@/components/FilePreviewModeToggle";
import { ArtifactDropzone } from "@/components/artifacts/ArtifactDropzone";
import { SkillImportWarnings, skillImportWarnings } from "@/pages/skills/SkillImportWarnings";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { SubscriptionCostCard, subscriptionMoney } from "@/components/SubscriptionCostCard";
import type { ProviderQuotaResult, SubscriptionCostReport } from "@paperclipai/shared";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACM" } }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
  await i18n.changeLanguage("en");
});

describe("October 19 core display localization", () => {
  it("refreshes lifecycle copy without changing polling intervals or provider errors", () => {
    const rawError = "Provider original diagnostics";
    act(() => root.render(<AgentLifecycleStatus agent={{ lifecycleState: "cleaning_up", lifecycleError: rawError }} onRetry={() => {}} retryPending={false} />));
    expect(container.textContent).toContain("Agent cleanup failed");
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Не удалось удалить ресурсы агента");
    expect(container.textContent).toContain(rawError);
    expect(agentLifecycleRefetchInterval("cleaning_up")).toBe(2000);
    expect(agentLifecycleRefetchInterval("ready")).toBe(30000);
    act(() => { void i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("Agent cleanup failed");
  });

  it("maps only known provider quota labels and leaves account names and unknown values intact", () => {
    const account: ProviderQuotaResult = { provider: "openai", ok: true, accountLabel: "My original account", capturedAt: "2026-10-19T10:00:00Z", windows: [
      { label: "5h limit", usedPercent: 12.5, resetsAt: null, valueLabel: null },
      { label: "Custom provider window", usedPercent: null, resetsAt: null, valueLabel: "Provider original value" },
    ] };
    const original = JSON.stringify(account);
    act(() => root.render(<AccountQuotaPanels accounts={[account]} />));
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain(t("localizationAgentChrome.quotaFiveHours"));
    expect(container.textContent).toContain("Использовано 12,5%");
    expect(container.textContent).toContain("My original account");
    expect(container.textContent).toContain("Custom provider window");
    expect(container.textContent).toContain("Provider original value");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("13");
    expect(JSON.stringify(account)).toBe(original);
  });

  it("keeps file mode values and native Files drag protocol stable in Russian", () => {
    const changed = vi.fn();
    const upload = vi.fn();
    act(() => root.render(<ArtifactDropzone onUpload={upload}><FilePreviewModeToggle mode="rendered" onChange={changed} label="Original file label" /></ArtifactDropzone>));
    act(() => { void i18n.changeLanguage("ru"); });
    act(() => (container.querySelector('button[aria-label="Исходный текст"]') as HTMLButtonElement).click());
    expect(changed).toHaveBeenCalledWith("raw");
    const file = new File(["user supplied bytes"], "User document.txt");
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file] } });
    act(() => container.querySelector("section")!.dispatchEvent(event));
    expect(upload).toHaveBeenCalledWith([file]);
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Original file label");
    act(() => { void i18n.changeLanguage("en"); });
    expect(container.querySelector('button[aria-label="Raw"]')).not.toBeNull();
  });

  it("pluralizes import warnings and preserves paths, raw errors and canonical warning filters", () => {
    act(() => root.render(<SkillImportWarnings warnings={["Original warning one", "Original warning two"]} />));
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("2 предупреждения при импорте");
    expect(container.textContent).toContain("Original warning one");
    expect(skillImportWarnings([{ path: "README-original.md", error: "Provider raw error", inspection: null }])).toEqual(["README-original.md — нужна настройка: Provider raw error"]);
    expect(t("oct19Core.skillImportWarnings", { count: 21 })).toBe("21 предупреждение при импорте");
    expect(t("oct19Core.skillImportWarnings", { count: 25 })).toBe("25 предупреждений при импорте");
    act(() => { void i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("2 import warnings");
  });

  it("refreshes subscription counts and money while preserving account plan data", () => {
    const usage = { inputTokens: 12, cachedInputTokens: 3, outputTokens: 2, costCents: "0", eventCount: 0, estimatedEventCount: 0, unpricedEventCount: 0 };
    const report: SubscriptionCostReport = { canRefresh: false, asOf: "2026-10-19T10:00:00Z", activeCount: 22, unknownPriceCount: 5, unidentifiedAccountCount: 2,
      monthlyTotals: [{ currency: "EUR", amountCents: "120050", estimatedCount: 1 }], api: usage, subscription: usage, unknown: usage, unattributedSubscription: usage,
      accounts: [{ id: "account-original", provider: "openai", name: "Original account", ownerUserId: null, ownerName: null, shared: true, identityVerified: false, detectedPlan: null, observedAt: null, lastCheckedAt: null, refreshStatus: "unavailable", canEdit: false,
        price: { revision: 1, plan: "Original provider plan", amountCents: "120050", monthlyCents: "120050", currency: "EUR", cadence: "month", status: "active", source: "user", sourceUrl: null, effectiveAt: "2026-10-19T10:00:00Z" }, usage, agents: [] }],
    };
    const original = JSON.stringify(report);
    act(() => root.render(<QueryClientProvider client={queryClient}><SubscriptionCostCard companyId="company-original" report={report} onChanged={() => {}} /></QueryClientProvider>));
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("22 активные подписки");
    expect(container.textContent).toContain("5 неизвестных цен");
    expect(container.textContent).toContain("Входные: 15 · выходные: 2");
    expect(container.textContent).toContain(subscriptionMoney("120050", "EUR") + "/мес.");
    expect(JSON.stringify(report)).toBe(original);
    act(() => { void i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("22 active subscriptions");
  });

  it("resolves adapter metadata on access without changing branded runner identifiers", () => {
    const muse = getAdapterDisplay("muse");
    expect(muse.label).toBe("Muse — Personal agent");
    act(() => { void i18n.changeLanguage("ru"); });
    expect(muse.label).toBe(t("oct19Core.musePersonalAgent"));
    expect(muse.description).toBe("Ваш личный Muse на muse.ai");
    expect(getAdapterDisplay("grok_bot").label).toBe("Grok Bot");
    expect(getAdapterDisplay("openai_dot").label).toBe("OpenAI Dot");
  });

  it("switches CSV labels and plural forms without translating file data", () => {
    const title = "Customer supplied report.csv";
    const text = "User column\n" + Array.from({ length: 21 }, () => "Do not translate user content").join("\n");
    act(() => root.render(<CsvPreview title={title} text={text} />));
    expect(container.textContent).toContain("21 rows");
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("21 строка");
    expect(container.textContent).toContain("1 столбец");
    expect(container.textContent).toContain("User column");
    expect(container.textContent).toContain("Do not translate user content");
    expect(container.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe(t("oct19Core.csvTable", { title }));
    act(() => { void i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("21 rows");
  });

  it("changes HTML accessibility text while preserving the original sandboxed document", () => {
    const html = '<h1>User heading remains unchanged</h1><script>window.userValue = "raw";</script>';
    act(() => root.render(<HtmlArtifactPreview html={html} title="Report.html" />));
    const frame = container.querySelector("iframe")!;
    const source = frame.getAttribute("srcdoc");
    expect(source).toContain("User heading remains unchanged");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    act(() => { void i18n.changeLanguage("ru"); });
    expect(frame.title).toBe(t("oct19Core.renderedHtmlTitle", { title: "Report.html" }));
    expect(frame.getAttribute("srcdoc")).toBe(source);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("resolves prerequisite copy and estimated-charge plurals on a mounted view", () => {
    act(() => root.render(<><RuntimeTestCard state="warn" variant="prerequisites" result={null} onTest={() => {}} /><CostEstimateLabel eventCount={22} estimatedEventCount={22} /></>));
    expect(container.textContent).toContain("Pairing required");
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Требуется подключение");
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("22 оценочных списания.");
    expect(container.textContent).not.toContain("Pairing required");
    act(() => { void i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("Pairing required");
  });

  it("translates only known decision metadata and retains unknown codes and provider data", () => {
    const entry = Object.freeze({
      id: "request-1", feature: "message", actorType: "user", responsibleUserId: "user-1", userName: "User Original",
      issueId: "task-1", issueIdentifier: "PAP-21", agentId: "agent-1", runId: null, connectionId: "connection-1",
      provider: "openai", model: "provider/model:unchanged", status: "succeeded", errorCode: "future_provider_error",
      startedAt: "2026-10-19T10:00:00Z", finishedAt: "2026-10-19T10:00:01Z", durationMs: 1250,
      inputTokens: 1000, outputTokens: 21, costCents: "0.0012345", costStatus: "reported",
      publicationStatus: "published", connectionName: "Original connection name",
    });
    act(() => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><DecisionHistoryTable entries={[entry]} fastResponse /></QueryClientProvider></MemoryRouter>));
    const link = container.querySelector('a[href*="PAP-21"]')?.getAttribute("href");
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("опубликовано");
    expect(container.textContent).toContain("сообщение");
    expect(container.textContent).toContain("1,3 с");
    expect(container.textContent).toContain("future_provider_error");
    expect(container.textContent).toContain("provider/model:unchanged");
    expect(container.textContent).toContain("Original connection name");
    expect(container.textContent).toContain("User Original");
    expect(container.textContent).toContain(formatDetailedCents(entry.costCents));
    expect(container.querySelector('a[href*="PAP-21"]')?.getAttribute("href")).toBe(link);
    expect(decisionHistoryValueDisplay("publication", "future_state")).toBe("future_state");
    expect(entry.publicationStatus).toBe("published");
    expect(entry.errorCode).toBe("future_provider_error");
  });
});
