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
