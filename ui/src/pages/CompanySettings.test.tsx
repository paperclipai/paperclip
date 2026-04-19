// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CompanySettings } from "./CompanySettings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
  section: undefined as string | undefined,
}));

const companyState = vi.hoisted(() => ({
  companies: [
    {
      id: "company-1",
      name: "Paperclip",
      description: "Runs agents",
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "PAP",
      issueCounter: 0,
      budgetMonthlyCents: 2500,
      spentMonthlyCents: 700,
      devValueHourlyRateCents: 15000,
      devValueTokensPerHour: 100000,
      requireBoardApprovalForNewAgents: true,
      feedbackDataSharingEnabled: false,
      feedbackDataSharingConsentAt: null,
      feedbackDataSharingConsentByUserId: null,
      feedbackDataSharingTermsVersion: null,
      brandColor: "#123456",
      logoAssetId: null,
      logoUrl: null,
      createdAt: new Date("2026-04-18T00:00:00.000Z"),
      updatedAt: new Date("2026-04-18T00:00:00.000Z"),
    },
  ],
  selectedCompanyId: "company-1",
  selectedCompany: null as any,
  setSelectedCompanyId: vi.fn(),
}));
companyState.selectedCompany = companyState.companies[0];

const breadcrumbsState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const themeState = vi.hoisted(() => ({
  effectiveTheme: "dark",
  theme: "dark",
  themePreference: "dark",
  setThemePreference: vi.fn(),
  setTheme: vi.fn(),
  toggleTheme: vi.fn(),
}));

const companiesApiMock = vi.hoisted(() => ({
  update: vi.fn(),
  archive: vi.fn(),
}));

const accessApiMock = vi.hoisted(() => ({
  createCompanyInvite: vi.fn(),
  createOpenClawInvitePrompt: vi.fn(),
  getInviteOnboarding: vi.fn(),
}));

const assetsApiMock = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const budgetsApiMock = vi.hoisted(() => ({
  updateCompanyBudget: vi.fn(),
}));

const routinesApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const companySkillsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const pluginsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const secretsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  rotate: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({
    children,
    className,
    to,
    ...props
  }: Omit<ComponentProps<"a">, "className"> & {
    to: string;
    className?: string | ((input: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
  useParams: () => ({ section: routeState.section }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbsState,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => themeState,
}));

vi.mock("../api/companies", () => ({
  companiesApi: companiesApiMock,
}));

vi.mock("../api/access", () => ({
  accessApi: accessApiMock,
}));

vi.mock("../api/assets", () => ({
  assetsApi: assetsApiMock,
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: budgetsApiMock,
}));

vi.mock("../api/routines", () => ({
  routinesApi: routinesApiMock,
}));

vi.mock("../api/companySkills", () => ({
  companySkillsApi: companySkillsApiMock,
}));

vi.mock("../api/plugins", () => ({
  pluginsApi: pluginsApiMock,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: secretsApiMock,
}));

vi.mock("../components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: () => <div data-testid="company-pattern-icon" />,
}));

