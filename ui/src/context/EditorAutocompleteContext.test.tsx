// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorAutocompleteProvider, useEditorAutocomplete } from "./EditorAutocompleteContext";

const mockCompanySkillsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockPipelinesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockRoutinesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/companySkills", () => ({
  companySkillsApi: mockCompanySkillsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/pipelines", () => ({
  pipelinesApi: mockPipelinesApi,
}));

vi.mock("../api/routines", () => ({
  routinesApi: mockRoutinesApi,
}));

vi.mock("./CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

function CommandIds() {
  const { slashCommands } = useEditorAutocomplete();
  return <div>{slashCommands.map((command) => command.id).join(",")}</div>;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("EditorAutocompleteProvider", () => {
  let container: HTMLDivElement;

  async function renderProvider() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <EditorAutocompleteProvider>
            <CommandIds />
          </EditorAutocompleteProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    return root;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompanySkillsApi.list.mockResolvedValue([]);
    mockRoutinesApi.list.mockResolvedValue([]);
    mockPipelinesApi.list.mockResolvedValue([
      {
        id: "pipeline-1",
        key: "content",
        name: "Content",
        archivedAt: null,
        stages: [],
      },
    ]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does not fetch or suggest pipelines when the pipelines flag is disabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enablePipelines: false });
    const root = await renderProvider();

    expect(mockPipelinesApi.list).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("pipeline:pipeline-1");

    flushSync(() => {
      root.unmount();
    });
  });

  it("suggests pipelines when the pipelines flag is enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enablePipelines: true });
    const root = await renderProvider();

    expect(mockPipelinesApi.list).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("pipeline:pipeline-1");

    flushSync(() => {
      root.unmount();
    });
  });
});
