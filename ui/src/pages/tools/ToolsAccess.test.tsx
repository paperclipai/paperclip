// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolsAccess } from "./ToolsAccess";

const mockParams = vi.hoisted(() => ({ tab: undefined as string | undefined }));
const navigateMock = vi.hoisted(() => vi.fn(({ to }: { to: string }) => <div data-navigate={to} />));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  Navigate: (props: { to: string; replace?: boolean }) => navigateMock(props),
  useParams: () => mockParams,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("./profiles/ProfilesIndex", () => ({
  ProfilesIndex: () => <section>Tool profiles</section>,
}));

vi.mock("./PasteConfigTab", () => ({
  PasteConfigTab: () => <section>Paste tab</section>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("ToolsAccess", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockParams.tab = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    await act(async () => {
      root.render(<ToolsAccess />);
      await flushReact();
    });
  }

  it.each(["applications", "connections", "overview", "examples", "audit"])(
    "redirects retired %s tab links to Connectors",
    async (tab) => {
      mockParams.tab = tab;
      await render();

      expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/apps", replace: true }));
    },
  );

  it.each([
    ["runtime", "/apps"],
    ["policies", "/apps/advanced/profiles"],
    ["run-your-own", "/apps"],
  ])("redirects the retired %s page to %s", async (tab, target) => {
    mockParams.tab = tab;
    await render();

    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ to: target, replace: true }));
  });

  it("uses Paste a config as the only advanced setup page", async () => {
    await render();

    expect(container.textContent).toContain("Paste tab");
    expect(container.textContent).not.toContain("Run your own");
    expect(container.querySelector('a[href="/apps/advanced/paste-config"]')).toBeTruthy();
  });

  it("uses Profiles as the developer entry point without a second page shell", async () => {
    await render();

    expect(container.querySelector('a[href="/apps/advanced/profiles"]')?.textContent).toContain(
      "Open developer tools",
    );

    mockParams.tab = "profiles";
    await render();

    expect(container.textContent).not.toContain("Developer tools");
    expect(container.textContent).toContain("Tool profiles");
    expect(container.firstElementChild?.classList.contains("max-w-5xl")).toBe(true);
  });
});
