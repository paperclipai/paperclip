// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  listRoutines: vi.fn(),
}));

vi.mock("../api/companySkills", () => ({ companySkillsApi: { list: mocks.listSkills } }));
vi.mock("../api/routines", () => ({ routinesApi: { list: mocks.listRoutines } }));
vi.mock("./CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));

import { EditorAutocompleteProvider, useEditorAutocomplete } from "./EditorAutocompleteContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("EditorAutocompleteProvider", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    mocks.listSkills.mockReset().mockResolvedValue([
      { id: "skill-1", key: "deploy", name: "Deploy", slug: "deploy", description: null },
    ]);
    mocks.listRoutines.mockReset().mockResolvedValue([
      { id: "routine-1", title: "Nightly", status: "active" },
      { id: "routine-2", title: "Old", status: "archived" },
    ]);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  it("does not read skills or routines until an editor asks for slash commands", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <EditorAutocompleteProvider>
            <p>Mine inbox without an editor</p>
          </EditorAutocompleteProvider>
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(mocks.listSkills).not.toHaveBeenCalled();
    expect(mocks.listRoutines).not.toHaveBeenCalled();
  });

  it("reads both lists once when editors mount and exposes the commands", async () => {
    const seen: string[][] = [];
    function Editor() {
      const { slashCommands } = useEditorAutocomplete();
      seen.push(slashCommands.map((command) => command.id));
      return null;
    }

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <EditorAutocompleteProvider>
            <Editor />
            <Editor />
          </EditorAutocompleteProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["skill:skill-1", "routine:routine-1"]));
    expect(mocks.listSkills).toHaveBeenCalledTimes(1);
    expect(mocks.listSkills).toHaveBeenCalledWith("company-1");
    expect(mocks.listRoutines).toHaveBeenCalledTimes(1);
  });
});
