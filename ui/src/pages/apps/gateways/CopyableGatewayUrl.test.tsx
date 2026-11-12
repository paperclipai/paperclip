// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyableGatewayUrl } from "./CopyableGatewayUrl";

const copyMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: copyMock }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: pushToastMock }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CopyableGatewayUrl", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    copyMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("copies the absolute gateway URL and confirms success", async () => {
    root = createRoot(container);
    flushSync(() => root.render(<CopyableGatewayUrl endpointPath="/mcp/gateways/gw_test" />));

    container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(copyMock).toHaveBeenCalledWith("http://localhost:3000/mcp/gateways/gw_test");
    expect(pushToastMock).toHaveBeenCalledWith({ title: "Gateway URL copied", tone: "success" });
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Copy gateway URL");
  });
});
