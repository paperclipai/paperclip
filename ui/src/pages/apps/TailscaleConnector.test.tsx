// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TailscaleConnector, TailscaleConnectorCard } from "./TailscaleConnector";
import { ApiError } from "@/api/client";
import { readPendingCloudHandoff } from "@/lib/oauthHandoff";
import { PaperclipCloudOAuthHandoffPage } from "./PaperclipCloudOAuthHandoff";

const fixture = vi.hoisted(() => ({ companyId: "company-1", search: "", navigate: vi.fn(), access: vi.fn(), list: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), breadcrumbs: vi.fn() }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: fixture.access } }));
vi.mock("@/api/tailscale", () => ({ tailscaleApi: { list: fixture.list, connect: fixture.connect, disconnect: fixture.disconnect } }));
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

  it("starts OAuth from Connectors only when the user clicks Connect", async () => {
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

  it("preserves the current tab's Cloud handoff through reauthentication and resumes consent", async () => {
    const session = "tailscale_handoff_session_abcdefghijklmnop";
    const reauthenticationUrl = new URL(`/cloud/connections/reauth?session=${session}`, window.location.origin).toString();
    fixture.connect.mockResolvedValue({ authorizationUrl: "", handoff: { kind: "paperclip_cloud", session } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "RECENT_LOGIN_REQUIRED", reauthenticationUrl }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ authorizationUrl: "https://login.tailscale.com/a/oauth_authorize" })));
    fixture.navigate.mockImplementationOnce(() => {
      expect(readPendingCloudHandoff()).toEqual({ kind: "paperclip_cloud", session });
    });
    render();await settle();
    flushSync(() => button("Connect Tailscale Network").click());await settle();
    expect(readPendingCloudHandoff()).toEqual({ kind: "paperclip_cloud", session });
    expect(fixture.navigate).toHaveBeenCalledWith(reauthenticationUrl);
    flushSync(() => root.render(<PaperclipCloudOAuthHandoffPage />));await settle();
    expect(fixture.navigate).toHaveBeenLastCalledWith("https://login.tailscale.com/a/oauth_authorize");
    expect(readPendingCloudHandoff()).toBeNull();
    expect(container.textContent).not.toContain("expired");
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

  it("reports access failure without presenting a usable connection or starting OAuth", async () => {
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
