// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import type {
  TaskChatProtocolItem,
  TaskChatProviderActivityFamily,
  TaskChatRuntimeRequestDecision,
} from "./task-chat-model";

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor(
    {
      value,
      onChange,
      placeholder,
      imageUploadHandler,
    }: {
      value: string;
      onChange: (value: string) => void;
      placeholder?: string;
      imageUploadHandler?: (file: File) => Promise<string>;
    },
    ref: ForwardedRef<unknown>,
  ) {
    useImperativeHandle(ref, () => ({
      insertMarkdown: (markdown: string) => onChange(`${value}${markdown}`),
      focus: () => {},
    }));
    return (
      <textarea
        data-testid="mock-markdown-editor"
        data-image-upload={imageUploadHandler ? "true" : "false"}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }),
}));

function renderCard(
  root: Root,
  item: TaskChatProtocolItem,
  onDecision?: (
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>,
  presentation: "timeline" | "takeover" = "timeline",
) {
  flushSync(() =>
    root.render(
      <MemoryRouter>
        <ThemeProvider>
          <TaskChatProtocolCard
            item={item}
            presentation={presentation}
            imageUploadHandler={async () => "blob:question-image"}
            onRuntimeRequestDecision={
              onDecision
                ? (_request, decision) => onDecision(decision)
                : undefined
            }
          />
        </ThemeProvider>
      </MemoryRouter>,
    ),
  );
}

describe("TaskChatProtocolCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("renders provider plan steps and status", () => {
    renderCard(root, {
      id: "provider-plan",
      kind: "protocol",
      surface: "provider_activity",
      family: "plan",
      eventType: "plan.updated",
      status: "running",
      title: "Plan",
      summary: "Implement protocol surfaces",
      details: [],
      links: [],
      children: [],
      steps: [
        { id: "one", label: "Inventory events", status: "completed" },
        { id: "two", label: "Render widgets", status: "in_progress" },
      ],
    });
    expect(
      container.querySelector('[data-testid="task-chat-provider-plan"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Inventory events");
    expect(container.textContent).toContain("Render widgets");
  });

  it("renders a structured history card for every provider family", () => {
    const families = [
      "plan",
      "tool_execution",
      "research",
      "delegation",
      "model_identity",
      "context",
      "artifact",
      "review",
      "hook",
      "memory",
      "safety",
      "terminal",
      "wait",
      "provider_notice",
    ] satisfies TaskChatProviderActivityFamily[];
    for (const family of families) {
      renderCard(root, {
        id: `provider-${family}`,
        kind: "protocol",
        surface: "provider_activity",
        family,
        eventType: `${family}.fixture`,
        status: "completed",
        title: `Visible ${family}`,
        summary: `Summary ${family}`,
        details: [{ label: "Reference", value: `${family}-1` }],
        links: [],
        children: [],
        steps: [],
      });
      expect(
        container.querySelector(`[data-testid="task-chat-provider-${family}"]`),
        family,
      ).not.toBeNull();
      expect(container.textContent, family).toContain(`Visible ${family}`);
    }
  });

  it("opens a workspace diff review dialog", async () => {
    renderCard(root, {
      id: "workspace",
      kind: "protocol",
      surface: "workspace_change",
      changeSetId: "changes-1",
      revision: 1,
      source: "runner_verified",
      complete: true,
      files: [
        {
          path: "ui/src/App.tsx",
          operation: "modify",
          previousPath: null,
          additions: 1,
          deletions: 1,
          binary: false,
          diff: "-old\n+new",
        },
      ],
      totals: { files: 1, additions: 1, deletions: 1 },
      patchArtifactRef: null,
    });
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Review diff",
    );
    expect(button).not.toBeUndefined();
    expect(container.textContent).toContain("1 file changed · +1 −1");
    await act(async () => button?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "ui/src/App.tsx",
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "old",
    );
  });

  it("opens a bounded file preview", async () => {
    renderCard(root, {
      id: "file",
      kind: "protocol",
      surface: "workspace_file",
      referenceId: "file-1",
      source: "runner_verified",
      path: "doc/protocol.md",
      displayName: "protocol.md",
      mediaType: "text/markdown",
      presentation: "document",
      line: 12,
      preview: "# Protocol preview",
      previewTruncated: false,
    });
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Preview",
    );
    await act(async () => button?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Protocol preview",
    );
  });

  it("submits a runtime choice only when a resolver is supplied", async () => {
    const onDecision = vi.fn();
    renderCard(
      root,
      {
        id: "request",
        kind: "protocol",
        surface: "runtime_request",
        runId: "run-1",
        requestId: "request-1",
        requestKind: "command_approval",
        turnId: "turn-1",
        requestType: "permission",
        status: "pending",
        prompt: "Allow command?",
        choices: [{ key: "accept", label: "Allow once" }],
        fields: [],
      },
      onDecision,
    );
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Allow once",
    );
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(onDecision).toHaveBeenCalledWith({ action: "accept" });
  });

  it("submits structured runtime input through the production card", async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    renderCard(
      root,
      {
        id: "input-request",
        kind: "protocol",
        surface: "runtime_request",
        runId: "run-1",
        requestId: "request-input",
        requestKind: "user_input",
        turnId: "turn-1",
        requestType: "input",
        status: "pending",
        prompt: "Which environment should the run target?",
        choices: [],
        fields: [
          { name: "environment", label: "Environment", placeholder: "staging" },
        ],
      },
      onDecision,
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "production");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Submit response",
    );
    await act(async () => submit?.click());
    expect(onDecision).toHaveBeenCalledWith({
      action: "submit",
      values: { environment: "production" },
    });
    expect(container.textContent).toContain("Submitting…");
  });

  it("submits the canonical response from a v2 harness question set", async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    renderCard(
      root,
      {
        id: "canonical-input-request",
        kind: "protocol",
        surface: "runtime_request",
        runId: "run-1",
        requestId: "request-canonical-input",
        requestKind: "runtime",
        turnId: "turn-1",
        requestType: "input",
        status: "pending",
        prompt: "Codex needs your input.",
        choices: [],
        fields: [],
        questionSet: {
          schema: "paperclip.question_set.v1",
          title: "Deployment input",
          submitLabel: "Continue",
          questions: [
            {
              id: "environment",
              header: "Environment",
              prompt: "Where should we deploy?",
              required: true,
              answerMode: "single_select",
              options: [
                { id: "staging", label: "Staging" },
                { id: "production", label: "Production" },
              ],
            },
            {
              id: "regions",
              header: "Regions",
              prompt: "Which regions should receive the release?",
              required: false,
              answerMode: "multi_select",
              options: [
                { id: "us", label: "US" },
                { id: "eu", label: "EU" },
              ],
            },
            {
              id: "notes",
              header: "Notes",
              prompt: "Anything else we should know?",
              required: false,
              answerMode: "text",
            },
          ],
        },
      },
      onDecision,
    );
    expect(container.textContent).toContain("Deployment input");
    expect(container.textContent).toContain("1 of 3");
    const production = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Production"),
    );
    await act(async () => production?.click());
    expect(container.textContent).toContain(
      "Which regions should receive the release?",
    );
    const progress = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Continue");
    expect(progress).not.toBeUndefined();
    await act(async () => progress?.click());
    expect(container.textContent).toContain("Anything else we should know?");
    const submit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Continue",
    );
    await act(async () => submit?.click());
    expect(onDecision).toHaveBeenCalledWith({
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: { environment: { selectedOptionIds: ["production"] } },
      },
    });
  });

  it("renders structured runtime questions directly in the takeover without duplicate request copy", () => {
    renderCard(
      root,
      {
        id: "canonical-takeover-request",
        kind: "protocol",
        surface: "runtime_request",
        runId: "run-1",
        requestId: "request-canonical-takeover",
        requestKind: "runtime",
        turnId: "turn-1",
        requestType: "input",
        status: "pending",
        prompt: "Codex requests user input.",
        choices: [],
        fields: [],
        questionSet: {
          schema: "paperclip.question_set.v1",
          title: "Codex needs your input",
          questions: [
            {
              id: "environment",
              header: "Environment",
              prompt: "Where should we deploy?",
              required: false,
              answerMode: "single_select",
              options: [{ id: "staging", label: "Staging" }],
            },
          ],
        },
      },
      vi.fn(),
      "takeover",
    );

    expect(container.textContent).not.toContain("Codex needs your input");
    expect(container.textContent).not.toContain("Codex requests user input.");
    expect(container.textContent).not.toContain("Choose one");
    expect(container.textContent).toContain("Where should we deploy?");
  });

  it("collapses resolved runtime questions to one expandable timeline row", () => {
    renderCard(root, {
      id: "resolved-input-request",
      kind: "protocol",
      surface: "runtime_request",
      runId: "run-1",
      requestId: "request-resolved-input",
      requestKind: "runtime",
      turnId: "turn-1",
      requestType: "input",
      status: "resolved",
      prompt: "Codex needs your input.",
      choices: [],
      fields: [],
      resolvedAction: "submit",
      questionSet: {
        schema: "paperclip.question_set.v1",
        title: "Server setup",
        questions: [
          {
            id: "style",
            header: "Code style",
            prompt: "Which module style should the server use?",
            required: true,
            answerMode: "single_select",
            options: [{ id: "esm", label: "TypeScript ESM" }],
          },
        ],
      },
      response: {
        schema: "paperclip.question_response.v1",
        answers: { style: { selectedOptionIds: ["esm"] } },
      },
    });

    const receipt = container.querySelector<HTMLDetailsElement>(
      '[data-testid="task-chat-runtime-request"]',
    );
    expect(receipt?.open).toBe(false);
    expect(receipt?.querySelector("summary")?.textContent).toBe(
      "Questions answered",
    );
    expect(receipt?.querySelectorAll("summary svg")).toHaveLength(2);
    expect(receipt?.className).not.toContain("border");
    expect(receipt?.className).not.toContain("bg-card");
    expect(receipt?.querySelector("summary")?.className).toContain("px-1");
    expect(receipt?.querySelector("summary")?.className).toContain(
      "text-muted-foreground",
    );
    expect(receipt?.querySelector("summary")?.className).toContain("leading-5");
    expect(receipt?.querySelector("summary span")?.className).not.toContain(
      "font-medium",
    );
    expect(
      receipt
        ?.querySelector('[data-testid="task-chat-runtime-request-icon"]')
        ?.classList.contains("h-3.5"),
    ).toBe(true);
    const caret = receipt?.querySelector(
      '[data-testid="task-chat-runtime-request-caret"]',
    );
    expect(caret?.classList.contains("h-3")).toBe(true);
    expect(caret?.classList.contains("opacity-0")).toBe(true);
    expect(caret?.getAttribute("class")).toContain("group-hover:opacity-70");
    expect(
      container.querySelector(
        '[data-testid="task-chat-runtime-request-history"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "Which module style should the server use?",
    );
    expect(container.textContent).toContain("TypeScript ESM");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("collapses a cancelled runtime question with its original prompt expandable", () => {
    renderCard(root, {
      id: "cancelled-input-request",
      kind: "protocol",
      surface: "runtime_request",
      runId: "run-1",
      requestId: "request-cancelled-input",
      requestKind: "runtime",
      turnId: "turn-1",
      requestType: "input",
      status: "cancelled",
      prompt: "Codex needs your input.",
      choices: [],
      fields: [],
      resolvedAction: "cancel",
      questionSet: {
        schema: "paperclip.question_set.v1",
        questions: [
          {
            id: "goal",
            prompt: "What should the server do?",
            required: false,
            answerMode: "text",
          },
        ],
      },
    });

    const receipt = container.querySelector<HTMLDetailsElement>(
      '[data-testid="task-chat-runtime-request"]',
    );
    expect(receipt?.open).toBe(false);
    expect(receipt?.querySelector("summary")?.textContent).toBe(
      "Questions cancelled",
    );
    const iconSlot = receipt?.querySelector(
      '[data-testid="task-chat-runtime-request-icon-slot"]',
    );
    expect(iconSlot?.classList.contains("w-6")).toBe(true);
    expect(iconSlot?.classList.contains("items-center")).toBe(true);
    expect(iconSlot?.classList.contains("justify-center")).toBe(true);
    expect(container.textContent).toContain(
      "No answers were submitted; this request was cancelled.",
    );
  });

  it("requires text when an explicit custom multi-select answer is active", async () => {
    renderCard(
      root,
      {
        id: "custom-input-request",
        kind: "protocol",
        surface: "runtime_request",
        runId: "run-1",
        requestId: "request-custom-input",
        requestKind: "runtime",
        turnId: "turn-1",
        requestType: "input",
        status: "pending",
        prompt: "Choose regions.",
        choices: [],
        fields: [],
        questionSet: {
          schema: "paperclip.question_set.v1",
          questions: [
            {
              id: "regions",
              prompt: "Which regions?",
              required: true,
              answerMode: "multi_select",
              options: [{ id: "us", label: "US" }],
              customAnswer: { enabled: true, label: "Another region" },
            },
            {
              id: "notes",
              prompt: "Notes?",
              required: false,
              answerMode: "text",
            },
          ],
        },
      },
      vi.fn(),
    );

    const us = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "US",
    );
    const custom = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Another region",
    );
    await act(async () => us?.click());
    await act(async () => custom?.click());

    const richInput = container.querySelector(
      '[data-testid="question-other-answer-composer"]',
    );
    expect(richInput).not.toBeNull();
    expect(richInput?.classList.contains("border")).toBe(false);
    expect(
      richInput?.querySelector('[data-image-upload="true"]'),
    ).not.toBeNull();

    const next = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.getAttribute("aria-label") === "Next question");
    expect(next?.disabled).toBe(false);
    expect(container.textContent).toContain("Enter a custom answer.");

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "ap-south");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(next?.disabled).toBe(false);
  });
});
