// @vitest-environment jsdom

import { act } from "react";
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

vi.mock("./PoliciesTab", () => ({
  PoliciesTab: () => <section>Policies tab</section>,
}));

vi.mock("./RuntimeTab", () => ({
  RuntimeTab: () => <section>Runtime tab</section>,
}));

vi.mock("./AuditTab", () => ({
  AuditTab: () => <section>Audit tab</section>,
}));

vi.mock("./PasteConfigTab", () => ({
  PasteConfigTab: () => <section>Paste tab</section>,
}));

vi.mock("./RunYourOwnTab", () => ({
  RunYourOwnTab: () => <section>Run your own tab</section>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

  it.each(["applications", "connections", "overview", "examples"])(
    "redirects retired %s tab links to All apps",
    async (tab) => {
      mockParams.tab = tab;
      await render();

      expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/apps", replace: true }));
    },
  );

  it("uses Profiles as the developer surface entry point", async () => {
    await render();

    expect(container.querySelector('a[href="/apps/advanced/profiles"]')?.textContent).toContain(
      "Open developer tools",
    );

    mockParams.tab = "profiles";
    await render();

    expect(container.textContent).toContain("Developer tools");
    expect(container.textContent).toContain("Tool profiles");
  });
});
