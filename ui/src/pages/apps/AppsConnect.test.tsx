// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONNECTABLE_APP_DEFINITIONS } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsConnect } from "./AppsConnect";

const listGalleryMock = vi.hoisted(() => vi.fn());
const connectAppMock = vi.hoisted(() => vi.fn());
const finishAppMock = vi.hoisted(() => vi.fn());
const putConnectionInstallsMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => ({ value: "" }));
const mockParams = vi.hoisted(() => ({ appKey: undefined as string | undefined }));

const ZAPIER = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "zapier")!;
const GOOGLE_SHEETS = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "google-sheets")!;

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    connectApp: (companyId: string, input: unknown) => connectAppMock(companyId, input),
    finishApp: (companyId: string, connectionId: string, input: unknown) =>
      finishAppMock(companyId, connectionId, input),
    putConnectionInstalls: (connectionId: string, installs: unknown) =>
      putConnectionInstallsMock(connectionId, installs),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgentsMock(companyId) },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useParams: () => mockParams,
  useSearchParams: () => [new URLSearchParams(mockSearch.value), vi.fn()],
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

function buttonContaining(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

async function gotoLinkFrame(container: HTMLDivElement, url: string) {
  const linkInput = Array.from(
    container.querySelectorAll<HTMLInputElement>("input"),
  ).find((i) => i.getAttribute("placeholder")?.startsWith("https://"));
  expect(linkInput).toBeTruthy();
  await act(async () => setInputValue(linkInput!, url));
  await flushReact();
  await act(async () => {
    buttonByText("Continue")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

describe("AppsConnect — Connect with a link (M4 frame)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    mockSearch.value = "";
    mockParams.appKey = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    listGalleryMock.mockResolvedValue({
      apps: [
        ZAPIER,
      ],
    });
    finishAppMock.mockResolvedValue({});
    putConnectionInstallsMock.mockResolvedValue({ connectionId: "conn-1", installs: [] });
    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: "example.com" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
    });
    listAgentsMock.mockResolvedValue([
      { id: "agent-1", name: "Ada", title: "CTO", status: "active", icon: "Bot" },
      { id: "agent-2", name: "Grace", title: "Engineer", status: "active", icon: "Code" },
    ]);
  });

  afterEach(() => {
    document.body.removeChild(container);
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AppsConnect />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("an unrecognized URL routes to a frame with the URL, defaulted Name, and a Yes/No toggle", async () => {
    await render();
    await gotoLinkFrame(container, "https://www.example.com/actions");

    expect(container.textContent).toContain("Connect with a link");
    expect(container.textContent).toContain("https://www.example.com/actions");
    expect(container.textContent).toContain("Does it need a key?");
    expect(buttonByText("No")).toBeTruthy();
    expect(buttonByText("Yes")).toBeTruthy();

    // Name is auto-filled from the host with www. stripped.
    const nameInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (i) => i.getAttribute("placeholder") === "My app",
    );
    expect(nameInput?.value).toBe("example.com");
  });

  it("opens the selected app directly on its setup route", async () => {
    mockParams.appKey = "zapier";
    await render();

    expect(container.textContent).toContain("Connect Zapier");
    expect(container.textContent).not.toContain("Pick the app you want your agents to use.");
  });

  it("choosing No and clicking Check link connects with no credentials", async () => {
    await render();
    await gotoLinkFrame(container, "https://www.example.com/actions");

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({ link: "https://www.example.com/actions", name: "example.com" });
    expect(input.credentialValues).toBeUndefined();
  });

  it("choosing Yes reveals one masked key field plus the lock reassurance", async () => {
    await render();
    await gotoLinkFrame(container, "https://www.example.com/actions");

    // No key field while No is selected.
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input")).some(
        (i) => i.type === "password",
      ),
    ).toBe(false);

    await act(async () => {
      buttonByText("Yes")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const passwordInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>("input"),
    ).filter((i) => i.type === "password");
    expect(passwordInputs).toHaveLength(1);
    expect(container.textContent).toContain("Your key is stored securely.");

    await act(async () => setInputValue(passwordInputs[0], "secret-key"));
    await flushReact();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input.credentialValues).toEqual({ "credentials.authorization": "secret-key" });
  });

  it("a Zapier MCP URL stays in the URL flow and includes its token in the submitted link", async () => {
    await render();

    const linkInput = Array.from(
      container.querySelectorAll<HTMLInputElement>("input"),
    ).find((i) => i.getAttribute("placeholder")?.startsWith("https://"));
    const zapierUrl = "https://mcp.zapier.com/api/v1/connect?token=secret-token";
    await act(async () => setInputValue(linkInput!, zapierUrl));
    await flushReact();

    expect(container.textContent).toContain("This looks like Zapier.");

    await act(async () => {
      buttonByText("Continue")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Connect with a link");
    expect(container.textContent).toContain(zapierUrl);
    expect(nameInputFrom(container)?.value).toBe("Zapier");
    expect(container.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(connectAppMock.mock.calls[0]?.[1]).toMatchObject({ link: zapierUrl, name: "Zapier" });
    expect(connectAppMock.mock.calls[0]?.[1].credentialValues).toBeUndefined();
  });

  it("keeps Zapier visible and uses the compact agent multi-selector throughout its wizard", async () => {
    mockSearch.value = "byo=1&source=zapier";
    listGalleryMock.mockResolvedValueOnce({
      apps: [
        { ...ZAPIER, branding: { ...ZAPIER.branding, logoUrl: "https://example.com/zapier.png" } },
      ],
    });
    connectAppMock.mockResolvedValueOnce({
      connectionId: "conn-1",
      application: { id: "app-1", name: "Zapier" },
      actions: {
        readOnly: [
          {
            catalogEntryId: "action-1",
            toolName: "find_record",
            title: "Find record",
            description: "Find a record.",
            riskLevel: "read",
          },
        ],
        canMakeChanges: [],
      },
      catalog: [],
      suggestedDefaults: {},
    });
    await render();

    expect(container.textContent).toContain("Step 1 of 4");
    expect(container.textContent).toContain("Connect Zapier");
    expect(container.textContent).toContain("Add MCP URL");
    expect(container.querySelector('img[src="https://example.com/zapier.png"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Pick the app you want your agents to use.");
    expect(container.textContent).not.toContain("More ways to connect");

    const linkInput = container.querySelector<HTMLInputElement>(
      'input[placeholder^="https://mcp.zapier.com"]',
    );
    const zapierUrl = "https://mcp.zapier.com/api/v1/connect?token=secret-token";
    await act(async () => setInputValue(linkInput!, zapierUrl));
    await flushReact();

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(connectAppMock.mock.calls[0]?.[1]).toMatchObject({ link: zapierUrl, name: "Zapier" });
    expect(container.textContent).toContain("Step 2 of 4");
    expect(container.querySelector('img[src="https://example.com/zapier.png"]')).toBeTruthy();

    await act(async () => {
      buttonByText("Continue with 1 action on")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Step 3 of 4");
    expect(container.querySelector('img[src="https://example.com/zapier.png"]')).toBeTruthy();

    await act(async () => {
      buttonContaining("Only specific agents")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Select agents");
    expect(container.textContent).not.toContain("Ada");
    expect(container.textContent).not.toContain("Grace");

    await act(async () => {
      buttonByText("Select agents")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Ada");
    expect(document.body.textContent).toContain("Grace");

    const adaCheckbox = document.body.querySelector<HTMLElement>('[aria-label="Allow Ada"]');
    await act(async () => {
      adaCheckbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await act(async () => {
      buttonByText("Done")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("1 agent selected");
    expect(container.textContent).not.toContain("Grace");

    await act(async () => {
      buttonByText("Continue to install")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Step 4 of 4");
    expect(container.textContent).toContain("Install Zapier tools?");
    expect(container.textContent).toContain("Not yet");

    await act(async () => {
      buttonContaining("Specific agents")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("1 agent selected");
    await act(async () => {
      buttonByText("Finish setup")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(finishAppMock).toHaveBeenCalledWith("company-1", "conn-1", {
      enabledCatalogEntryIds: ["action-1"],
      askFirstCatalogEntryIds: [],
      access: { agentIds: ["agent-1"] },
    });
    expect(putConnectionInstallsMock).toHaveBeenCalledWith("conn-1", [
      { targetType: "agent", targetId: "agent-1" },
    ]);
  });

  // PAP-10922: "Run your own" / "Paste a config" moved from the sidebar to rows
  // under "Connect with a link" on the gallery step.
  it("offers 'Run your own' and 'Paste a config' rows that route into the Advanced door", async () => {
    await render();

    expect(container.textContent).toContain("More ways to connect");

    const buttonContaining = (text: string) =>
      Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(text),
      );

    await act(async () => {
      buttonContaining("Run your own")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockNavigate).toHaveBeenCalledWith("/apps/advanced");

    await act(async () => {
      buttonContaining("Paste a config")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockNavigate).toHaveBeenCalledWith("/apps/advanced/paste-config");
  });

  // PAP-11091: discoverability copy for remote MCP URLs — the link field
  // advertises that any remote tool URL (incl. a local MCP server) works. Per
  // the UX re-review, the localhost example lives in the body copy (legible at
  // every viewport) rather than the placeholder, which truncated on mobile.
  it("advertises that remote/local MCP URLs work under 'Connect with a link'", async () => {
    await render();

    expect(container.textContent).toContain(
      "Any remote tool URL works here — including a local MCP server like",
    );
    expect(container.textContent).toContain("http://127.0.0.1:8848/mcp");
    const linkInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find((i) =>
      i.getAttribute("placeholder")?.startsWith("https://example.com/actions"),
    );
    // Placeholder stays a single, short example so it never truncates.
    expect(linkInput?.getAttribute("placeholder")).toBe("https://example.com/actions");
  });

  // Reconnect from the app page: ?link/?name/?applicationId prefill skips the
  // gallery and re-attaches the connection to the existing application.
  it("prefills the link frame from search params and passes applicationId to connect", async () => {
    mockSearch.value =
      "link=https%3A%2F%2Fwww.example.com%2Factions&name=Bla&applicationId=app-77";
    await render();

    expect(container.textContent).toContain("Connect with a link");
    expect(container.textContent).toContain("https://www.example.com/actions");
    const nameInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (i) => i.getAttribute("placeholder") === "My app",
    );
    expect(nameInput?.value).toBe("Bla");

    await act(async () => {
      buttonByText("Check link")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      link: "https://www.example.com/actions",
      name: "Bla",
      applicationId: "app-77",
    });
  });

  it("shows the Google Sheets robot email and keeps empty sheet links from continuing", async () => {
    listGalleryMock.mockResolvedValueOnce({
      apps: [
        { ...GOOGLE_SHEETS, availability: { available: true, robotEmail: "robot@paperclip.iam.gserviceaccount.com" } },
      ],
    });
    await render();

    await act(async () => {
      buttonContaining("Google Sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Share each sheet with this email");
    expect(container.textContent).toContain("robot@paperclip.iam.gserviceaccount.com");
    expect(container.textContent).toContain(
      "In Google Sheets, click Share and add this email as an Editor. Then paste the sheet links below.",
    );
    expect(buttonByText("Connect")?.disabled).toBe(true);
  });

  it("shows inline validation for invalid Google Sheets links", async () => {
    listGalleryMock.mockResolvedValueOnce({
      apps: [
        { ...GOOGLE_SHEETS, availability: { available: true, robotEmail: "robot@paperclip.iam.gserviceaccount.com" } },
      ],
    });
    await render();

    await act(async () => {
      buttonContaining("Google Sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () => setTextareaValue(textarea!, "https://example.com/not-a-sheet"));
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("That doesn't look like a Google Sheets link.");
    expect(connectAppMock).not.toHaveBeenCalled();
  });

  // PAP-11283: the gallery step exposes a Name field (default = app name) so a
  // connection can be named at create time, matching the link flow.
  function nameInputFrom(root: HTMLDivElement): HTMLInputElement | undefined {
    return Array.from(root.querySelectorAll<HTMLInputElement>("input")).find(
      (i) => i.getAttribute("placeholder") === "My app",
    );
  }

  it("gallery key step defaults the Name field to the app name", async () => {
    await render();

    await act(async () => {
      buttonContaining("Zapier")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Connect Zapier");
    expect(nameInputFrom(container)?.value).toBe("Zapier");
    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect?byo=1&appKey=zapier&stage=setup");
  });

  it("returns from an app key step to the BYO gallery", async () => {
    mockSearch.value = "byo=1";
    mockParams.appKey = "zapier";
    await render();

    await act(async () => {
      buttonByText("Back")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect?byo=1");
  });

  it("leaving the default name connects with the app name", async () => {
    await render();

    await act(async () => {
      buttonContaining("Zapier")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const keyField = container.querySelector<HTMLInputElement>("input[type=password]");
    await act(async () => setInputValue(keyField!, "secret-key"));
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/apps/connect?byo=1&appKey=zapier&stage=actions");
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({ galleryKey: "zapier", name: "Zapier" });
  });

  it("a custom name in the gallery step is sent to the connect mutation", async () => {
    await render();

    await act(async () => {
      buttonContaining("Zapier")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    await act(async () => setInputValue(nameInputFrom(container)!, "Zapier (stdio smoke)"));
    const keyField = container.querySelector<HTMLInputElement>("input[type=password]");
    await act(async () => setInputValue(keyField!, "secret-key"));
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({ galleryKey: "zapier", name: "Zapier (stdio smoke)" });
  });

  it("a custom name on the Google Sheets step is sent to the connect mutation", async () => {
    listGalleryMock.mockResolvedValueOnce({
      apps: [
        { ...GOOGLE_SHEETS, availability: { available: true, robotEmail: "robot@paperclip.iam.gserviceaccount.com" } },
      ],
    });
    await render();

    await act(async () => {
      buttonContaining("Google Sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Default is the app name.
    expect(nameInputFrom(container)?.value).toBe("Google Sheets");
    await act(async () => setInputValue(nameInputFrom(container)!, "Google Sheets (stdio smoke)"));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () =>
      setTextareaValue(textarea!, "https://docs.google.com/spreadsheets/d/sheet_123/edit"),
    );
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      galleryKey: "google-sheets",
      name: "Google Sheets (stdio smoke)",
      configValues: { allowedSpreadsheetIds: ["sheet_123"] },
    });
  });

  it("passes parsed Google Sheets IDs as connection config values", async () => {
    listGalleryMock.mockResolvedValueOnce({
      apps: [
        { ...GOOGLE_SHEETS, availability: { available: true, robotEmail: "robot@paperclip.iam.gserviceaccount.com" } },
      ],
    });
    await render();

    await act(async () => {
      buttonContaining("Google Sheets")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () =>
      setTextareaValue(
        textarea!,
        "https://docs.google.com/spreadsheets/d/sheet_123/edit\nhttps://docs.google.com/spreadsheets/d/sheet_456",
      )
    );
    await flushReact();
    await act(async () => {
      buttonByText("Connect")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(connectAppMock).toHaveBeenCalledTimes(1);
    const [, input] = connectAppMock.mock.calls[0];
    expect(input).toMatchObject({
      galleryKey: "google-sheets",
      configValues: { allowedSpreadsheetIds: ["sheet_123", "sheet_456"] },
    });
  });
});
