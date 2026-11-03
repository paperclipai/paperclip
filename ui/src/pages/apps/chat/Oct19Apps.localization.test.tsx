// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { slackRegistrationErrorMessage } from "@paperclipai/shared";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { i18n } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OwnSlackAppSetup } from "./slack/OwnSlackAppSetup";
import { ManagedSlackSetup } from "./slack/ManagedSlackSetup";
import { SlackAppDetails } from "./SlackAppDetails";
import { slackRegistrationDisplayError } from "./slack-registration-copy";

const api = vi.hoisted(() => ({ slackSetupOptions: vi.fn(), provisionManagedSlack: vi.fn(), authorizeSlackManager: vi.fn(), createSlackApp: vi.fn(), installSlackApp: vi.fn(), get: vi.fn() }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: api }));
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
const endpoint = { id: "endpoint", companyId: "company", provider: "slack", assignedAgentName: "Original Agent", setup: { slackSetupMethod: "automatic" } } as ChatEndpoint;
const props = () => ({ endpoint, stage: "app" as const, disabled: false, saveDetails: vi.fn(), onSaved: vi.fn(), onBusy: vi.fn(), onSaveExit: vi.fn(), onManual: vi.fn(), onContinue: vi.fn() });
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.resetAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.slackSetupOptions.mockResolvedValue({ managedAvailable: true, workspaces: [{ grantId: "grant", workspaceName: "Original Workspace" }] });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); await i18n.changeLanguage("en"); });
async function language(value: string) { await act(async () => { await i18n.changeLanguage(value); }); }

it("keeps a configuration token and third-party UI names intact through locale changes without making requests", async () => {
  const original = JSON.stringify(endpoint);
  await act(async () => root.render(<OwnSlackAppSetup {...props()} />));
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "synthetic-token+/=");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (const locale of ["en", "ru", "en"]) {
    await language(locale);
    expect(container.querySelector('input[type="password"]')).toBe(input);
    expect(input.value).toBe("synthetic-token+/=");
    expect(container.textContent).toContain(i18n.t("oct19Apps.appConfigurationToken"));
    expect(container.textContent).toContain("Your App Configuration Tokens");
    expect(container.textContent).toContain("Generate Token");
    expect(container.querySelector('a[href="https://api.slack.com/apps"]')).not.toBeNull();
    expect(api.createSlackApp).not.toHaveBeenCalled(); expect(api.installSlackApp).not.toHaveBeenCalled();
    expect(JSON.stringify(endpoint)).toBe(original);
  }
});

it("retains the checked-no-app safety choice and never retries uncertain creation on locale changes", async () => {
  const uncertain = { ...endpoint, setup: { ...endpoint.setup, slackSetupMethod: "managed", slackRegistration: { status: "uncertain", errorCode: "slack_creation_uncertain", managerGrantId: "grant" } } } as ChatEndpoint;
  const original = JSON.stringify(uncertain);
  await act(async () => root.render(<QueryClientProvider client={client}><ManagedSlackSetup {...props()} endpoint={uncertain} autoStart /></QueryClientProvider>));
  await vi.waitFor(() => expect(container.querySelector('[role="checkbox"]')).not.toBeNull());
  const checkbox = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  await act(async () => checkbox.click());
  for (const locale of ["en", "ru", "en"]) {
    await language(locale);
    expect(container.querySelector('[role="checkbox"]')).toBe(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain(i18n.t("oct19Apps.checkedNoSlackApp"));
    expect(container.textContent).toContain(i18n.t("oct19Apps.slackMayHaveCreated"));
    expect(api.provisionManagedSlack).not.toHaveBeenCalled(); expect(api.authorizeSlackManager).not.toHaveBeenCalled();
    expect(JSON.stringify(uncertain)).toBe(original);
  }
});

it("localizes Slack field labels without changing custom names or slash commands", async () => {
  const value = { appName: "Original app", botName: "original-bot", command: "/original-command" };
  const onChange = vi.fn(), onBlur = vi.fn();
  await act(async () => root.render(<TooltipProvider><SlackAppDetails value={value} readOnly={false} onChange={onChange} onBlur={onBlur} /></TooltipProvider>));
  const fields = [...container.querySelectorAll("input")];
  for (const locale of ["en", "ru", "en"]) {
    await language(locale);
    expect([...container.querySelectorAll("input")]).toEqual(fields);
    expect(fields.map(field => field.value)).toEqual(Object.values(value));
    expect(container.textContent).toContain(i18n.t("chatUi.chatEndpointDetail.slashCommand"));
    expect(onChange).not.toHaveBeenCalled(); expect(onBlur).not.toHaveBeenCalled();
  }
});

it("maps every known Slack registration diagnostic while retaining protocol codes", async () => {
  const catalog = i18n.getResourceBundle("en", "translation").oct19Apps as Record<string, string>;
  const codes = Object.keys(catalog).filter(key => key.startsWith("registration_slack_")).map(key => key.slice("registration_".length));
  expect(codes).toHaveLength(21);
  for (const locale of ["en", "ru", "en"]) {
    await language(locale);
    for (const code of codes) {
      expect(slackRegistrationDisplayError(code)).toBe(i18n.t(`oct19Apps.registration_${code}`));
      expect(slackRegistrationErrorMessage(code)).toBe(catalog[`registration_${code}`]);
    }
    for (const code of ["future_code", "__proto__", "constructor"]) expect(slackRegistrationDisplayError(code)).toBe(i18n.t("oct19Apps.registrationFallback"));
  }
});
