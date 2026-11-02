// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { PayloadTemplateJsonField } from "@/adapters/runtime-json-fields";
import { AgentIconPicker } from "./AgentIconPicker";
import { CompanyPatternIcon } from "./CompanyPatternIcon";
import { ModeBadge } from "./access/ModeBadge";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
} from "./ui/breadcrumb";
import { TooltipProvider } from "./ui/tooltip";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("final-audit display localization", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
    vi.restoreAllMocks();
  });

  async function render(children: ReactNode) {
    await act(async () => root.render(<TooltipProvider>{children}</TooltipProvider>));
  }

  async function language(locale: "en" | "ru") {
    await act(async () => { await i18n.changeLanguage(locale); });
  }

  async function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it.each([
    { deploymentMode: "local_trusted", deploymentExposure: undefined, en: "Local trusted", ru: "Доверенный локальный режим" },
    { deploymentMode: "authenticated", deploymentExposure: "private", en: "Authenticated private", ru: "Закрытый доступ с аутентификацией" },
    { deploymentMode: "authenticated", deploymentExposure: "public", en: "Authenticated public", ru: "Публичный доступ с аутентификацией" },
    { deploymentMode: "authenticated", deploymentExposure: undefined, en: "Authenticated private", ru: "Закрытый доступ с аутентификацией" },
  ] as const)("updates $deploymentMode/$deploymentExposure without changing raw mode props", async ({ deploymentMode, deploymentExposure, en, ru }) => {
    const props = Object.freeze({ deploymentMode, deploymentExposure });
    const original = JSON.stringify(props);
    await render(<ModeBadge {...props} />);
    const badge = container.firstElementChild;
    expect(badge?.textContent).toBe(en);

    await language("ru");
    expect(container.firstElementChild).toBe(badge);
    expect(badge?.textContent).toBe(ru);
    expect(JSON.stringify(props)).toBe(original);

    await language("en");
    expect(container.firstElementChild).toBe(badge);
    expect(badge?.textContent).toBe(en);
    expect(JSON.stringify(props)).toBe(original);
  });

  it("does not invent a badge when the deployment mode is absent", async () => {
    await render(<ModeBadge />);
    expect(container.textContent).toBe("");
    await language("ru");
    expect(container.textContent).toBe("");
    await language("en");
    expect(container.textContent).toBe("");
  });

  it("updates default breadcrumb accessibility text but preserves caller labels, links, IDs and callbacks", async () => {
    const onNavigate = vi.fn();
    await render(<>
      <Breadcrumb id="route-company-1">
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink href="/PAP/issues/raw-issue-1" onClick={(event) => { event.preventDefault(); onNavigate("raw-issue-1"); }}>Raw team name</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbItem><BreadcrumbEllipsis /></BreadcrumbItem>
          <BreadcrumbItem><BreadcrumbPage>Custom English title</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Breadcrumb aria-label="Customer-owned breadcrumb" id="custom-navigation" />
    </>);
    const navigation = container.querySelector("#route-company-1")!;
    const customNavigation = container.querySelector("#custom-navigation")!;
    const link = navigation.querySelector("a")!;
    const ellipsis = navigation.querySelector('[data-slot="breadcrumb-ellipsis"]')!;
    for (const [locale, label, more] of [
      ["en", "breadcrumb", "More"],
      ["ru", "Навигационная цепочка", "Ещё"],
      ["en", "breadcrumb", "More"],
    ] as const) {
      await language(locale);
      expect(container.querySelector("#route-company-1")).toBe(navigation);
      expect(navigation.getAttribute("aria-label")).toBe(label);
      expect(ellipsis.textContent).toBe(more);
      expect(customNavigation.getAttribute("aria-label")).toBe("Customer-owned breadcrumb");
      expect(navigation.querySelector("a")).toBe(link);
      expect(link.getAttribute("href")).toBe("/PAP/issues/raw-issue-1");
      expect(link.textContent).toBe("Raw team name");
      expect(navigation.querySelector('[aria-current="page"]')?.textContent).toBe("Custom English title");
      expect(onNavigate).not.toHaveBeenCalled();
    }
    await act(async () => link.click());
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("raw-issue-1");
  });

  it("updates a custom company logo alt without changing its URL or resetting an image error", async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const props = Object.freeze({ companyName: "Read & Write <Labs>", logoUrl: "/api/companies/raw-company-1/logo", logoFit: "contain" as const });
    await render(<CompanyPatternIcon {...props} />);
    const logo = container.querySelector("img")!;
    for (const [locale, alt] of [
      ["en", "Read & Write <Labs> logo"],
      ["ru", "Логотип организации «Read & Write <Labs>»"],
      ["en", "Read & Write <Labs> logo"],
    ] as const) {
      await language(locale);
      expect(container.querySelector("img")).toBe(logo);
      expect(logo.alt).toBe(alt);
      expect(logo.getAttribute("src")).toBe(props.logoUrl);
      expect(logo.classList.contains("object-contain")).toBe(true);
      expect(getContext).toHaveBeenCalledTimes(1);
    }
    await act(async () => logo.dispatchEvent(new Event("error")));
    const fallback = container.querySelector("span");
    expect(fallback?.textContent).toBe("R");
    for (const locale of ["ru", "en"] as const) {
      await language(locale);
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("span")).toBe(fallback);
      expect(fallback?.textContent).toBe("R");
      expect(getContext).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves an unfinished JSON draft and only submits the original protocol fields", async () => {
    const mark = vi.fn();
    const config = Object.freeze({ payloadTemplate: Object.freeze({ agentId: "remote-agent-123", team: "platform" }) });
    const original = JSON.stringify(config);
    await render(<PayloadTemplateJsonField isCreate={false} values={null} set={null} config={config} mark={mark} />);
    const textarea = container.querySelector("textarea")!;
    const placeholder = textarea.placeholder;
    expect(textarea.value).toBe(JSON.stringify(config.payloadTemplate, null, 2));
    expect(container.querySelector("label")?.textContent).toContain("Payload template JSON");
    const draft = '{"agentId":"new-remote-agent-456", "metadata":';
    await inputValue(textarea, draft);
    for (const [locale, label] of [
      ["en", "Payload template JSON"],
      ["ru", "Шаблон тела запроса в формате JSON"],
      ["en", "Payload template JSON"],
    ] as const) {
      await language(locale);
      expect(container.querySelector("label")?.textContent).toContain(label);
      expect(container.querySelector("textarea")).toBe(textarea);
      expect(textarea.value).toBe(draft);
      expect(textarea.placeholder).toBe(placeholder);
      expect(JSON.stringify(config)).toBe(original);
      expect(mark).not.toHaveBeenCalled();
    }
    const payload = { agentId: "new-remote-agent-456", metadata: { team: "English platform", userLabel: "Do not translate" } };
    await inputValue(textarea, JSON.stringify(payload));
    expect(mark).toHaveBeenCalledExactlyOnceWith("adapterConfig", "payloadTemplate", payload);
    expect(JSON.stringify(config)).toBe(original);
  });

  it("updates icon search and empty-state text while keeping the popover, query and selected raw icon", async () => {
    const onChange = vi.fn();
    await render(<AgentIconPicker value="bot" onChange={onChange}><button type="button">Pick a raw icon</button></AgentIconPicker>);
    const trigger = container.querySelector("button")!;
    await act(async () => trigger.click());
    const popover = document.querySelector('[data-slot="popover-content"]')!;
    const input = popover.querySelector("input")!;
    const popoverId = popover.id;
    const selected = popover.querySelector<HTMLButtonElement>('button[title="bot"]')!;
    expect(selected.className).toContain("ring-1");
    expect(input.placeholder).toBe("Search icons...");
    const query = "CustomerOwnedUnmatchedValue";
    await inputValue(input, query);
    for (const [locale, placeholder, empty] of [
      ["en", "Search icons...", "No icons match"],
      ["ru", "Найти значок…", "Подходящих значков нет"],
      ["en", "Search icons...", "No icons match"],
    ] as const) {
      await language(locale);
      expect(document.querySelector('[data-slot="popover-content"]')).toBe(popover);
      expect(popover.id).toBe(popoverId);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(popover.querySelector("input")).toBe(input);
      expect(input.value).toBe(query);
      expect(input.placeholder).toBe(placeholder);
      expect(popover.textContent).toContain(empty);
      expect(onChange).not.toHaveBeenCalled();
    }
    await inputValue(input, "bot");
    const result = popover.querySelector<HTMLButtonElement>('button[title="bot"]')!;
    expect(result.className).toContain("ring-1");
    await act(async () => result.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("bot");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
