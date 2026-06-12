// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsConnect } from "./AppsConnect";

const listGalleryMock = vi.hoisted(() => vi.fn());
const connectAppMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => ({ value: "" }));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    connectApp: (companyId: string, input: unknown) => connectAppMock(companyId, input),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn() },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
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

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
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
    container = document.createElement("div");
    document.body.appendChild(container);
    listGalleryMock.mockResolvedValue({
      apps: [
        {
          key: "zapier",
          name: "Zapier",
          tagline: "Automate things",
          authKind: "api_key",
          urlPatterns: ["https://zapier.com/*", "https://*.zapier.com/*"],
          logoUrl: null,
          credentialFields: [{ configPath: "credentials.authorization", label: "API key", required: true }],
        },
      ],
    });
    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: "example.com" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
    });
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

  it("a recognized domain offers a 'Use Zapier' shortcut into the app's key step (M3b)", async () => {
    await render();

    const linkInput = Array.from(
      container.querySelectorAll<HTMLInputElement>("input"),
    ).find((i) => i.getAttribute("placeholder")?.startsWith("https://"));
    await act(async () => setInputValue(linkInput!, "https://zapier.com/app/abc"));
    await flushReact();

    // The matcher recognizes the domain and surfaces a shortcut card.
    expect(container.textContent).toContain("This looks like Zapier.");

    await act(async () => {
      buttonByText("Use Zapier")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // M3b for the matched app: titled "Connect Zapier", not the generic link frame.
    expect(container.textContent).toContain("Connect Zapier");
    expect(container.textContent).not.toContain("Does it need a key?");
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
});
