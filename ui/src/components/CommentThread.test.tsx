// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Agent } from "@penclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentThread } from "./CommentThread";

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, placeholder }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label="Comment editor"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: () => null,
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  const translations: Record<string, string> = {
    Assignee: "负责人",
    Board: "董事会",
    None: "无",
    Status: "状态",
    System: "系统",
    Unassigned: "未分配",
    "updated this task": "更新了这个任务",
    "status.done": "已完成",
    "status.todo": "待办",
  };
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        if (key in translations) return translations[key];
        if (typeof options?.defaultValue === "string") return options.defaultValue;
        return key.replace(/\{\{(\w+)\}\}/g, (_match, token) => String(options?.[token] ?? ""));
      },
    }),
  };
});

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CommentThread", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("renders historical runs as timeline rows using the finished time", () => {
    const root = createRoot(container);
    const agent: Agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "CodexCoder",
      urlKey: "codexcoder",
      role: "engineer",
      title: null,
      icon: "code",
      status: "active",
      reportsTo: null,
      capabilities: null,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date("2026-03-11T00:00:00.000Z"),
      updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    };

    act(() => {
      root.render(
        <MemoryRouter>
          <CommentThread
            comments={[]}
            linkedRuns={[{
              runId: "run-12345678abcd",
              status: "succeeded",
              agentId: "agent-1",
              createdAt: "2026-03-11T07:00:00.000Z",
              startedAt: "2026-03-11T08:00:00.000Z",
              finishedAt: "2026-03-11T10:00:00.000Z",
            }]}
            agentMap={new Map([["agent-1", agent]])}
            onAdd={async () => {}}
          />
        </MemoryRouter>,
      );
    });

    const runRow = container.querySelector("#run-run-12345678abcd") as HTMLDivElement | null;
    expect(runRow).not.toBeNull();
    expect(runRow?.className).toContain("py-1.5");
    expect(runRow?.className).toContain("items-center");
    expect(runRow?.className).not.toContain("border");
    expect(container.textContent).toContain("CodexCoder");
    expect(container.textContent).toContain("Succeeded");
    expect(container.textContent).toContain("2 hours ago");
    expect(container.textContent).not.toContain("4 hours ago");
    const runLink = container.querySelector('a[href="/agents/agent-1/runs/run-12345678abcd"]') as HTMLAnchorElement | null;
    expect(runLink?.textContent).toContain("run-1234");
    expect(runLink?.className).toContain("rounded-md");
    expect(runLink?.className).toContain("px-2");

    act(() => {
      root.unmount();
    });
  });

  it("localizes timeline events for status and assignee changes", () => {
    const root = createRoot(container);
    const agent: Agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "CodexCoder",
      urlKey: "codexcoder",
      role: "engineer",
      title: null,
      icon: "code",
      status: "active",
      reportsTo: null,
      capabilities: null,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date("2026-03-11T00:00:00.000Z"),
      updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    };

    act(() => {
      root.render(
        <MemoryRouter>
          <CommentThread
            comments={[]}
            timelineEvents={[{
              id: "event-1",
              createdAt: "2026-03-11T11:00:00.000Z",
              actorType: "system",
              actorId: "system",
              statusChange: {
                from: "todo",
                to: "done",
              },
              assigneeChange: {
                from: { agentId: null, userId: null },
                to: { agentId: "agent-1", userId: null },
              },
            }]}
            agentMap={new Map([["agent-1", agent]])}
            onAdd={async () => {}}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("系统");
    expect(container.textContent).toContain("更新了这个任务");
    expect(container.textContent).toContain("状态");
    expect(container.textContent).toContain("待办");
    expect(container.textContent).toContain("已完成");
    expect(container.textContent).toContain("负责人");
    expect(container.textContent).toContain("未分配");
    expect(container.textContent).toContain("CodexCoder");

    act(() => {
      root.unmount();
    });
  });
});
