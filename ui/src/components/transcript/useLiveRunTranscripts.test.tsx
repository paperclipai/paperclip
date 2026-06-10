// @vitest-environment jsdom

import { act } from "../../test-utils/act-shim";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveRunTranscripts } from "./useLiveRunTranscripts";

const { useQueryMock, logMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(() => ({ data: { censorUsernameInLogs: false } })),
  logMock: vi.fn(async () => ({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 0 })),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("../../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: vi.fn(),
  },
}));

vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: {
    log: logMock,
  },
}));

vi.mock("../../adapters", () => ({
  buildTranscript: (chunks: unknown[]) => chunks,
  getUIAdapter: () => null,
  onAdapterChange: () => () => {},
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSING;
  }

  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("useLiveRunTranscripts", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    useQueryMock.mockClear();
    logMock.mockClear();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("waits for a connecting socket to open before closing it during cleanup", async () => {
    function Harness() {
      useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-1", status: "running", adapterType: "codex_local" }],
      });
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    expect(socket.closeCalls).toHaveLength(0);

    act(() => {
      root.unmount();
    });

    expect(socket.closeCalls).toHaveLength(0);

    act(() => {
      socket.triggerOpen();
    });

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "live_run_transcripts_unmount" }]);
    container.remove();
  });
});
