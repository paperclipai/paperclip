// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerInspector } from "./RunnerInspector";

const accessMock = vi.hoisted(() => vi.fn());
const eventsMock = vi.hoisted(() => vi.fn());
const traceMock = vi.hoisted(() => vi.fn());
const revealMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: { getCurrentBoardAccess: accessMock },
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: {
    events: eventsMock,
    providerTrace: traceMock,
    revealProviderTraceFrame: revealMock,
    downloadProviderTrace: vi.fn(),
    deleteProviderTrace: vi.fn(),
  },
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement("div", null, children) : null,
  SheetContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  SheetDescription: ({ children }: { children: ReactNode }) =>
    createElement("p", null, children),
  SheetHeader: ({ children }: { children: ReactNode }) =>
    createElement("header", null, children),
  SheetTitle: ({ children }: { children: ReactNode }) =>
    createElement("h2", null, children),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  SelectContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  SelectItem: ({ children }: { children: ReactNode }) =>
    createElement("span", null, children),
  SelectTrigger: ({ children }: { children: ReactNode }) =>
    createElement("button", { type: "button" }, children),
  SelectValue: ({ placeholder }: { placeholder?: string }) =>
    createElement("span", null, placeholder),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}

describe("RunnerInspector", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    accessMock.mockResolvedValue({
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    eventsMock.mockResolvedValue([]);
    traceMock.mockResolvedValue({ trace: null, entries: [] });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("keeps canonical inspection available when raw capture was disabled", async () => {
    const rerun = vi.fn();
    flushSync(() =>
      root.render(
        <RunnerInspector
          runId="run-1"
          run={{ status: "succeeded", resultJson: null }}
          open
          onOpenChange={vi.fn()}
          onRerunWithTrace={rerun}
        />,
      ),
    );
    await flush();

    expect(container.textContent).toContain(
      "Correlate exact provider traffic with every interpretation stage",
    );
    expect(container.textContent).toContain(
      "Raw provider capture was off for this run.",
    );
    const rerunButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Re-run with provider trace"),
    );
    flushSync(() => rerunButton?.click());
    expect(rerun).toHaveBeenCalledOnce();
  });

  it("shows redacted frames by default and warns before exact reveal", async () => {
    traceMock.mockResolvedValue({
      trace: {
        id: "trace-1",
        runId: "run-1",
        companyId: "company-1",
        status: "complete",
        provider: "codex",
        frameCount: 1,
        byteCount: 31,
        digest: `sha256:${"a".repeat(64)}`,
        reason: null,
        requestedBy: "local-admin",
        createdAt: "2026-08-22T12:00:00.000Z",
        expiresAt: "2026-08-23T12:00:00.000Z",
        deletedAt: null,
        schema: "paperclip.provider_trace_metadata.v1",
      },
      entries: [
        {
          kind: "frame",
          frameId: 1,
          direction: "provider_to_client",
          byteLength: 31,
          parsed: { method: "item/completed", authorization: "[withheld]" },
          withheldPaths: ["authorization"],
        },
      ],
    });
    revealMock.mockResolvedValue({
      schema: "paperclip.provider_trace_frame.v1",
      frameId: 1,
      timestamp: "1",
      direction: "provider_to_client",
      transport: "stdio_jsonl",
      provider: "codex",
      byteLength: 31,
      digest: `sha256:${"b".repeat(64)}`,
      rawBase64: btoa(JSON.stringify({ method: "item/completed" })),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    flushSync(() =>
      root.render(
        <RunnerInspector
          runId="run-1"
          run={{ status: "succeeded", resultJson: null }}
          open
          onOpenChange={vi.fn()}
        />,
      ),
    );
    await flush();

    expect(container.textContent).toContain("Withheld paths: authorization");
    expect(container.textContent).not.toContain("rawBase64");
    const reveal = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Reveal exact frame"),
    );
    flushSync(() => reveal?.click());
    await flush();

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("may contain prompts"),
    );
    expect(revealMock).toHaveBeenCalledWith("run-1", 1);
  });

  it("correlates a Codex web search through every stage to canonical PRP and presentation", async () => {
    eventsMock.mockResolvedValue([
      {
        id: 91,
        companyId: "company-1",
        runId: "run-1",
        agentId: "agent-1",
        seq: 42,
        eventType: "research.completed",
        stream: "stdout",
        level: "info",
        color: null,
        message: null,
        payload: {
          prpEvent: {
            eventType: "research.completed",
            sourceEventId: "event_runner_000001",
            sourceSequence: 42,
            payload: { query: "best bbq sauce", status: "completed" },
          },
        },
        createdAt: "2026-08-22T12:00:01.000Z",
      },
    ]);
    traceMock.mockResolvedValue({
      trace: {
        id: "trace-1",
        runId: "run-1",
        companyId: "company-1",
        status: "complete",
        provider: "codex",
        frameCount: 1,
        byteCount: 512,
        digest: `sha256:${"a".repeat(64)}`,
        reason: null,
        requestedBy: "local-admin",
        createdAt: "2026-08-22T12:00:00.000Z",
        expiresAt: "2026-08-23T12:00:00.000Z",
        deletedAt: null,
        schema: "paperclip.provider_trace_metadata.v1",
      },
      entries: [
        {
          kind: "frame",
          frameId: 27,
          timestamp: "1787400001000",
          direction: "provider_to_client",
          byteLength: 512,
          digest: `sha256:${"b".repeat(64)}`,
          parsed: {
            method: "item/completed",
            params: {
              item: {
                id: "search-1",
                type: "webSearch",
                query: "best bbq sauce",
                results: [{ title: "Sauce guide", url: "https://example.com" }],
              },
            },
          },
          withheldPaths: [],
        },
        {
          kind: "interpretation",
          frameId: 27,
          debugChannel: "rust_native",
          debugSequence: 1,
          stage: "rust_jsonrpc_parse",
          ruleId: "codex.notification",
          disposition: "mapped",
          emittedEventIds: [],
          droppedFields: [],
          reason: "Parsed Codex notification",
        },
        {
          kind: "interpretation",
          frameId: 27,
          debugChannel: "rust_native",
          debugSequence: 2,
          stage: "rust_durable_normalization",
          ruleId: "provider.notification.known",
          disposition: "mapped",
          emittedEventIds: ["event_runner_000001"],
          droppedFields: ["params.item.results"],
          fieldMappings: [
            {
              inputPath: "params.item.query",
              outputPath: "payload.query",
              action: "copied",
              reason: "Preserved the search query",
            },
            {
              inputPath: "params.item.results",
              action: "dropped",
              reason: "Raw provider results are not part of this semantic event",
            },
          ],
          reason: "Normalized provider web search",
        },
        {
          kind: "interpretation",
          frameId: 27,
          debugChannel: "typescript_runnerd_rehydration",
          debugSequence: 1,
          stage: "typescript_runnerd_rehydration",
          ruleId: "runnerd.rehydrate.research.completed",
          disposition: "mapped",
          emittedEventIds: ["event_runner_000001"],
          droppedFields: [],
          reason: "Rehydrated canonical event",
        },
        {
          kind: "interpretation",
          frameId: 27,
          debugChannel: "typescript_runnerd_rehydration",
          debugSequence: 2,
          stage: "typescript_codex_driver_normalization",
          ruleId: "codex_driver.normalize.item/completed",
          disposition: "mapped",
          emittedEventIds: ["event_runner_000001"],
          droppedFields: [],
          reason: "Emitted canonical PRP event",
        },
      ],
    });

    flushSync(() =>
      root.render(
        <RunnerInspector
          runId="run-1"
          run={{ status: "succeeded", resultJson: null }}
          open
          onOpenChange={vi.fn()}
        />,
      ),
    );
    await flush();

    expect(container.textContent).toContain("webSearch");
    expect(container.textContent).toContain("rust_jsonrpc_parse");
    expect(container.textContent).toContain("rust_durable_normalization");
    expect(container.textContent).toContain("typescript_runnerd_rehydration");
    expect(container.textContent).toContain("typescript_codex_driver_normalization");
    expect(container.textContent).toContain("params.item.results");
    expect(container.textContent).toContain("payload.query");
    expect(container.textContent).toContain("research.completed");
    expect(container.textContent).toContain("Production surface preview");
  });
});
