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
const downloadMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: { getCurrentBoardAccess: accessMock },
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: {
    events: eventsMock,
    providerTrace: traceMock,
    revealProviderTraceFrame: revealMock,
    downloadProviderTrace: downloadMock,
    deleteProviderTrace: deleteMock,
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

function traceInspection(runId: string, marker: string) {
  return {
    trace: {
      id: `trace-${runId}`,
      runId,
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
        parsed: { method: "item/completed", marker },
        withheldPaths: ["secret"],
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

  it("does not reuse an exact frame after switching runs with the same frame id", async () => {
    traceMock.mockImplementation(async (requestedRunId: string) =>
      traceInspection(requestedRunId, `${requestedRunId}-redacted`),
    );
    revealMock.mockResolvedValue({
      schema: "paperclip.provider_trace_frame.v1",
      frameId: 1,
      timestamp: "1",
      direction: "provider_to_client",
      transport: "stdio_jsonl",
      provider: "codex",
      byteLength: 31,
      digest: `sha256:${"b".repeat(64)}`,
      rawBase64: btoa(JSON.stringify({ secret: "run-one-secret" })),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

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
    const reveal = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Reveal exact frame"),
    );
    flushSync(() => reveal?.click());
    await flush();
    expect(container.textContent).toContain("run-one-secret");

    flushSync(() =>
      root.render(
        <RunnerInspector
          runId="run-2"
          run={{ status: "succeeded", resultJson: null }}
          open
          onOpenChange={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).not.toContain("run-one-secret");
    await flush();
    expect(container.textContent).toContain("run-2-redacted");
    expect(container.textContent).not.toContain("run-one-secret");
  });

  it("clears exact frames when raw-trace access is revoked while open", async () => {
    traceMock.mockResolvedValue(traceInspection("run-1", "run-1-redacted"));
    revealMock.mockResolvedValue({
      schema: "paperclip.provider_trace_frame.v1",
      frameId: 1,
      timestamp: "1",
      direction: "provider_to_client",
      transport: "stdio_jsonl",
      provider: "codex",
      byteLength: 31,
      digest: `sha256:${"b".repeat(64)}`,
      rawBase64: btoa(JSON.stringify({ secret: "revoked-secret" })),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

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
    const reveal = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Reveal exact frame"),
    );
    flushSync(() => reveal?.click());
    await flush();
    expect(container.textContent).toContain("revoked-secret");

    accessMock.mockResolvedValue({
      source: "session",
      isInstanceAdmin: false,
    });
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(accessMock.mock.calls.length).toBeGreaterThan(1);
    expect(container.textContent).toContain(
      "Raw provider traces require an instance administrator.",
    );
    expect(container.textContent).not.toContain("Reveal exact frame");
    expect(container.textContent).not.toContain("revoked-secret");
  });

  it("does not let a stale initial access check override a newer denial", async () => {
    const pendingInitialAccess = deferred<{
      source: "local_implicit";
      isInstanceAdmin: false;
    }>();
    accessMock
      .mockReturnValueOnce(pendingInitialAccess.promise)
      .mockResolvedValue({ source: "session", isInstanceAdmin: false });
    traceMock.mockResolvedValue(traceInspection("run-1", "stale-secret"));

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
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(container.textContent).toContain(
      "Raw provider traces require an instance administrator.",
    );

    pendingInitialAccess.resolve({
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    await flush();
    expect(traceMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Reveal exact frame");
    expect(container.textContent).not.toContain("stale-secret");
  });

  it("discards in-flight exact reads and disables privileged controls during deletion", async () => {
    traceMock.mockResolvedValue(traceInspection("run-1", "run-1-redacted"));
    const pendingReveal = deferred<{
      schema: string;
      frameId: number;
      timestamp: string;
      direction: string;
      transport: string;
      provider: string;
      byteLength: number;
      digest: string;
      rawBase64: string;
    }>();
    const pendingDownload = deferred<Blob>();
    const pendingDelete = deferred<void>();
    const pendingPostDeleteAccess = deferred<{
      source: "local_implicit";
      isInstanceAdmin: false;
    }>();
    revealMock.mockReturnValue(pendingReveal.promise);
    downloadMock.mockReturnValue(pendingDownload.promise);
    deleteMock.mockReturnValue(pendingDelete.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

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
    const buttons = () => Array.from(container.querySelectorAll("button"));
    flushSync(() =>
      buttons()
        .find((button) => button.textContent?.includes("Reveal exact frame"))
        ?.click(),
    );
    flushSync(() =>
      buttons()
        .find((button) => button.textContent?.includes("Download exact trace"))
        ?.click(),
    );
    await Promise.resolve();
    expect(revealMock).toHaveBeenCalledWith("run-1", 1);
    expect(downloadMock).toHaveBeenCalledWith("run-1");

    flushSync(() =>
      buttons()
        .find((button) => button.textContent?.includes("Delete trace"))
        ?.click(),
    );
    expect(deleteMock).toHaveBeenCalledWith("run-1");
    expect(container.textContent).not.toContain("Reveal exact frame");
    expect(container.textContent).not.toContain("Download exact trace");
    expect(container.textContent).not.toContain("Delete trace");

    pendingReveal.resolve({
      schema: "paperclip.provider_trace_frame.v1",
      frameId: 1,
      timestamp: "1",
      direction: "provider_to_client",
      transport: "stdio_jsonl",
      provider: "codex",
      byteLength: 31,
      digest: `sha256:${"b".repeat(64)}`,
      rawBase64: btoa(JSON.stringify({ secret: "late-secret" })),
    });
    pendingDownload.resolve(new Blob(["late raw trace"]));
    await flush();
    expect(container.textContent).not.toContain("late-secret");
    expect(anchorClick).not.toHaveBeenCalled();

    accessMock
      .mockReturnValueOnce(pendingPostDeleteAccess.promise)
      .mockResolvedValue({ source: "session", isInstanceAdmin: false });
    pendingDelete.resolve();
    await Promise.resolve();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(container.textContent).toContain(
      "Raw provider traces require an instance administrator.",
    );
    pendingPostDeleteAccess.resolve({
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    await flush();
    expect(container.textContent).toContain(
      "Raw provider traces require an instance administrator.",
    );
    expect(container.textContent).not.toContain("late-secret");
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it("keeps client and provider JSON-RPC id spaces separate when grouping operations", async () => {
    eventsMock.mockResolvedValue([{
      id: 41,
      companyId: "company-1",
      runId: "run-1",
      agentId: "agent-1",
      seq: 9,
      eventType: "run.result.proposed",
      stream: "stdout",
      level: "info",
      color: null,
      message: null,
      payload: { prpEvent: { sourceEventId: "runner:run-1:9", payload: {} } },
      createdAt: "2026-08-22T12:00:03.000Z",
    }]);
    traceMock.mockResolvedValue({
      trace: null,
      entries: [
        { kind: "frame", frameId: 1, timestamp: "1", direction: "client_to_provider", parsed: { id: 1, method: "initialize" } },
        { kind: "frame", frameId: 2, timestamp: "2", direction: "provider_to_client", parsed: { id: 1, result: {} } },
        { kind: "frame", frameId: 3, timestamp: "3", direction: "provider_to_client", parsed: { id: 1, method: "item/tool/call", params: { callId: "finish-1", tool: "paperclip_finish" } } },
        { kind: "frame", frameId: 4, timestamp: "4", direction: "client_to_provider", parsed: { id: 1, result: { success: true } } },
        { kind: "interpretation", frameId: 3, stage: "typescript_codex_driver_normalization", disposition: "mapped", emittedEventIds: ["runner:run-1:9"], ruleId: "codex_driver.normalize.item/tool/call" },
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

    expect(container.textContent).toContain("frames 1–2 · 0 PRP events");
    expect(container.textContent).toContain("frames 3–4 · 1 PRP event");
    expect(container.textContent).not.toContain("frames 1–4");
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
