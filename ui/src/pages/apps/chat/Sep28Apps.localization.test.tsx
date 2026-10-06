// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oauthEndpointUrlRejectionMessage, SLACK_TOOLS, slackAppConfigurationSchema } from "@paperclipai/shared";
import { i18n, t } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitHubAgentTrustWarning } from "@/components/GitHubAgentTrustWarning";
import { RemoteMcpConnectionSetup } from "@/features/connections/remote-mcp/RemoteMcpConnectionSetup";
import { remoteMcpProviders } from "@/features/connections/remote-mcp/providers";
import type { RemoteMcpSetupState, RemoteMcpSetupActions } from "@/features/connections/remote-mcp/types";
import { SlackSearchView } from "./SlackToolSettings";
import { githubVerificationText, chatUiErrorMessage, githubReviewStatusLabel, slackAppValidationMessage, slackSearchLimitation, slackToolLabel } from "./chat-copy";

vi.mock("@/features/connections/ConnectionSetupFlow", () => ({
  StepHeader: ({ title, subtitle, labels }: { title?: string; subtitle: string; labels: string[] }) => <header>{title}{subtitle}{labels.join(" · ")}</header>,
  AccessStepContent: () => null,
  ConnectionAccessDefaults: ({ extra }: { extra?: ReactNode }) => <>{extra}</>,
  connectionDefaultSummarySentence: () => "",
}));
vi.mock("@/pages/apps/app-detail/PermissionsPanel", () => ({ ActionsSection: () => null }));

