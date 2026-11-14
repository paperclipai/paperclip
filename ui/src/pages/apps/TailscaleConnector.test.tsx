// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TailscaleConnector, TailscaleConnectorCard } from "./TailscaleConnector";
import { ApiError } from "@/api/client";
import { shouldRetryRequest } from "@/lib/query-client";

const fixture = vi.hoisted(() => ({ companyId: "company-1", search: "", navigate: vi.fn(), access: vi.fn(), list: vi.fn(), connect: vi.fn(), deviceLogin: vi.fn(), disconnect: vi.fn(), breadcrumbs: vi.fn() }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: fixture.access } }));
vi.mock("@/api/tailscale", () => ({ tailscaleApi: { list: fixture.list, connect: fixture.connect, deviceLogin: fixture.deviceLogin, disconnect: fixture.disconnect } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: fixture.companyId }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: fixture.breadcrumbs }) }));
vi.mock("./AppLogo", () => ({ AppLogo: () => null }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>, useSearchParams: () => [new URLSearchParams(fixture.search)] }));
vi.mock("@/lib/browserNavigation", () => ({ navigateTopLevel: (url: string) => fixture.navigate(url) }));
const connected = { id: "tailnet-1", companyId: "company-1", name: "Home tailnet", status: "connected" };
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const render = () => flushSync(() => root.render(<QueryClientProvider client={client}><TailscaleConnector /></QueryClientProvider>));
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find(element => element.textContent === label);
  expect(result).toBeDefined();
  return result!;
}

