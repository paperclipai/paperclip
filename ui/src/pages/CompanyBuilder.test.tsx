// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BuilderSession, BuilderSessionDetail } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyBuilder } from "./CompanyBuilder";
import { formatDateTime } from "../lib/utils";

const createdAt = new Date("2026-05-06T09:30:00.000Z");
const runtimeUpdatedAt = new Date("2026-05-06T09:40:00.000Z");

let sessionsState: BuilderSession[] = [
  {
    id: "session-1",
    companyId: "company-1",
    createdByUserId: "board-user",
    title: "",
    adapterType: "claude_local",
    model: "legacy-model",
    state: "active" as const,
    archivedAt: null as Date | null,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    costCentsTotal: 0,
    effectiveRuntimeConfig: {
      adapterType: "codex_local",
      model: "gpt-current",
      updatedAt: runtimeUpdatedAt,
      source: "company_settings" as const,
    },
    createdAt,
    updatedAt: createdAt,
  },
];

let sessionDetailState: BuilderSessionDetail = {
  ...sessionsState[0],
  messages: [],
};

let proposalsState: Array<Record<string, unknown>> = [];

const mockBuilderApi = vi.hoisted(() => ({
  listSessions: vi.fn(async (_companyId?: string, _options?: { includeArchived?: boolean }) => ({
    sessions: sessionsState.map((session) => ({ ...session })),
  })),
  createSession: vi.fn(async () => ({
    session: sessionsState[0],
  })),
  getSession: vi.fn(async (_companyId?: string, _sessionId?: string) => ({
    session: {
      ...sessionDetailState,
      messages: [...sessionDetailState.messages],
    },
  })),
  sendMessage: vi.fn(),
  streamMessage: vi.fn(),
  abortSession: vi.fn(),
  archiveSession: vi.fn(async (_companyId: string, sessionId: string) => {
    sessionsState = sessionsState.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            archivedAt: new Date("2026-05-06T11:00:00.000Z"),
            updatedAt: new Date("2026-05-06T11:00:00.000Z"),
          }
        : session,
    );
    if (sessionDetailState.id === sessionId) {
      sessionDetailState = {
        ...sessionDetailState,
        archivedAt: new Date("2026-05-06T11:00:00.000Z"),
        updatedAt: new Date("2026-05-06T11:00:00.000Z"),
      };
    }
    return {
      session: sessionsState.find((session) => session.id === sessionId),
    };
  }),
  restoreSession: vi.fn(async (_companyId: string, sessionId: string) => {
    sessionsState = sessionsState.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            archivedAt: null,
            updatedAt: new Date("2026-05-06T11:05:00.000Z"),
          }
        : session,
    );
    if (sessionDetailState.id === sessionId) {
      sessionDetailState = {
        ...sessionDetailState,
        archivedAt: null,
        updatedAt: new Date("2026-05-06T11:05:00.000Z"),
      };
    }
    return {
      session: sessionsState.find((session) => session.id === sessionId),
    };
  }),
  getTools: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listProposals: vi.fn(async () => ({
    proposals: proposalsState.map((proposal) => ({ ...proposal })),
  })),
  getProposal: vi.fn(),
  applyProposal: vi.fn(async (_companyId: string, proposalId: string) => {
    proposalsState = proposalsState.map((proposal) =>
      proposal.id === proposalId
        ? {
            ...proposal,
            status: "applied",
            handoff: {
              kind: "entity",
              label: "Open result",
              href: "/company/settings",
              entityType: "company",
              entityId: "company-1",
            },
          }
        : proposal,
    );
    return {
      proposal: proposalsState.find((proposal) => proposal.id === proposalId),
    };
  }),
  rejectProposal: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/builder", () => ({
  builderApi: mockBuilderApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
  }: {
    children: React.ReactNode;
    to: string;
  }) => <a href={to}>{children}</a>,
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({
    children,
  }: {
    children: string;
  }) => <div>{children}</div>,
}));