function renderSettings(container: HTMLDivElement): Root {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <CompanySettings />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return root;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((entry) =>
    entry.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

function inputByPlaceholder(container: HTMLElement, text: string) {
  const input = Array.from(container.querySelectorAll("input, textarea")).find((entry) =>
    entry.getAttribute("placeholder") === text,
  ) as HTMLInputElement | HTMLTextAreaElement | undefined;
  if (!input) throw new Error(`Input not found: ${text}`);
  return input;
}

function changeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("CompanySettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    routeState.section = undefined;
    breadcrumbsState.setBreadcrumbs.mockClear();
    toastState.pushToast.mockClear();
    themeState.setThemePreference.mockClear();
    companiesApiMock.update.mockReset();
    companiesApiMock.update.mockResolvedValue(companyState.selectedCompany);
    companiesApiMock.archive.mockReset();
    accessApiMock.createCompanyInvite.mockReset();
    accessApiMock.createCompanyInvite.mockResolvedValue({
      id: "invite-1",
      token: "token-1",
      inviteUrl: "/invite/token-1",
      expiresAt: "2026-04-19T00:00:00.000Z",
      allowedJoinTypes: "both",
    });
    accessApiMock.createOpenClawInvitePrompt.mockReset();
    accessApiMock.createOpenClawInvitePrompt.mockResolvedValue({
      id: "invite-2",
      token: "token-2",
      inviteUrl: "/invite/token-2",
      onboardingTextPath: "/api/invites/token-2/onboarding.txt",
      expiresAt: "2026-04-19T00:00:00.000Z",
      allowedJoinTypes: "agent",
    });
    accessApiMock.getInviteOnboarding.mockReset();
    accessApiMock.getInviteOnboarding.mockResolvedValue({
      onboarding: {
        connectivity: {
          connectionCandidates: ["http://localhost:3100"],
        },
      },
    });
    assetsApiMock.uploadCompanyLogo.mockReset();
    budgetsApiMock.updateCompanyBudget.mockReset();
    budgetsApiMock.updateCompanyBudget.mockResolvedValue(companyState.selectedCompany);
    routinesApiMock.list.mockReset();
    routinesApiMock.list.mockResolvedValue([]);
    companySkillsApiMock.list.mockReset();
    companySkillsApiMock.list.mockResolvedValue([]);
    pluginsApiMock.list.mockReset();
    pluginsApiMock.list.mockResolvedValue([]);
    secretsApiMock.list.mockReset();
    secretsApiMock.list.mockResolvedValue([]);
    secretsApiMock.create.mockReset();
    secretsApiMock.create.mockResolvedValue({});
    secretsApiMock.update.mockReset();
    secretsApiMock.update.mockResolvedValue({});
    secretsApiMock.rotate.mockReset();
    secretsApiMock.rotate.mockResolvedValue({});
    secretsApiMock.remove.mockReset();
    secretsApiMock.remove.mockResolvedValue({ ok: true });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the default general section", () => {
    const root = renderSettings(container);

    expect(container.textContent).toContain("General");
    expect(container.textContent).toContain("Require board approval for new hires");

    act(() => root.unmount());
  });

  it("redirects unknown sections to general", () => {
    routeState.section = "nope";
    const root = renderSettings(container);

    expect(container.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe(
      "/company/settings/general",
    );

    act(() => root.unmount());
  });

  it("sets the system theme preference from appearance", async () => {
    routeState.section = "appearance";
    const root = renderSettings(container);

    await click(container.querySelector('[data-testid="theme-option-system"]') as HTMLElement);

    expect(themeState.setThemePreference).toHaveBeenCalledWith("system");

    act(() => root.unmount());
  });

  it("saves general settings and toggles hiring approval", async () => {
    const root = renderSettings(container);
    const companyNameInput = container.querySelector("input") as HTMLInputElement;

    changeValue(companyNameInput, "Paperclip Labs");
    await click(buttonByText(container, "Save changes"));

    expect(companiesApiMock.update).toHaveBeenCalledWith("company-1", {
      name: "Paperclip Labs",
      description: "Runs agents",
      brandColor: "#123456",
    });

    const approvalToggle = container.querySelector('[data-testid="company-settings-team-approval-toggle"]') as HTMLElement;
    await click(approvalToggle);

    expect(companiesApiMock.update).toHaveBeenCalledWith("company-1", {
      requireBoardApprovalForNewAgents: false,
    });

    act(() => root.unmount());
  });

  it("generates generic and OpenClaw invite artifacts", async () => {
    routeState.section = "access";
    const root = renderSettings(container);

    await click(buttonByText(container, "Generate Invite Link"));
    expect(accessApiMock.createCompanyInvite).toHaveBeenCalledWith("company-1", {
      allowedJoinTypes: "both",
    });
    expect((container.querySelector("input[readonly]") as HTMLInputElement | null)?.value).toBe(
      "http://localhost:3000/invite/token-1",
    );

    await click(buttonByText(container, "Generate OpenClaw Invite Prompt"));
    expect(accessApiMock.createOpenClawInvitePrompt).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("OpenClaw Invite Prompt");
    expect(container.textContent).toContain("http://localhost:3100");

    act(() => root.unmount());
  });

  it("updates company budget and feedback sharing", async () => {
    routeState.section = "budgets";
    const budgetRoot = renderSettings(container);

    changeValue(inputByPlaceholder(container, "Unlimited"), "50");
    await click(buttonByText(container, "Save budget"));

    expect(budgetsApiMock.updateCompanyBudget).toHaveBeenCalledWith("company-1", {
      budgetMonthlyCents: 5000,
    });

    changeValue(inputByPlaceholder(container, "150"), "175");
    changeValue(inputByPlaceholder(container, "100000"), "125000");
    await click(buttonByText(container, "Save estimate"));

    expect(companiesApiMock.update).toHaveBeenCalledWith("company-1", {
      devValueHourlyRateCents: 17500,
      devValueTokensPerHour: 125000,
    });
    act(() => budgetRoot.unmount());

    container.innerHTML = "";
    routeState.section = "data";
    const dataRoot = renderSettings(container);
    const feedbackToggle = container.querySelector('[role="switch"]') as HTMLElement;

    await click(feedbackToggle);

    expect(companiesApiMock.update).toHaveBeenCalledWith("company-1", {
      feedbackDataSharingEnabled: true,
    });
    act(() => dataRoot.unmount());
  });

  it("creates, edits, rotates, and deletes company secrets", async () => {
    routeState.section = "integrations";
    secretsApiMock.list.mockResolvedValue([
      {
        id: "secret-1",
        companyId: "company-1",
        name: "OPENAI_API_KEY",
        provider: "local_encrypted",
        externalRef: null,
        latestVersion: 1,
        description: "Primary key",
        createdByAgentId: null,
        createdByUserId: "user-1",
        createdAt: new Date("2026-04-18T00:00:00.000Z"),
        updatedAt: new Date("2026-04-18T00:00:00.000Z"),
      },
    ]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const root = renderSettings(container);
    await flush();

    changeValue(inputByPlaceholder(container, "Secret name"), "ANTHROPIC_API_KEY");
    changeValue(inputByPlaceholder(container, "Secret value"), "sk-test");
    changeValue(inputByPlaceholder(container, "Optional description"), "Claude key");
    await click(buttonByText(container, "Create secret"));

    expect(secretsApiMock.create).toHaveBeenCalledWith("company-1", {
      name: "ANTHROPIC_API_KEY",
      value: "sk-test",
      description: "Claude key",
    });

    await click(buttonByText(container, "Edit"));
    changeValue(container.querySelectorAll("input")[2] as HTMLInputElement, "OPENAI_API_KEY_NEXT");
    await click(buttonByText(container, "Save"));

    expect(secretsApiMock.update).toHaveBeenCalledWith("secret-1", {
      name: "OPENAI_API_KEY_NEXT",
      description: "Primary key",
    });

    changeValue(inputByPlaceholder(container, "New value"), "sk-rotated");
    await click(buttonByText(container, "Rotate"));

    expect(secretsApiMock.rotate).toHaveBeenCalledWith("secret-1", {
      value: "sk-rotated",
    });

    await click(buttonByText(container, "Delete"));

    expect(confirmSpy).toHaveBeenCalled();
    expect(secretsApiMock.remove).toHaveBeenCalledWith("secret-1");

    confirmSpy.mockRestore();
    act(() => root.unmount());
  });
});
