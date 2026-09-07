// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_OBJECT_STATUS_CATEGORIES, type ExternalObjectSummary } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { externalObjectCategoryLabel, externalObjectDisplayLabel, externalObjectDisplayStatusLabel, externalObjectLivenessLabel, externalObjectTypeLabel } from "@/lib/external-objects";
import { useIssueExternalObjects, type IssueExternalObjectsResult } from "@/hooks/useIssueExternalObjects";
import { ThemeProvider } from "@/context/ThemeContext";
import { ExternalObjectPill } from "./ExternalObjectPill";
import { ExternalObjectStatusSummary } from "./ExternalObjectStatusSummary";
import { ExternalObjectStatusIcon } from "./ExternalObjectStatusIcon";
import { ExternalObjectRows } from "./issue-properties/external-object-rows";
import { MarkdownBody } from "./MarkdownBody";
import { BlockedReasonChip } from "./BlockedReasonChip";

const api = vi.hoisted(() => ({ list: vi.fn(), experimental: vi.fn() }));
vi.mock("../api/externalObjects", () => ({ externalObjectsApi: { listForIssue: api.list } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: api.experimental } }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode } & React.ComponentProps<"a">) => <a href={to} {...props}>{children}</a> }));
vi.mock("../context/CompanyContext", () => ({ useOptionalCompany: () => null }));
vi.mock("../api/issues", () => ({ issuesApi: { get: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("external object display localization", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    await i18n.changeLanguage("en");
  });
  async function render(node: ReactNode) {
    await act(async () => root.render(<QueryClientProvider client={client}><ThemeProvider>{node}</ThemeProvider></QueryClientProvider>));
  }
  async function locale(value: "en" | "ru") { await act(async () => { await i18n.changeLanguage(value); }); }

  it("translates every host-owned category, not custom status, keys or provider labels", async () => {
    await locale("ru");
    const expected = ["Ещё не определён", "Открыт", "Ожидает", "В работе", "Успешно", "С ошибкой", "Заблокирован", "Закрыт", "В архиве", "Нужна авторизация", "Недоступен"];
    expect(EXTERNAL_OBJECT_STATUS_CATEGORIES.map(externalObjectCategoryLabel)).toEqual(expected);
    expect(externalObjectLivenessLabel("fresh")).toBe("Актуален");
    expect(externalObjectTypeLabel("workflow_run")).toBe("запуск рабочего процесса");
    expect(externalObjectDisplayLabel("github", "pull_request")).toBe("пул-реквест GitHub");
    expect(externalObjectDisplayLabel(null, null)).toBe("Внешний объект");
    expect(externalObjectDisplayLabel(null, "issue")).toBe("Внешняя задача");
    expect(externalObjectDisplayLabel("github", "pull_request", "Custom key")).toBe("Custom key");
    expect(externalObjectDisplayStatusLabel({ providerKey: "github", objectType: "pull_request", statusCategory: "succeeded", liveness: "fresh", statusLabel: "Merged" })).toBe("Merged");
    expect(externalObjectCategoryLabel("custom_state")).toBe("custom state");
    expect(externalObjectTypeLabel("toString")).toBe("toString");
  });

  it("keeps merged tone/icon and provider text stable while own liveness ARIA updates", async () => {
    const object = { providerKey: "github", objectType: "pull_request", displayKey: "Custom PR label", statusCategory: "succeeded" as const, liveness: "stale" as const, statusLabel: "Merged", displayTitle: "Raw PR title", url: "https://github.com/acme/repo/pull/12" };
    const original = structuredClone(object);
    await render(<><ExternalObjectPill object={object} /><ExternalObjectStatusIcon category="running" liveness="stale" /></>);
    const pill = container.querySelector("a")!;
    const className = pill.className;
    expect(pill.className).toContain("text-violet-600");
    expect(pill.querySelector("svg")?.classList.contains("lucide-git-merge")).toBe(true);
    expect(pill.getAttribute("aria-label")).toBe("Custom PR label — Merged (Stale): Raw PR title");
    await locale("ru");
    expect(pill.getAttribute("aria-label")).toBe("Custom PR label — Merged (Устарел): Raw PR title");
    expect(pill.className).toBe(className);
    expect(pill.getAttribute("href")).toBe(object.url);
    expect(pill.querySelector("svg")?.classList.contains("lucide-git-merge")).toBe(true);
    expect(container.querySelector('[role="img"][aria-label="В работе (Устарел)"]')).not.toBeNull();
    expect(object).toEqual(original);
  });

  it.each([1, 2, 5, 11, 21])("localizes complete count descriptions for %i while preserving dominant status", async (count) => {
    const summary: ExternalObjectSummary = { total: count, highestSeverity: "danger", byStatusCategory: { failed: count }, byLiveness: { stale: count }, staleCount: count, authRequiredCount: 0, unreachableCount: 0, objects: Array.from({ length: count }, (_, index) => ({ id: String(index), providerKey: "ci", objectType: "deployment", displayTitle: null, statusCategory: "failed", statusTone: "danger", liveness: "stale", isTerminal: false })) };
    const original = structuredClone(summary);
    await render(<ExternalObjectStatusSummary summary={summary} />);
    const badge = container.querySelector('[role="img"]')!;
    expect(badge.getAttribute("aria-label")).toBe(`External objects: ${count} failed, ${count} stale, ${count} total`);
    await locale("ru");
    expect(badge.getAttribute("aria-label")).toBe(`Внешние объекты: С ошибкой: ${count}, Устарело: ${count}, Всего: ${count}`);
    expect(badge.getAttribute("data-external-status")).toBe("failed");
    expect(badge.getAttribute("data-external-tone")).toBe("danger");
    expect(badge.textContent).toBe(String(count));
    expect(summary).toEqual(original);
  });

  it("updates reason and severity accessibility without changing canonical attributes", async () => {
    await render(<BlockedReasonChip reason="pending_board_decision" severity="high" />);
    const chip = container.querySelector('[data-testid="blocked-reason-chip"]')!;
    expect(chip.getAttribute("aria-label")).toBe("Reason: Needs decision, severity high");
    await locale("ru");
    expect(chip.getAttribute("aria-label")).toContain("серьёзность: высокая");
    expect(chip.getAttribute("aria-label")).not.toContain("Needs decision");
    expect(chip.getAttribute("data-variant")).toBe("needs_decision");
    expect(chip.getAttribute("data-severity")).toBe("high");
  });

  it("localizes only verified mention-source labels and preserves references, code wrap, draft and expanded rows", async () => {
    const data = Array.from({ length: 6 }, (_, index) => ({
      object: { id: `object-${index}`, providerKey: "github", objectType: "pull_request", statusCategory: "running", statusTone: "info", liveness: "fresh", statusLabel: index === 1 ? "Provider RUNNING" : null, displayTitle: `Raw title ${index}`, sanitizedCanonicalUrl: `https://example.test/object/${index}` },
      mentions: [{ id: `mention-${index}`, sourceKind: "document", documentKey: "raw-plan-key", sanitizedDisplayUrl: `https://example.test/object/${index}` }],
      mentionCount: 1,
      sourceLabels: ["Document: raw-plan-key", "Document: custom-unmatched-key", "Custom source label"],
    }));
    client.setQueryData(queryKeys.instance.experimentalSettings, { enableExternalObjects: true });
    const key = queryKeys.externalObjects.byIssue("issue-raw");
    client.setQueryData(key, data);
    let current: IssueExternalObjectsResult | undefined;
    function Harness() {
      current = useIssueExternalObjects("issue-raw");
      return <>
        <div data-testid="sources">{current.groups[0]?.sourceLabels.join(" / ")}</div>
        <input aria-label="draft" defaultValue="User-owned draft" />
        <ExternalObjectRows externalObjects={current.groups} />
        <MarkdownBody externalReferences={current.markdownReferences}>{"```text\nRaw code that must keep wrapping\n```\n\n[own](https://example.test/object/0) and [custom](https://example.test/object/1)"}</MarkdownBody>
      </>;
    }
    await render(<Harness />);
    const refs = current!.markdownReferences;
    const rawGroup = current!.groups[0].group;
    const wrap = container.querySelector<HTMLButtonElement>(".paperclip-markdown-codeblock-wrap")!;
    const pre = container.querySelector("pre")!;
    const code = container.querySelector("pre code")!;
    const link = container.querySelector('[data-external-link="resolved"]')!;
    const expand = Array.from(container.querySelectorAll("button")).find((node) => /more/.test(node.textContent ?? ""))!;
    expect(expand).toBeDefined();
    await act(async () => { wrap.click(); expand.click(); });
    expect(container.querySelectorAll('[data-mention-kind="external-object"]')).toHaveLength(6);
    for (const language of ["ru", "en"] as const) {
      await locale(language);
      expect(current!.markdownReferences).toBe(refs);
      expect(current!.groups[0].group).toBe(rawGroup);
      expect(container.querySelector("pre")).toBe(pre);
      expect(container.querySelector("pre code")).toBe(code);
      expect(container.querySelector('[data-external-link="resolved"]')).toBe(link);
      expect(wrap.getAttribute("aria-pressed")).toBe("true");
      expect(pre.style.whiteSpace).toBe("pre-wrap");
      expect(container.querySelectorAll('[data-mention-kind="external-object"]')).toHaveLength(6);
      expect((container.querySelector('[aria-label="draft"]') as HTMLInputElement).value).toBe("User-owned draft");
      expect(current!.groups[0].sourceLabels).toEqual([`${language === "ru" ? "Документ" : "Document"}: raw-plan-key`, "Document: custom-unmatched-key", "Custom source label"]);
      expect(container.textContent).toContain("Provider RUNNING");
      expect(client.getQueryData(key)).toBe(data);
    }
    expect(api.list).not.toHaveBeenCalled();
    expect(api.experimental).not.toHaveBeenCalled();
  });
});
