// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTasksRail } from "./ProjectTasksRail";

const quickLinksApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  preview: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const projectContextApiMock = vi.hoisted(() => ({
  overview: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/projectQuickLinks", () => ({
  projectQuickLinksApi: quickLinksApiMock,
}));

vi.mock("../api/projectContext", () => ({
  projectContextApi: projectContextApiMock,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastMock,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function buildQuickLink(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    companyId: "company-1",
    projectId: "project-1",
    title: "Docs",
    url: "https://docs.example.com/runbook",
    siteName: null,
    description: null,
    imageUrl: null,
    faviconUrl: null,
    metadataFetchedAt: null,
    position: 0,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildContextOverview() {
  return {
    profile: {
      id: "profile-1",
      companyId: "company-1",
      projectId: "project-1",
      goalMarkdown: "## Ship a focused project goal for agents and board task review.",
      instructionsMarkdown: "## Follow current project instructions before changing code.",
      defaultSkillKeys: ["design-guide", "frontend", "qa", "release"],
      retrievalEnabled: true,
      maxBundleChars: 12_000,
      maxChunks: 8,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    sources: [
      buildQuickLink({ id: "source-ready", sourceType: "manual", status: "ready", itemCount: 1, chunkCount: 2 }),
      buildQuickLink({ id: "source-error", sourceType: "manual", status: "error", itemCount: 0, chunkCount: 0 }),
    ],
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function blurInput(input: HTMLInputElement) {
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderRail() {
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
        <ProjectTasksRail companyId="company-1" projectId="project-1" projectRef="paperclip-project" />
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  quickLinksApiMock.list.mockReset();
  quickLinksApiMock.create.mockReset();
  quickLinksApiMock.preview.mockReset();
  quickLinksApiMock.update.mockReset();
  quickLinksApiMock.remove.mockReset();
  projectContextApiMock.overview.mockReset();
  toastMock.pushToast.mockReset();
  quickLinksApiMock.list.mockResolvedValue([buildQuickLink()]);
  quickLinksApiMock.create.mockResolvedValue(buildQuickLink({ id: "link-2", title: "Board" }));
  quickLinksApiMock.preview.mockResolvedValue({
    url: "https://board.example.com",
    title: "Board Preview",
    siteName: "Board",
    description: "Planning board",
    imageUrl: "https://board.example.com/og.png",
    faviconUrl: "https://board.example.com/favicon.ico",
  });
  quickLinksApiMock.update.mockResolvedValue(buildQuickLink({ title: "Runbook" }));
  quickLinksApiMock.remove.mockResolvedValue(buildQuickLink());
  projectContextApiMock.overview.mockResolvedValue(buildContextOverview());
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

describe("ProjectTasksRail", () => {
  it("renders quick links and an abbreviated context overview", async () => {
    quickLinksApiMock.list.mockResolvedValue([
      buildQuickLink({
        siteName: "Docs Site",
        description: "Operational runbooks and project notes",
        imageUrl: "https://docs.example.com/og.png",
        faviconUrl: "https://docs.example.com/favicon.ico",
        metadataFetchedAt: new Date(),
      }),
    ]);
    await renderRail();

    expect(container?.textContent).toContain("Quick Links");
    expect(container?.textContent).toContain("Docs");
    expect(container?.textContent).toContain("Docs Site");
    expect(container?.textContent).toContain("Operational runbooks");
    expect(container?.textContent).toContain("Context Overview");
    expect(container?.textContent).toContain("Project Goal");
    expect(container?.textContent).toContain("Ship a focused project goal");
    expect(container?.textContent).toContain("Follow current project instructions");
    expect(container?.textContent).toContain("4 skills");
    expect(container?.textContent).toContain("2 sources");

    const contextLink = container?.querySelector('a[href="/projects/paperclip-project/context"]');
    expect(contextLink).not.toBeNull();
  });

  it("hides context marker comments from the overview excerpt", async () => {
    projectContextApiMock.overview.mockResolvedValue({
      ...buildContextOverview(),
      profile: {
        ...buildContextOverview().profile,
        goalMarkdown: "",
        instructionsMarkdown: [
          "<!-- codesm-client-import:start -->",
          "## CodeSM Client Access",
          "",
          "Client details:",
          "- Client: Edinburg Chamber",
          "<!-- codesm-client-import:end -->",
        ].join("\n"),
      },
    });
    await renderRail();

    expect(container?.textContent).toContain("CodeSM Client Access");
    expect(container?.textContent).toContain("Client details");
    expect(container?.textContent).not.toContain("codesm-client-import");
    expect(container?.textContent).not.toContain("codesm-client-import:start");
    expect(container?.textContent).not.toContain("codesm-client-import:end");
  });

  it("adds quick links inline", async () => {
    quickLinksApiMock.list.mockResolvedValue([]);
    await renderRail();

    const openButton = container?.querySelector('button[aria-label="Add quick link"]') as HTMLButtonElement | null;
    await act(async () => {
      openButton?.click();
    });

    const nameInput = container?.querySelector('input[aria-label="Quick link name"]') as HTMLInputElement | null;
    const urlInput = container?.querySelector('input[aria-label="Quick link URL"]') as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    expect(urlInput).not.toBeNull();

    await act(async () => {
      setInputValue(nameInput!, "Board");
      setInputValue(urlInput!, "https://board.example.com");
    });

    const addButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Add",
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      addButton?.click();
    });
    await flush();

    expect(quickLinksApiMock.create).toHaveBeenCalledWith("company-1", "project-1", {
      title: "Board",
      url: "https://board.example.com",
    });
    expect(toastMock.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Quick link added" }));
  });

  it("adds Apple Note quick links without fetching web preview metadata", async () => {
    quickLinksApiMock.list.mockResolvedValue([]);
    await renderRail();

    const openButton = container?.querySelector('button[aria-label="Add Apple Note"]') as HTMLButtonElement | null;
    await act(async () => {
      openButton?.click();
    });

    const nameInput = container?.querySelector('input[aria-label="Quick link name"]') as HTMLInputElement | null;
    const urlInput = container?.querySelector('input[aria-label="Quick link URL"]') as HTMLInputElement | null;
    expect(nameInput?.value).toBe("Apple Note");

    await act(async () => {
      setInputValue(nameInput!, "Design note");
      setInputValue(urlInput!, "applenotes://showNote?identifier=ABCDEF");
      blurInput(urlInput!);
    });
    await flush();

    const addButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Add",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      addButton?.click();
    });
    await flush();

    expect(quickLinksApiMock.preview).not.toHaveBeenCalled();
    expect(quickLinksApiMock.create).toHaveBeenCalledWith("company-1", "project-1", {
      title: "Design note",
      url: "applenotes://showNote?identifier=ABCDEF",
    });
  });

  it("shows Apple Note labels for saved Notes quick links", async () => {
    quickLinksApiMock.list.mockResolvedValue([
      buildQuickLink({
        title: "Design note",
        url: "https://www.icloud.com/notes/0123456789#SharedNote",
      }),
    ]);
    await renderRail();

    expect(container?.textContent).toContain("Design note");
    expect(container?.textContent).toContain("Apple Note");
  });

  it("previews URL details before adding and submits saved metadata", async () => {
    quickLinksApiMock.list.mockResolvedValue([]);
    await renderRail();

    const openButton = container?.querySelector('button[aria-label="Add quick link"]') as HTMLButtonElement | null;
    await act(async () => {
      openButton?.click();
    });

    const nameInput = container?.querySelector('input[aria-label="Quick link name"]') as HTMLInputElement;
    const urlInput = container?.querySelector('input[aria-label="Quick link URL"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(urlInput, "https://board.example.com");
      blurInput(urlInput);
    });
    await flush();

    expect(quickLinksApiMock.preview).toHaveBeenCalledWith("company-1", "project-1", {
      url: "https://board.example.com",
    });
    expect(nameInput.value).toBe("Board Preview");
    expect(container?.textContent).toContain("Planning board");

    const addButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Add",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      addButton?.click();
    });
    await flush();

    expect(quickLinksApiMock.create).toHaveBeenCalledWith("company-1", "project-1", {
      title: "Board Preview",
      url: "https://board.example.com",
      siteName: "Board",
      description: "Planning board",
      imageUrl: "https://board.example.com/og.png",
      faviconUrl: "https://board.example.com/favicon.ico",
    });
  });

  it("does not overwrite a manually edited title when preview resolves", async () => {
    quickLinksApiMock.list.mockResolvedValue([]);
    await renderRail();

    const openButton = container?.querySelector('button[aria-label="Add quick link"]') as HTMLButtonElement | null;
    await act(async () => {
      openButton?.click();
    });

    const nameInput = container?.querySelector('input[aria-label="Quick link name"]') as HTMLInputElement;
    const urlInput = container?.querySelector('input[aria-label="Quick link URL"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(nameInput, "Manual title");
      setInputValue(urlInput, "https://board.example.com");
      blurInput(urlInput);
    });
    await flush();

    expect(nameInput.value).toBe("Manual title");
  });

  it("shows preview errors without blocking plain link saving", async () => {
    quickLinksApiMock.list.mockResolvedValue([]);
    quickLinksApiMock.preview.mockRejectedValue(new Error("Preview failed"));
    await renderRail();

    const openButton = container?.querySelector('button[aria-label="Add quick link"]') as HTMLButtonElement | null;
    await act(async () => {
      openButton?.click();
    });

    const nameInput = container?.querySelector('input[aria-label="Quick link name"]') as HTMLInputElement;
    const urlInput = container?.querySelector('input[aria-label="Quick link URL"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(nameInput, "Board");
      setInputValue(urlInput, "https://board.example.com");
      blurInput(urlInput);
    });
    await flush();

    expect(container?.textContent).toContain("Preview failed");

    const addButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Add",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      addButton?.click();
    });
    await flush();

    expect(quickLinksApiMock.create).toHaveBeenCalledWith("company-1", "project-1", {
      title: "Board",
      url: "https://board.example.com",
    });
  });

  it("edits and removes quick links inline", async () => {
    await renderRail();

    const editButton = container?.querySelector('button[aria-label="Edit Docs"]') as HTMLButtonElement | null;
    await act(async () => {
      editButton?.click();
    });

    const nameInput = container?.querySelector('input[aria-label="Quick link name"]') as HTMLInputElement | null;
    const urlInput = container?.querySelector('input[aria-label="Quick link URL"]') as HTMLInputElement | null;
    await act(async () => {
      setInputValue(nameInput!, "Runbook");
      setInputValue(urlInput!, "https://docs.example.com/runbook-v2");
    });

    const saveButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Save",
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      saveButton?.click();
    });
    await flush();

    expect(quickLinksApiMock.update).toHaveBeenCalledWith("company-1", "project-1", "link-1", {
      title: "Runbook",
      url: "https://docs.example.com/runbook-v2",
    });

    const removeButton = container?.querySelector('button[aria-label="Remove Docs"]') as HTMLButtonElement | null;
    await act(async () => {
      removeButton?.click();
    });
    await flush();

    expect(quickLinksApiMock.remove).toHaveBeenCalledWith("company-1", "project-1", "link-1");
  });
});
