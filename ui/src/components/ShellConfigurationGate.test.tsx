// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { CloudAccessGate } from "./CloudAccessGate";
import { ShellConfigurationGate } from "./ShellConfigurationGate";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";

vi.mock("@/lib/router", async () => await import("react-router-dom"));
vi.mock("./AnimatedPaperclipIcon", () => ({ PaperclipLoading: () => <div>Loading shell</div> }));
const { health, session, access, settings } = vi.hoisted(() => ({ health: vi.fn(), session: vi.fn(), access: vi.fn(), settings: vi.fn() }));
vi.mock("../api/health", () => ({ healthApi: { get: health } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: session } }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: access } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: settings } }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.resetAllMocks());

it.each([
  ["/PAP/issues/PAP-1", true],
  ["/PAP/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true],
  ["/PAP/issues/all", false],
  ["/PAP/issues", false],
  ["/PAP/chats/agent", false],
  ["/PAP/apps", false],
])("prepares only guarded task data behind the loading view while preferences load: %s", async (path, permitted) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={[path]}><Routes>
      <Route element={<ShellConfigurationGate loaded={false} allowPendingTaskDetail />}>
        <Route path="*" element={<div>Guarded task content</div>} />
      </Route>
    </Routes></MemoryRouter>));
    expect(container.textContent).toContain("Loading shell");
    expect(container.textContent?.includes("Guarded task content")).toBe(permitted);
    const prepared = container.querySelector<HTMLElement>('[data-testid="shell-prepared-outlet"]');
    expect(prepared?.hidden ?? null).toBe(permitted ? true : null);
    if (prepared) expect(prepared.hasAttribute("inert")).toBe(true);
  } finally { await act(async () => root.unmount()); }
});

it.each([false, true])("runs access checks while shell settings are pending (membership=%s)", async allowMembershipRequest => {
  let resolveSettings!: (value: unknown) => void;
  health.mockResolvedValue({ status: "ok", deploymentMode: "authenticated", bootstrapStatus: "ready" });
  session.mockResolvedValue({ user: { id: "user" } });
  access.mockResolvedValue({ companyIds: ["company"] });
  settings.mockReturnValue(new Promise(resolve => { resolveSettings = resolve; }));
  function RoutesUnderTest() {
    const { loaded, enabled } = useStreamlinedUiEnabled();
    return <Routes><Route element={<CloudAccessGate allowMembershipRequest={allowMembershipRequest} />}>
      <Route element={<ShellConfigurationGate loaded={loaded} />}>
        <Route path="apps" element={<div>{enabled ? "Streamlined shell" : "Legacy shell"}</div>} />
      </Route>
    </Route></Routes>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/apps"]}><RoutesUnderTest /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(health).toHaveBeenCalledTimes(1);
    expect(session).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Streamlined shell");
    expect(container.textContent).not.toContain("Legacy shell");
    await act(async () => { resolveSettings({ enableStreamlinedUi: false }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(container.textContent).toBe("Legacy shell");
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

it("keeps prepared task content mounted without taking existing focus when the shell becomes visible", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const input = document.createElement("input");
  document.body.append(container, input);
  const view = (loaded: boolean) => <MemoryRouter initialEntries={["/PAP/issues/PAP-1"]}><Routes>
    <Route element={<ShellConfigurationGate loaded={loaded} allowPendingTaskDetail />}>
      <Route path="*" element={<main id="main-content" tabIndex={-1} data-testid="prepared-task">Task data</main>} />
    </Route>
  </Routes></MemoryRouter>;
  try {
    await act(async () => root.render(view(false)));
    const task = container.querySelector('[data-testid="prepared-task"]');
    expect(task).not.toBeNull();
    input.focus();
    await act(async () => root.render(view(true)));
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('[data-testid="prepared-task"]')).toBe(task);
    expect(container.querySelector<HTMLElement>('[data-testid="shell-prepared-outlet"]')?.hidden).toBe(false);
    expect(container.querySelector('[data-testid="shell-configuration-loading"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); input.remove(); }
});
