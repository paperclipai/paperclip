// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskListSidePanel } from "./useTaskListSidePanel";

const navigate = vi.fn();
let search = "";
let flagEnabled = true;

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(search), vi.fn()],
}));
vi.mock("./useTaskListSidePanelEnabled", () => ({
  useTaskListSidePanelEnabled: () => ({ enabled: flagEnabled, loaded: true }),
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useTaskListSidePanel();
  return null;
}

describe("useTaskListSidePanel shared links", () => {
  let host: HTMLDivElement, root: Root;
  beforeEach(() => {
    navigate.mockClear();
    flagEnabled = true;
    search = "task=PAP-123";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  async function renderAt(width: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    await act(async () => root.render(<Probe />));
  }

  it("opens the full task page for a shared link on a phone", async () => {
    await renderAt(375);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toContain("PAP-123");
    expect(navigate.mock.calls[0][1]).toEqual({ replace: true });
  });

  it("keeps the list when the panel is available", async () => {
    await renderAt(1280);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps the list when the setting is off", async () => {
    flagEnabled = false;
    await renderAt(375);
    expect(navigate).not.toHaveBeenCalled();
  });
});
