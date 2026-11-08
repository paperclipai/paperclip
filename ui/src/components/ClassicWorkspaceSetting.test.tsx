// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassicWorkspaceSetting } from "./ClassicWorkspaceSetting";

const mocks = vi.hoisted(() => ({
  setEnabled: vi.fn(), enabled: false,
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { id: "company" } }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({
  enabled: mocks.enabled, loaded: true, userId: "person", error: null, isSaving: false, setEnabled: mocks.setEnabled,
}) }));

describe("Classic workspace preference", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.clearAllMocks(); mocks.enabled = false;
    mocks.setEnabled.mockResolvedValue(undefined);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { flushSync(() => root.unmount()); container.remove(); });
  it.each([false, true])("changes only the personal workspace (enabled: %s)", enabled => {
    mocks.enabled = enabled;
    flushSync(() => root.render(<ClassicWorkspaceSetting />));
    expect(container.querySelector("h3")?.textContent).toBe("Classic workspace");
    expect(container.textContent).toContain("Off by default");
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe(String(!enabled));
    expect(container.querySelector("a")).toBeNull();
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(mocks.setEnabled).toHaveBeenCalledWith("company", !enabled);
  });
});
