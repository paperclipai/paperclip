// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyDocuments } from "./CompanyDocuments";

const navigateMock = vi.fn();
const listDocumentsMock = vi.fn();
const createDocumentMock = vi.fn();
const updateDocumentMock = vi.fn();
const listDocumentRevisionsMock = vi.fn();
const restoreDocumentRevisionMock = vi.fn();
const deleteDocumentMock = vi.fn();
const pushToastMock = vi.fn();

let currentDocumentId: string | undefined;

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({ documentId: currentDocumentId }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Nuviya" },
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("../api/companies", () => ({
  companiesApi: {
    listDocuments: (...args: unknown[]) => listDocumentsMock(...args),
    createDocument: (...args: unknown[]) => createDocumentMock(...args),
    updateDocument: (...args: unknown[]) => updateDocumentMock(...args),
    listDocumentRevisions: (...args: unknown[]) => listDocumentRevisionsMock(...args),
    restoreDocumentRevision: (...args: unknown[]) => restoreDocumentRevisionMock(...args),
    deleteDocument: (...args: unknown[]) => deleteDocumentMock(...args),
  },
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="markdown-editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message, action, onAction }: { message: string; action?: string; onAction?: () => void }) => (
    <div>
      <div>{message}</div>
      {action ? <button type="button" onClick={onAction}>{action}</button> : null}
    </div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, type = "button", variant, size, ...props }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type={type} onClick={onClick} disabled={disabled} data-variant={variant} data-size={size} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createDocument() {
  return {
    id: "document-1",
    companyId: "company-1",
    title: "Nuviya Stage Tone Profiles",
    format: "markdown" as const,
    body: "# Tone profile",
    latestRevisionId: "revision-2",
    latestRevisionNumber: 2,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    createdAt: new Date("2026-04-12T00:00:00.000Z"),
    updatedAt: new Date("2026-04-12T00:05:00.000Z"),
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("CompanyDocuments", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentDocumentId = undefined;
    navigateMock.mockReset();
    listDocumentsMock.mockReset();
    createDocumentMock.mockReset();
    updateDocumentMock.mockReset();
    listDocumentRevisionsMock.mockReset();
    restoreDocumentRevisionMock.mockReset();
    deleteDocumentMock.mockReset();
    pushToastMock.mockReset();
    listDocumentsMock.mockResolvedValue([createDocument()]);
    listDocumentRevisionsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders existing company documents", async () => {
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <CompanyDocuments />
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(container.textContent).toContain("Nuviya Stage Tone Profiles");
    expect(listDocumentsMock).toHaveBeenCalledWith("company-1");
  });

  it("switches into new-document mode from the sidebar action", async () => {
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <CompanyDocuments />
        </QueryClientProvider>,
      );
    });
    await flush();

    const buttons = Array.from(container.querySelectorAll("button"));
    const newButton = buttons.find((button) => button.textContent?.includes("New"));
    expect(newButton).toBeTruthy();

    await act(async () => {
      newButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("New document");
    expect(navigateMock).toHaveBeenCalledWith("/company/documents");
  });
});
