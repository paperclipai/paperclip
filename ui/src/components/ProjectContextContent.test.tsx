// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextSource, ProjectContextOverview } from "@paperclipai/shared";
import {
  extractLegacyCodesmClientImport,
  ProjectContextContent,
  ProjectSourceContent,
} from "./ProjectContextContent";

const projectContextApiMock = vi.hoisted(() => ({
  overview: vi.fn(),
  updateProfile: vi.fn(),
  createSource: vi.fn(),
  uploadSourceFile: vi.fn(),
  syncSource: vi.fn(),
  deleteSource: vi.fn(),
  search: vi.fn(),
}));

const companySkillsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

vi.mock("../api/projectContext", () => ({
  projectContextApi: projectContextApiMock,
}));

vi.mock("../api/companySkills", () => ({
  companySkillsApi: companySkillsApiMock,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastMock,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let currentOverview: ProjectContextOverview;

function buildSource(overrides: Partial<ContextSource> = {}): ContextSource {
  return {
    id: "source-1",
    companyId: "company-1",
    projectId: "project-1",
    sourceType: "manual",
    provider: null,
    title: "Imported client source",
    uri: null,
    status: "ready",
    statusMessage: null,
    assetId: null,
    externalId: null,
    metadata: null,
    lastSyncedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    itemCount: 1,
    chunkCount: 2,
    createdAt: new Date("2026-04-20T12:00:00Z"),
    updatedAt: new Date("2026-04-20T12:00:00Z"),
    ...overrides,
  };
}

function buildOverview(overrides: Partial<ProjectContextOverview> = {}): ProjectContextOverview {
  return {
    profile: {
      id: "profile-1",
      companyId: "company-1",
      projectId: "project-1",
      goalMarkdown: "",
      instructionsMarkdown: "",
      defaultSkillKeys: [],
      retrievalEnabled: true,
      maxBundleChars: 12_000,
      maxChunks: 8,
      metadata: null,
      createdAt: new Date("2026-04-20T12:00:00Z"),
      updatedAt: new Date("2026-04-20T12:00:00Z"),
    },
    sources: [],
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForExpectation(assertion: () => void) {
  let lastError: unknown;
  for (let index = 0; index < 12; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

async function renderComponent(component: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        {component}
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  currentOverview = buildOverview();
  projectContextApiMock.overview.mockReset();
  projectContextApiMock.updateProfile.mockReset();
  projectContextApiMock.createSource.mockReset();
  projectContextApiMock.uploadSourceFile.mockReset();
  projectContextApiMock.syncSource.mockReset();
  projectContextApiMock.deleteSource.mockReset();
  projectContextApiMock.search.mockReset();
  companySkillsApiMock.list.mockReset();
  toastMock.pushToast.mockReset();

  projectContextApiMock.overview.mockImplementation(async () => currentOverview);
  projectContextApiMock.updateProfile.mockImplementation(async (_companyId: string, _projectId: string, payload: Record<string, unknown>) => {
    currentOverview = {
      ...currentOverview,
      profile: {
        ...currentOverview.profile,
        ...payload,
        updatedAt: new Date("2026-04-20T12:05:00Z"),
      },
    };
    return currentOverview.profile;
  });
  projectContextApiMock.createSource.mockImplementation(async (_companyId: string, _projectId: string, payload: Record<string, unknown>) => {
    const source = buildSource({
      id: `source-${currentOverview.sources.length + 1}`,
      title: String(payload.title),
      sourceType: payload.sourceType as ContextSource["sourceType"],
      metadata: payload.metadata as Record<string, unknown> | null,
    });
    currentOverview = {
      ...currentOverview,
      sources: [...currentOverview.sources, source],
    };
    return source;
  });
  projectContextApiMock.syncSource.mockResolvedValue(buildSource());
  projectContextApiMock.deleteSource.mockResolvedValue(buildSource());
  projectContextApiMock.search.mockResolvedValue([]);
  companySkillsApiMock.list.mockResolvedValue([]);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("Project context source migration", () => {
  it("extracts a marked CodeSM import block without marker comments", () => {
    const extracted = extractLegacyCodesmClientImport([
      "Keep this instruction.",
      "<!-- codesm-client-import:start -->",
      "Access Source: Paperclip 260419, row 22",
      "Client: NIU",
      "<!-- codesm-client-import:end -->",
      "Keep this too.",
    ].join("\n"));

    expect(extracted).toEqual({
      bodyText: "Access Source: Paperclip 260419, row 22\nClient: NIU",
      remainingInstructionsMarkdown: "Keep this instruction.\n\nKeep this too.",
    });
  });

  it("moves a marked import block into one manual source and clears custom instructions", async () => {
    currentOverview = buildOverview({
      profile: {
        ...buildOverview().profile,
        instructionsMarkdown: [
          "<!-- codesm-client-import:start -->",
          "Access Source: Paperclip 260419, row 22",
          "Client: NIU",
          "<!-- codesm-client-import:end -->",
        ].join("\n"),
      },
    });

    await renderComponent(<ProjectContextContent companyId="company-1" projectId="project-1" />);

    await waitForExpectation(() => {
      expect(projectContextApiMock.createSource).toHaveBeenCalledTimes(1);
      expect(projectContextApiMock.updateProfile).toHaveBeenCalledWith("company-1", "project-1", {
        instructionsMarkdown: "",
      });
    });

    const sourcePayload = projectContextApiMock.createSource.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(sourcePayload).toMatchObject({
      sourceType: "manual",
      title: "Imported client source",
      bodyText: "Access Source: Paperclip 260419, row 22\nClient: NIU",
      metadata: {
        migratedFrom: "project_instructions",
        migrationKey: "codesm-client-import",
      },
    });
    await waitForExpectation(() => {
      const textareas = Array.from(container?.querySelectorAll("textarea") ?? []);
      expect((textareas[1] as HTMLTextAreaElement).value).toBe("");
    });
    await flush();
    expect(projectContextApiMock.createSource).toHaveBeenCalledTimes(1);
  });

  it("does not create a duplicate migrated source when one already exists", async () => {
    currentOverview = buildOverview({
      profile: {
        ...buildOverview().profile,
        instructionsMarkdown: [
          "<!-- codesm-client-import:start -->",
          "Client: NIU",
          "<!-- codesm-client-import:end -->",
        ].join("\n"),
      },
      sources: [
        buildSource({
          metadata: {
            migratedFrom: "project_instructions",
            migrationKey: "codesm-client-import",
          },
        }),
      ],
    });

    await renderComponent(<ProjectContextContent companyId="company-1" projectId="project-1" />);

    await waitForExpectation(() => {
      expect(projectContextApiMock.updateProfile).toHaveBeenCalledWith("company-1", "project-1", {
        instructionsMarkdown: "",
      });
    });
    expect(projectContextApiMock.createSource).not.toHaveBeenCalled();
  });
});

describe("ProjectSourceContent", () => {
  it("renders source controls and dispatches source actions", async () => {
    currentOverview = buildOverview({
      sources: [buildSource()],
    });
    projectContextApiMock.search.mockResolvedValue([
      {
        chunkId: "chunk-1",
        sourceId: "source-1",
        itemId: "item-1",
        sourceTitle: "Imported client source",
        itemTitle: "Imported client source",
        uri: null,
        content: "Client: NIU",
        rank: 1,
      },
    ]);

    await renderComponent(<ProjectSourceContent companyId="company-1" projectId="project-1" />);

    expect(container?.textContent).toContain("Source retrieval");
    expect(container?.textContent).toContain("8 snippets, 12,000 chars");
    expect(container?.textContent).toContain("Google Drive");
    expect(container?.textContent).toContain("Manual");
    expect(container?.textContent).toContain("Imported client source");
    expect(container?.querySelector('button[title="Sync"]')).not.toBeNull();
    expect(container?.querySelector('button[title="Remove"]')).not.toBeNull();

    await act(async () => {
      (container?.querySelector('button[role="switch"]') as HTMLButtonElement).click();
    });
    await waitForExpectation(() => {
      expect(projectContextApiMock.updateProfile.mock.calls).toContainEqual(
        expect.arrayContaining(["company-1", "project-1", { retrievalEnabled: false }]),
      );
    });

    await act(async () => {
      (container?.querySelector('button[title="Sync"]') as HTMLButtonElement).click();
      (container?.querySelector('button[title="Remove"]') as HTMLButtonElement).click();
    });
    await waitForExpectation(() => {
      expect(projectContextApiMock.syncSource).toHaveBeenCalledWith("company-1", "source-1");
      expect(projectContextApiMock.deleteSource).toHaveBeenCalledWith("company-1", "source-1");
    });

    const searchInput = Array.from(container?.querySelectorAll("input") ?? []).find(
      (input) => input.getAttribute("placeholder") === "Search indexed project context...",
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(searchInput, "NIU");
    });
    const searchButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Search",
    ) as HTMLButtonElement;
    await act(async () => {
      searchButton.click();
    });
    await waitForExpectation(() => {
      expect(projectContextApiMock.search).toHaveBeenCalledWith("company-1", "project-1", "NIU", 8);
      expect(container?.textContent).toContain("Client: NIU");
    });
  });
});