describe("September app localization boundaries", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });
  const render = async (node: ReactNode) => act(async () => root.render(node));
  const language = async (locale: string) => act(async () => { await i18n.changeLanguage(locale); });

  it("keeps the security warning and agent identity intact through EN → RU → EN", async () => {
    await render(<GitHubAgentTrustWarning agent={{ name: "User-owned Agent", permissions: {} }} />);
    const english = container.textContent;
    expect(english).toContain("User-owned Agent");
    expect(container.querySelector('a')?.href).toBe("https://docs.paperclip.ing/administration/trust-and-low-trust-review/");
    await language("ru");
    expect(container.textContent).toContain("User-owned Agent");
    expect(container.textContent).toContain(t("sep28Apps.lowTrustWarning"));
    expect(container.textContent).not.toBe(english);
    await language("en");
    expect(container.textContent).toBe(english);
  });

  it("retranslates a local Slack error without clearing OAuth drafts or resubmitting", async () => {
    const configure = vi.fn().mockRejectedValue(null);
    const connect = vi.fn();
    const disconnect = vi.fn();
    await render(<SlackSearchView status={{ canConfigure: true, configured: false, clientId: "123.456", redirectUri: "https://example.test/oauth", connected: false, nativeSearchAvailable: true, limitation: "" }} onConfigure={configure} onConnect={connect} onDisconnect={disconnect} />);
    const secret = container.querySelector('input[type="password"]')! as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(secret, "synthetic-only-secret");
      secret.dispatchEvent(new Event("input", { bubbles: true }));
      secret.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(configure).toHaveBeenCalledWith({ clientId: "123.456", clientSecret: "synthetic-only-secret" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(t("sep28Apps.copy222"));
    await language("ru");
    expect(secret.value).toBe("synthetic-only-secret");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(t("sep28Apps.copy222"));
    expect(configure).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("updates remote MCP hints and numbered headers without mutating credentials or protocol values", async () => {
    const called = vi.fn();
    let lastState: RemoteMcpSetupState | undefined;
    function Harness() {
      const [state, setState] = useState<RemoteMcpSetupState>({ step: "connect", grantKind: "organization", setupComplete: false, url: "https://example.test/mcp?access=synthetic", auth: "headers", token: "synthetic-token", headers: [{ id: "header-id", name: "X-Identity", value: "synthetic-header" }], connectStatus: "idle", connected: false, identity: null, allAgents: false, agentIds: ["unchanged-agent"], permissions: {}, tools: [], notice: { key: "sep28Apps.headerBoth" }, refreshing: false });
      lastState = state;
      const actions: RemoteMcpSetupActions = { edit: patch => setState(s => ({ ...s, ...patch })), navigate: called, connect: called, cancelConnect: called, openProvider: called, saveExit: called, resumeDraft: called, finish: called, refresh: called, reconnect: called, disconnect: called };
      return <RemoteMcpConnectionSetup companyId="" provider={remoteMcpProviders.arcade} state={state} actions={actions} agents={[]} connectionId="connection-id" host="dialog" />;
    }
    await render(<TooltipProvider><Harness /></TooltipProvider>);
    const values = [...container.querySelectorAll('input')].map(input => input.value);
    const state = JSON.stringify(lastState);
    expect(container.textContent).toContain(t("sep28Apps.numberedHeaderName", { number: 1 }));
    const providerHint = remoteMcpProviders.arcade.urlHelp;
    await language("ru");
    expect(container.textContent).toContain(t("sep28Apps.numberedHeaderName", { number: 1 }));
    expect(container.textContent).toContain(t("sep28Apps.headerBoth"));
    expect(remoteMcpProviders.arcade.urlHelp).not.toBe(providerHint);
    expect([...container.querySelectorAll('input')].map(input => input.value)).toEqual(values);
    expect(JSON.stringify(lastState)).toBe(state);
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe("headers");
    expect(called).not.toHaveBeenCalled();
    await language("en");
    expect(remoteMcpProviders.arcade.urlHelp).toBe(providerHint);
  });

  it("covers all known Slack tools and GitHub states while preserving unknown domain labels", async () => {
    await language("ru");
    for (const tool of SLACK_TOOLS) expect(slackToolLabel(tool.name)).toMatch(/[А-Яа-я]/);
    for (const state of ["queued", "running", "completed", "incomplete", "error", "superseded", "manual_required", "success", "failure", "neutral", "action_required"]) expect(githubReviewStatusLabel(state)).toMatch(/[А-Яа-я]/);
    expect(slackToolLabel("third_party_action")).toBe("third party action");
    expect(githubReviewStatusLabel("future_state")).toBe("future state");
    expect(chatUiErrorMessage("Provider diagnostic ABC-123")).toBe("Provider diagnostic ABC-123");
    expect(slackSearchLimitation("Provider-owned limitation")).toBe("Provider-owned limitation");
    expect(slackSearchLimitation(t("sep28Apps.nativeSearchLimitation", { lng: "en" }))).toBe(t("sep28Apps.nativeSearchLimitation"));
  });

  it("translates only known GitHub verification text and preserves repository/tool identifiers", async () => {
    await language("ru");
    expect(githubVerificationText("Signed webhook delivery")).toBe(t("sep28Apps.verifyDelivery"));
    expect(githubVerificationText("Restore installation access and refresh: Owner/Repo-A, Owner/Repo-B.")).toContain("Owner/Repo-A, Owner/Repo-B");
    expect(githubVerificationText("Repair tool policy for: github_publish_review.")).toContain("github_publish_review");
    expect(githubVerificationText("GitHub confirmed review access to all 5 enabled repositories.")).toBe(t("sep28Apps.verifyRepositoriesOk", { count: 5 }));
    expect(githubVerificationText("Provider diagnostic XYZ 403")).toBe("Provider diagnostic XYZ 403");
  });

  it("translates safe OAuth rejections without changing the validation payload", async () => {
    await language("ru");
    for (const reason of ["missing", "malformed", "unsupported_scheme", "insecure_transport", "embedded_credentials", "fragment"] as const) {
      const message = oauthEndpointUrlRejectionMessage("authorization", reason);
      expect(chatUiErrorMessage(message)).toMatch(/[А-Яа-я]/);
      expect(message).toMatch(/^This server/);
    }
    expect(chatUiErrorMessage("Unrecognized provider diagnostic 403")).toBe("Unrecognized provider diagnostic 403");
  });

  it("localizes known schema validation at the UI boundary", async () => {
    const invalid = slackAppConfigurationSchema.safeParse({ appName: "", botName: "UPPER", command: "/BAD" });
    expect(invalid.success).toBe(false);
    if (invalid.success) return;
    const original = invalid.error.issues.map(issue => issue.message);
    await language("ru");
    for (const issue of invalid.error.issues) expect(slackAppValidationMessage(issue)).toMatch(/[А-Яа-я]/);
    expect(invalid.error.issues.map(issue => issue.message)).toEqual(original);
  });

  it("uses Russian count forms for actions, tools and agents", async () => {
    await language("ru");
    for (const count of [0, 1, 2, 5, 21]) {
      for (const key of ["connectedActions", "identityActions", "tools", "agentsAccess"]) {
        const value = t(`sep28Apps.${key}`, { count, identity: "Unchanged identity" });
        expect(value).toContain(String(count));
        expect(value).not.toMatch(/sep28Apps|{{/);
        expect(value).toMatch(/[А-Яа-я]/);
      }
    }
  });
});