vi.mock("@/components/ApprovalPayload", () => ({
  approvalLabel: (type: string, payload?: Record<string, unknown> | null) =>
    `${type}:${String(payload?.name ?? payload?.title ?? payload?.summary ?? "")}`,
  ApprovalPayloadRenderer: ({
    type,
    payload,
  }: {
    type: string;
    payload: Record<string, unknown>;
  }) => <div>{`payload:${type}:${JSON.stringify(payload)}`}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderCompanyBuilder(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CompanyBuilder />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  await flushReact();
  await flushReact();

  return { root };
}

function getBuilderComposer(container: HTMLDivElement): HTMLTextAreaElement {
  const textarea = container.querySelector('textarea[placeholder="Ask the AI Builder…"]');
  expect(textarea).not.toBeNull();
  return textarea as HTMLTextAreaElement;
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  const previousValue = textarea.value;
  valueSetter?.call(textarea, value);
  const tracker = textarea as HTMLTextAreaElement & { _valueTracker?: { setValue: (next: string) => void } };
  tracker._valueTracker?.setValue(previousValue);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function dispatchComposerKey(
  textarea: HTMLTextAreaElement,
  key: string,
  options?: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  },
) {
  return textarea.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...options,
  }));
}

describe("CompanyBuilder", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    sessionsState = [
      {
        id: "session-1",
        companyId: "company-1",
        createdByUserId: "board-user",
        title: "",
        adapterType: "claude_local",
        model: "legacy-model",
        state: "active",
        archivedAt: null,
        inputTokensTotal: 0,
        outputTokensTotal: 0,
        costCentsTotal: 0,
        effectiveRuntimeConfig: {
          adapterType: "codex_local",
          model: "gpt-current",
          updatedAt: runtimeUpdatedAt,
          source: "company_settings",
        },
        createdAt,
        updatedAt: createdAt,
      },
    ];
    sessionDetailState = {
      ...sessionsState[0],
      messages: [],
    };
    proposalsState = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    mockBuilderApi.listSessions.mockImplementation(async () => ({
      sessions: sessionsState.map((session) => ({ ...session })),
    }));
    mockBuilderApi.getSession.mockImplementation(async () => ({
      session: {
        ...sessionDetailState,
        messages: [...sessionDetailState.messages],
      },
    }));
    mockBuilderApi.listProposals.mockImplementation(async () => ({
      proposals: proposalsState.map((proposal) => ({ ...proposal })),
    }));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("shows the effective runtime summary and links to deep Builder settings", async () => {
    const { root } = await renderCompanyBuilder(container);

    expect(container.textContent).toContain(formatDateTime(createdAt));
    expect(container.textContent).not.toContain("legacy-model");
    expect(container.textContent).toContain("codex_local");
    expect(container.textContent).toContain("gpt-current");
    expect(container.textContent).toContain("Open Builder settings");
    expect(container.querySelector('[data-testid="agent-config-form"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("splits active and archived sessions and disables archived composer", async () => {
    sessionsState = [
      {
        ...sessionsState[0],
        id: "session-2",
        title: "Archived plan",
        archivedAt: new Date("2026-05-06T11:00:00.000Z"),
        updatedAt: new Date("2026-05-06T11:00:00.000Z"),
      },
      sessionsState[0],
    ];
    sessionDetailState = { ...sessionsState[0], messages: [] };
    mockBuilderApi.getSession.mockImplementation(async (_companyId?: string, sessionId?: string) => ({
      session: {
        ...(sessionId === "session-2"
          ? sessionDetailState
          : { ...sessionsState[1], messages: [] }),
        messages: [...(sessionId === "session-2" ? sessionDetailState.messages : [])],
      },
    }));

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyBuilder />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    const archivedToggle = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Archived"),
    );
    expect(archivedToggle).not.toBeUndefined();

    await act(async () => {
      archivedToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Archived sessions are read-only until restored.");
    const textarea = container.querySelector("textarea");
    expect(textarea?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("archives then restores a session from the sidebar", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyBuilder />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    const archiveButton = container.querySelector('button[aria-label="Archive session"]');
    expect(archiveButton).not.toBeNull();

    await act(async () => {
      archiveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(mockBuilderApi.archiveSession).toHaveBeenCalledWith("company-1", "session-1");
    expect(container.textContent).toContain("Archived");

    const restoreButton = container.querySelector('button[aria-label="Restore session"]');
    expect(restoreButton).not.toBeNull();

    await act(async () => {
      restoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockBuilderApi.restoreSession).toHaveBeenCalledWith("company-1", "session-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("submits a non-empty draft on Enter", async () => {
    mockBuilderApi.streamMessage.mockResolvedValue(undefined);

    const { root } = await renderCompanyBuilder(container);
    const textarea = getBuilderComposer(container);

    await act(async () => {
      setNativeTextareaValue(textarea, "Build the next roadmap");
    });

    await act(async () => {
      dispatchComposerKey(textarea, "Enter");
    });
    await flushReact();

    expect(mockBuilderApi.streamMessage).toHaveBeenCalledTimes(1);
    expect(mockBuilderApi.streamMessage.mock.calls[0]?.[0]).toBe("company-1");
    expect(mockBuilderApi.streamMessage.mock.calls[0]?.[1]).toBe("session-1");
    expect(mockBuilderApi.streamMessage.mock.calls[0]?.[2]).toEqual({
      text: "Build the next roadmap",
    });
    expect(textarea.value).toBe("");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not submit on Shift+Enter and keeps multiline content intact", async () => {
    const { root } = await renderCompanyBuilder(container);
    const textarea = getBuilderComposer(container);

    await act(async () => {
      setNativeTextareaValue(textarea, "Line 1\nLine 2");
    });

    let defaultAllowed = true;
    await act(async () => {
      defaultAllowed = dispatchComposerKey(textarea, "Enter", { shiftKey: true });
    });

    expect(defaultAllowed).toBe(true);
    expect(mockBuilderApi.streamMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Line 1\nLine 2");

    await act(async () => {
      root.unmount();
    });
  });

  it("submits on Cmd+Enter and Ctrl+Enter", async () => {
    mockBuilderApi.streamMessage.mockResolvedValue(undefined);

    const { root } = await renderCompanyBuilder(container);
    const textarea = getBuilderComposer(container);

    await act(async () => {
      setNativeTextareaValue(textarea, "Use cmd submit");
    });
    await act(async () => {
      dispatchComposerKey(textarea, "Enter", { metaKey: true });
    });
    await flushReact();

    await act(async () => {
      setNativeTextareaValue(textarea, "Use ctrl submit");
    });
    await act(async () => {
      dispatchComposerKey(textarea, "Enter", { ctrlKey: true });
    });
    await flushReact();

    expect(mockBuilderApi.streamMessage).toHaveBeenCalledTimes(2);
    expect(mockBuilderApi.streamMessage.mock.calls[0]?.[2]).toEqual({ text: "Use cmd submit" });
    expect(mockBuilderApi.streamMessage.mock.calls[1]?.[2]).toEqual({ text: "Use ctrl submit" });

    await act(async () => {
      root.unmount();
    });
  });

  it("does not submit whitespace-only drafts on Enter", async () => {
    const { root } = await renderCompanyBuilder(container);
    const textarea = getBuilderComposer(container);

    await act(async () => {
      setNativeTextareaValue(textarea, "   ");
    });

    const submitAllowed = await act(async () => dispatchComposerKey(textarea, "Enter"));
    expect(submitAllowed).toBe(false);
    expect(mockBuilderApi.streamMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("   ");

    await act(async () => {
      root.unmount();
    });
  });

  it("blocks repeated submit attempts while a send is pending", async () => {
    mockBuilderApi.streamMessage.mockImplementation(
      () => new Promise(() => undefined),
    );

    const { root } = await renderCompanyBuilder(container);
    const textarea = getBuilderComposer(container);

    await act(async () => {
      setNativeTextareaValue(textarea, "First pending message");
    });
    await act(async () => {
      dispatchComposerKey(textarea, "Enter");
    });
    await flushReact();

    await act(async () => {
      dispatchComposerKey(textarea, "Enter");
    });

    expect(mockBuilderApi.streamMessage).toHaveBeenCalledTimes(1);
    expect(textarea.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not submit when the session is not active", async () => {
    sessionsState = [
      {
        ...sessionsState[0],
        state: "aborted",
      },
    ];
    sessionDetailState = {
      ...sessionDetailState,
      state: "aborted",
    };

    const { root } = await renderCompanyBuilder(container);
    const textarea = getBuilderComposer(container);

    await act(async () => {
      setNativeTextareaValue(textarea, "Should not send");
    });
    await act(async () => {
      dispatchComposerKey(textarea, "Enter");
    });

    expect(mockBuilderApi.streamMessage).not.toHaveBeenCalled();
    expect(textarea.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("deep-links governed proposals instead of showing inline apply", async () => {
    sessionDetailState = {
      ...sessionDetailState,
      messages: [
        {
          id: "message-1",
          sessionId: "session-1",
          companyId: "company-1",
          sequence: 0,
          role: "tool",
          content: {
            toolResult: {
              toolCallId: "call-1",
              name: "hire_agent",
              ok: true,
              proposalId: "proposal-1",
              result: { summary: "Hire designer" },
            },
          },
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          createdAt,
        },
      ],
    };
    proposalsState = [
      {
        id: "proposal-1",
        companyId: "company-1",
        sessionId: "session-1",
        messageId: "message-1",
        kind: "hire_agent",
        payload: { name: "Designer" },
        status: "pending",
        appliedActivityId: null,
        approvalId: "approval-1",
        decidedByUserId: null,
        decidedAt: null,
        failureReason: null,
        handoff: {
          kind: "approval",
          label: "Review approval",
          href: "/approvals/approval-1",
          approvalId: "approval-1",
        },
        createdAt,
        updatedAt: createdAt,
      },
    ];

    const { root } = await renderCompanyBuilder(container);

    expect(container.textContent).toContain("Designer");
    expect(container.textContent).toContain("Review approval");
    expect(container.textContent).not.toContain("Apply");

    await act(async () => {
      root.unmount();
    });
  });

  it("applies inline-safe proposals and keeps the returned handoff visible", async () => {
    sessionDetailState = {
      ...sessionDetailState,
      messages: [
        {
          id: "message-1",
          sessionId: "session-1",
          companyId: "company-1",
          sequence: 0,
          role: "tool",
          content: {
            toolResult: {
              toolCallId: "call-1",
              name: "update_company",
              ok: true,
              proposalId: "proposal-2",
              result: { summary: "Rename company to Citro X" },
            },
          },
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          createdAt,
        },
      ],
    };
    proposalsState = [
      {
        id: "proposal-2",
        companyId: "company-1",
        sessionId: "session-1",
        messageId: "message-1",
        kind: "update_company",
        payload: { patch: { name: "Citro X" } },
        status: "pending",
        appliedActivityId: null,
        approvalId: null,
        decidedByUserId: null,
        decidedAt: null,
        failureReason: null,
        handoff: null,
        createdAt,
        updatedAt: createdAt,
      },
    ];

    const { root } = await renderCompanyBuilder(container);

    const applyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Apply"),
    );
    expect(applyButton).not.toBeUndefined();

    await act(async () => {
      applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockBuilderApi.applyProposal).toHaveBeenCalledWith("company-1", "proposal-2");
    expect(container.textContent).toContain("Open result");
    expect(container.textContent).toContain("applied");

    await act(async () => {
      root.unmount();
    });
  });
});
