// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSkills } from "./PluginSkills";

const api = vi.hoisted(() => ({ published: vi.fn(), catalog: vi.fn(), installed: vi.fn() }));
vi.mock("@/api/mcpSkills", () => ({ mcpSkillsApi: { list: api.published } }));
vi.mock("@/api/companySkills", () => ({ companySkillsApi: { catalogList: api.catalog, list: api.installed, installCatalog: vi.fn() } }));

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

async function render(slug: string, connectionIds: string[]) {
  const host = document.createElement("div");
  document.body.append(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PluginSkills companyId="company-1" slug={slug} name="Linear" connectionIds={connectionIds} onNavigate={() => {}} />
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { host, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("PluginSkills", () => {
  it("renders nothing when a connector has no skills", async () => {
    api.published.mockResolvedValue([]);
    const view = await render("linear", ["connection-1"]);
    expect(view.host.textContent).toBe("");
    await view.unmount();
  });

  it("shows a failed read with a retry, where it used to show nothing", async () => {
    api.published.mockRejectedValue(new Error("boom"));
    const view = await render("linear", ["connection-1"]);
    expect(view.host.textContent).toContain("Skills");
    expect([...view.host.querySelectorAll("button")].some((button) => button.textContent?.includes("Retry"))).toBe(true);
    await view.unmount();
  });

  it("ignores a failed read that this plugin does not use", async () => {
    api.catalog.mockRejectedValue(new Error("boom"));
    api.installed.mockRejectedValue(new Error("boom"));
    const github = await render("github", []);
    expect(github.host.textContent).toContain("Skills");
    await github.unmount();
    api.published.mockResolvedValue([]);
    const linear = await render("linear", ["connection-1"]);
    expect(linear.host.textContent).toBe("");
    await linear.unmount();
  });

  it("does not offer Add skill while the installed list failed to load", async () => {
    api.catalog.mockResolvedValue([{ id: "paperclipai:bundled:software-development:github-pr-workflow", key: "github-pr-workflow", name: "github-pr-workflow", description: "Prepare a pull request." }]);
    api.installed.mockRejectedValue(new Error("boom"));
    const view = await render("github", []);
    expect(view.host.textContent).toContain("github-pr-workflow");
    expect(view.host.textContent).not.toContain("Add skill");
    expect([...view.host.querySelectorAll("button")].some((button) => button.textContent?.includes("Retry"))).toBe(true);
    await view.unmount();
  });
});