describe("Tailscale network connector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "open").mockReturnValue(null);
    fixture.deviceLogin.mockResolvedValue({ connection: { ...connected, status: "authorizing" }, authorizationUrl: "https://login.tailscale.com/a/fixture", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    fixture.companyId = "company-1";
    fixture.search = "";
    window.sessionStorage.clear();
    fixture.access.mockResolvedValue({ source: "session", isInstanceAdmin: true, companyIds: ["company-1", "company-2"] });
    fixture.list.mockResolvedValue([connected]);
    fixture.connect.mockImplementation(() => new Promise(() => {}));
    fixture.disconnect.mockResolvedValue({ ...connected, status: "disconnected" });
    container = document.createElement("div");document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => { flushSync(() => root.unmount());client.clear();container.remove();vi.unstubAllGlobals(); });

  it("does not offer setup or request tailnets to a company member without instance-admin rights", async () => {
    fixture.access.mockResolvedValue({ source: "session", isInstanceAdmin: false, companyIds: ["company-1"] });
    flushSync(() => root.render(<QueryClientProvider client={client}><TailscaleConnectorCard onNavigate={vi.fn()} /></QueryClientProvider>));
    await settle();
    expect(fixture.list).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
    render();await settle();
    expect(container.textContent).toContain("instance administrator");
    expect(container.querySelector("button")).toBeNull();
    expect(fixture.list).not.toHaveBeenCalled();
  });

  it("waits for management access before requesting network data", async () => {
    fixture.access.mockImplementationOnce(() => new Promise(() => {}));
    render();await settle();
    expect(container.textContent).toContain("Checking Tailscale management access");
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("allows a local implicit board to manage its network", async () => {
    fixture.access.mockResolvedValue({ source: "local_implicit", isInstanceAdmin: false });
    render();await settle();
    expect(fixture.list).toHaveBeenCalledWith("company-1");
    expect(button("Connect Tailscale Network").disabled).toBe(false);
  });

  it("reuses an approved tailnet and links to an ordinary SSH environment", async () => {
    render();await settle();
    expect(fixture.list).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Home tailnet");
    expect(container.textContent).toContain("any harness supported");
    expect(container.textContent).not.toContain("Claude");
    expect(container.querySelector('a[href="/company/settings/instance/environments/new?tailscale_connection=tailnet-1"]')?.textContent).toBe("Create SSH environment");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("starts device sign-in from Connectors only when the user clicks Connect", async () => {
    render();await settle();
    flushSync(() => button("Connect Tailscale Network").click());await settle();
    expect(fixture.connect).toHaveBeenCalledWith("company-1", undefined);
    expect(button("Connecting…").disabled).toBe(true);
  });

  it("reconnects the existing connection instead of creating another record", async () => {
    fixture.list.mockResolvedValue([{ ...connected, status: "disconnected" }]);
    render();await settle();
    flushSync(() => button("Reconnect Home tailnet").click());await settle();
    expect(fixture.connect).toHaveBeenCalledWith("company-1", "tailnet-1");
  });

  it("keeps the connector open and offers a sign-in link when popups are blocked", async () => {
    fixture.connect.mockResolvedValue({ connection: { ...connected, status: "authorizing" }, authorizationUrl: "https://login.tailscale.com/a/fixture", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    render();await settle();
    flushSync(() => button("Connect Tailscale Network").click());await settle();
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.deviceLogin).toHaveBeenCalledWith("company-1", "tailnet-1");
    expect(container.querySelector('a[href="https://login.tailscale.com/a/fixture"]')?.textContent).toBe("Continue to Tailscale");
    expect(button("Cancel sign-in")).toBeDefined();
  });

  it("shows administrator approval separately from sign-in", async () => {
    fixture.list.mockResolvedValue([{ ...connected, status: "authorizing" }]);
    fixture.deviceLogin.mockResolvedValue({ connection: { ...connected, status: "authorizing" }, needsApproval: true, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    render();await settle();
    expect(container.textContent).toContain("Tailscale administrator");
    expect(container.querySelector('a[href="https://login.tailscale.com/admin/machines"]')).not.toBeNull();
  });

  it("recovers a transient sign-in status failure using the shared retry policy", async () => {
    client.setDefaultOptions({ queries: { retry: shouldRetryRequest, retryDelay: 0 } });
    fixture.list.mockResolvedValue([{ ...connected, status: "authorizing" }]);
    fixture.deviceLogin.mockRejectedValueOnce(new ApiError("Unavailable", 503, {}));
    render();await settle();
    expect(fixture.deviceLogin).toHaveBeenCalledTimes(2);
    expect(container.querySelector('a[href="https://login.tailscale.com/a/fixture"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not automatically retry a denied sign-in status request", async () => {
    client.setDefaultOptions({ queries: { retry: shouldRetryRequest, retryDelay: 0 } });
    fixture.list.mockResolvedValue([{ ...connected, status: "authorizing" }]);
    fixture.deviceLogin.mockRejectedValue(new ApiError("Forbidden", 403, {}));
    render();await settle();
    expect(fixture.deviceLogin).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("Check again")).toBeDefined();
  });

  it("shows the connected network when the server confirms enrollment", async () => {
    fixture.list.mockResolvedValue([{ ...connected, status: "authorizing" }]);
    fixture.deviceLogin.mockResolvedValue({ connection: connected, expiresAt: null });
    render();await settle();
    expect(container.textContent).toContain("Create SSH environment");
    expect(container.textContent).not.toContain("Cancel sign-in");
  });

  it("does not open a late sign-in response after changing companies", async () => {
    let complete!: (value: unknown) => void;
    fixture.connect.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const assign = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({ opener: null, closed: false, location: { assign }, focus: vi.fn(), close: vi.fn() } as unknown as Window);
    fixture.list.mockImplementation(async id => id === "company-1" ? [connected] : []);
    render();await settle();
    flushSync(() => button("Connect Tailscale Network").click());await settle();
    fixture.companyId = "company-2";render();await settle();
    complete({ connection: { ...connected, status: "authorizing" }, authorizationUrl: "https://login.tailscale.com/a/fixture", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Home tailnet");
  });

  it("stops polling and gives a recovery action when the sign-in deadline passes", async () => {
    fixture.list.mockResolvedValue([{ ...connected, status: "authorizing" }]);
    fixture.deviceLogin.mockResolvedValue({ connection: { ...connected, status: "authorizing" }, authorizationUrl: "https://login.tailscale.com/a/fixture", expiresAt: new Date(Date.now() - 1).toISOString() });
    render();await settle();
    expect(container.textContent).toContain("Sign-in expired");
    expect(container.querySelector('a[href="https://login.tailscale.com/a/fixture"]')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(fixture.deviceLogin).toHaveBeenCalledOnce();
    expect(button("Cancel sign-in")).toBeDefined();
  });

  it.each(["cancelled", "failed"])("explains %s consent and retries the same saved connection", async outcome => {
    fixture.search = `tailscale_connection=tailnet-1&tailscale_error=${outcome}`;
    fixture.list.mockResolvedValue([{ ...connected, status: "pending" }]);
    render();await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(outcome === "cancelled" ? "was canceled" : "could not be completed");
    flushSync(() => button("Try again").click());await settle();
    expect(fixture.connect).toHaveBeenCalledExactlyOnceWith("company-1", "tailnet-1");
  });

  it("does not offer a saved-connection retry for a connection outside the current company", async () => {
    fixture.search = "tailscale_connection=foreign-connection&tailscale_error=cancelled";
    render();await settle();
    expect([...container.querySelectorAll("button")].some(element => element.textContent === "Try again")).toBe(false);
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("does not display untrusted error text from the return URL", async () => {
    fixture.search = new URLSearchParams({ tailscale_connection: "tailnet-1", tailscale_error: "untrusted-provider-error<script>" }).toString();
    render();await settle();
    expect(container.textContent).not.toContain("untrusted-provider-error");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("refreshes connector status after a deliberate disconnect", async () => {
    fixture.list.mockResolvedValueOnce([connected]).mockResolvedValue([{ ...connected, status: "disconnected" }]);
    render();await settle();
    flushSync(() => button("Disconnect Home tailnet").click());await settle();
    expect(fixture.disconnect).toHaveBeenCalledWith("company-1", "tailnet-1");
    expect(container.textContent).toContain("Disconnected");
    expect(container.textContent).not.toContain("Create SSH environment");
  });

  it("reports access failure without presenting a usable connection or starting sign-in", async () => {
    fixture.list.mockRejectedValue(new ApiError("Instance admin access required", 403, { error: "forbidden" }));
    render();await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("Connect Tailscale Network").disabled).toBe(true);
    expect(container.textContent).not.toContain("Home tailnet");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("does not retain another company's tailnets when the organization changes", async () => {
    fixture.list.mockImplementation(async companyId => companyId === "company-1" ? [connected] : []);
    render();await settle();
    expect(container.textContent).toContain("Home tailnet");
    fixture.companyId = "company-2";render();await settle();
    expect(container.textContent).not.toContain("Home tailnet");
    expect(fixture.list).toHaveBeenCalledWith("company-2");
  });
});
