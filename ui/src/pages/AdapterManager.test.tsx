// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { AdapterManager } from "./AdapterManager";

const state = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(), pushToast: vi.fn(),
  api: { list: vi.fn(), install: vi.fn(), reload: vi.fn(), reinstall: vi.fn(), remove: vi.fn(), setDisabled: vi.fn(), setOverridePaused: vi.fn() },
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { name: "Raw company name" } }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.setBreadcrumbs }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: state.pushToast }) }));
vi.mock("@/api/adapters", () => ({ adaptersApi: state.api }));
vi.mock("@/components/PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("@/adapters/dynamic-loader", () => ({ invalidateDynamicParser: vi.fn() }));
vi.mock("@/adapters/schema-config-fields", () => ({ invalidateConfigSchemaCache: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AdapterManager success message localization", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const type = "raw.adapter-type";
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ version: "9.9.9" }) }));
    const adapters = [{ type, label: "Custom adapter label", source: "external", packageName: "@raw/adapter-package", version: "0.1.0", loaded: true, disabled: false, modelsCount: 2 }];
    state.api.list.mockResolvedValue(adapters);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.adapters.all, adapters);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={client}><AdapterManager /></QueryClientProvider>));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.unstubAllGlobals();
    await i18n.changeLanguage("en");
  });

  function button(label: string) {
    const found = Array.from(document.body.querySelectorAll("button")).find((node) => node.textContent?.trim() === label);
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  }
  async function click(node: Element) {
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  async function input(id: string, value: string) {
    await act(async () => {
      const node = document.getElementById(id)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const cases = (["install", "reload", "reinstall"] as const).flatMap((action) =>
    (["en", "ru"] as const).flatMap((locale) => [undefined, "1.2.3-beta.4"].map((version) => ({ action, locale, version }))),
  );
  it.each(cases)("uses the current $locale locale for $action (version=$version), preserving IDs and drafts", async ({ action, locale, version }) => {
    state.api[action].mockResolvedValue({ type, version });
    if (action === "install") {
      await click(button("Install Adapter"));
      await input("adapterPackageName", "@raw/new-package");
      await input("adapterVersion", "next-custom-tag");
    }
    await act(async () => { await i18n.changeLanguage(locale); });
    if (action === "install") {
      expect((document.getElementById("adapterPackageName") as HTMLInputElement).value).toBe("@raw/new-package");
      expect((document.getElementById("adapterVersion") as HTMLInputElement).value).toBe("next-custom-tag");
      await click(button(i18n.t("pages.adapterManager.install")));
      expect(state.api.install).toHaveBeenCalledWith({ packageName: "@raw/new-package", version: "next-custom-tag", isLocalPath: false });
    } else {
      const title = i18n.t(action === "reload" ? "pages.adapterManager.reloadTitle" : "pages.adapterManager.reinstallTitle");
      const trigger = Array.from(container.querySelectorAll("button")).find((node) => node.title === title)!;
      await click(trigger);
      if (action === "reinstall") await click(button(i18n.t("pages.adapterManager.reinstall")));
      expect(state.api[action]).toHaveBeenCalledWith(type);
    }
    const verbs = { install: ["registered successfully", "зарегистрирован"], reload: ["reloaded", "перезагружен"], reinstall: ["updated from npm", "обновлён из npm"] };
    const expected = locale === "en" ? `Type "${type}" ${verbs[action][0]}.` : `Тип «${type}» ${verbs[action][1]}.`;
    expect(state.pushToast).toHaveBeenLastCalledWith(expect.objectContaining({ body: expected + (version ? ` (v${version})` : ""), tone: "success" }));
    expect(container.textContent).toContain("Custom adapter label");
    expect(container.textContent).toContain(locale === "en" ? "Alpha" : "Альфа");
    expect(state.api.remove).not.toHaveBeenCalled();
    expect(state.api.setDisabled).not.toHaveBeenCalled();
    expect(state.api.setOverridePaused).not.toHaveBeenCalled();
  });

  it("localizes only the separator between exact path examples and keeps a local path draft", async () => {
    await click(button("Install Adapter"));
    await click(button(i18n.t("pages.adapterManager.localPath")));
    await input("adapterLocalPath", "E:\\My Work\\adapter-package");
    const field = document.getElementById("adapterLocalPath") as HTMLInputElement;
    expect(field.placeholder).toBe("/mnt/e/Projects/my-adapter  or  E:\\Projects\\my-adapter");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(field.placeholder).toBe("/mnt/e/Projects/my-adapter  или  E:\\Projects\\my-adapter");
    expect(field.value).toBe("E:\\My Work\\adapter-package");
    expect(state.api.install).not.toHaveBeenCalled();
  });
});
