// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSetupProgress, AgentSetupProgressHandoff, AwsConnectionSetup } from "@paperclipai/shared";
import type { AgentSetupProgressClient } from "@/components/AgentSetupProgress";
import { AwsRoleSetup, awsAgentSetupPrompt, awsCliCommands, awsSetupErrorMessage, type AwsRoleSetupClient } from "./AwsRoleSetup";
import { ApiError } from "@/api/client";

vi.mock("@/api/tools", () => ({ toolsApi: {} }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "user-1", settled: true, current: true }) }));

const READY: AwsConnectionSetup = {
  available: true,
  issuer: "https://acme.paperclip.app/oidc/companies/company-1",
  audience: "sts.amazonaws.com",
  subject: "connection:conn-1",
  providerHost: "acme.paperclip.app/oidc/companies/company-1",
  roleName: "paperclip-conn-1",
  savedRoleArn: null,
  accessLevel: "read_only",
  trustPolicy: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: "arn:aws:iam::ACCOUNT_ID:oidc-provider/acme.paperclip.app/oidc/companies/company-1" } }] },
  cloudFormationTemplate: "{\"Resources\":{}}\n",
  cloudFormationConsoleUrl: "https://console.aws.amazon.com/cloudformation/home#/stacks/create",
  issuerPublished: true,
};
const ROLE_ARN = "arn:aws:iam::123456789012:role/paperclip-conn-1";
type Ready = Extract<AwsConnectionSetup, { available: true }>;

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AwsRoleSetup", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(setup: AwsConnectionSetup, props: Partial<Parameters<typeof AwsRoleSetup>[0]> = {}) {
    const client: AwsRoleSetupClient = { setup: vi.fn(async () => setup) };
    const onTest = vi.fn();
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AwsRoleSetup connectionId="conn-1" client={client} onBack={vi.fn()} onTest={onTest} {...props} />
        </QueryClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    return { client, onTest };
  }
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

  it("shows only the agent setup by default, then tests with the pasted role ARN", async () => {
    const { client, onTest } = await render(READY);
    expect(client.setup).toHaveBeenCalledWith("conn-1", undefined);
    expect(container.querySelector('button[aria-label="Set it up with your agent"]')).not.toBeNull();
    expect(container.textContent).toContain("Or do it by hand");
    expect(container.textContent).not.toContain("Download template");
    const test = () => button("Test connection")!;
    expect(test().disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>("#aws-role-arn")!;
    await act(async () => { setInput(input, "not-an-arn"); });
    expect(container.textContent).toContain("Use the full role ARN");
    expect(test().disabled).toBe(true);
    await act(async () => { setInput(input, ` ${ROLE_ARN} `); });
    expect(test().disabled).toBe(false);
    await act(async () => { test().click(); });
    expect(onTest).toHaveBeenCalledWith(ROLE_ARN);
  });

  it("fills in a role ARN saved earlier", async () => {
    await render({ ...READY, savedRoleArn: ROLE_ARN } as AwsConnectionSetup);
    expect(container.querySelector<HTMLInputElement>("#aws-role-arn")!.value).toBe(ROLE_ARN);
    expect(button("Test connection")?.disabled).toBe(false);
  });

  it("shows CloudFormation and IAM steps by hand, with CLI commands that read the account", async () => {
    await render(READY);
    await act(async () => { button("Or do it by hand")?.click(); });
    expect(container.textContent).toContain("With CloudFormation");
    expect(container.textContent).toContain("copy RoleArn from its Outputs tab");
    expect(container.textContent).toContain("replacing ACCOUNT_ID with your AWS account ID");
    const cli = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="AWS CLI commands"]')!.value;
    expect(cli).toContain("ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)");
    expect(cli).toContain("arn:aws:iam::${ACCOUNT_ID}:oidc-provider/");
    expect(cli).toContain("--role-name paperclip-conn-1");
    expect(cli).toContain("arn:aws:iam::aws:policy/ReadOnlyAccess");
    expect(cli).toContain("aws iam get-role --role-name paperclip-conn-1 --query Role.Arn --output text");
  });

  it("gives the user's agent a prompt that deploys this connection's template and reports the role ARN", () => {
    const prompt = awsAgentSetupPrompt(READY as Ready);
    expect(prompt).toContain("aws sts get-caller-identity");
    expect(prompt).toContain("--stack-name paperclip-conn-1 ");
    expect(prompt).toContain("CAPABILITY_NAMED_IAM");
    expect(prompt).toContain("RoleArn output");
    expect(prompt).toContain("connection:conn-1");
    expect(prompt).toContain((READY as Ready).cloudFormationTemplate.trimEnd());
    expect(prompt).not.toContain("AccessPolicyArn=<policy ARN>");
    const full = awsAgentSetupPrompt({ ...READY, accessLevel: "full" } as Ready);
    expect(full).toContain("ask me which managed policy");
    expect(full).toContain("AccessPolicyArn=<policy ARN>");
  });

  it("updates the connection's role on reconnect, checks its account, with CLI commands that paste as is", async () => {
    const setup = { ...READY, savedRoleArn: ROLE_ARN, accessLevel: "full" } as Ready;
    await render(setup);
    expect(container.textContent).toContain("It updates the existing role");
    await act(async () => { button("Or do it by hand")?.click(); });
    expect(container.textContent).toContain("Update the role");
    const roleRow = [...container.querySelectorAll("div")].find((d) => d.firstElementChild?.textContent === "Role name");
    expect(roleRow?.querySelector("code")?.textContent).toBe("paperclip-conn-1");
    const cli = awsCliCommands(setup);
    expect(cli).toContain("if aws iam get-role --role-name paperclip-conn-1");
    expect(cli).toContain("aws iam update-assume-role-policy --role-name paperclip-conn-1");
    expect(cli).toContain("|| aws iam create-open-id-connect-provider");
    expect(cli).toContain("REPLACE_WITH_POLICY_ARN");
    expect(cli).not.toMatch(/<[^<>\n]*>/);
    const prompt = awsAgentSetupPrompt(setup);
    expect(prompt).toContain(`Update the AWS IAM role ${ROLE_ARN}`);
    // The agent stops when the CLI is signed in to another account than the role's.
    expect(prompt).toContain("The role is in account 123456789012: if the CLI uses a different account");
    expect(prompt).toContain("creates the stack, or updates it if it already exists");
    expect(prompt).toContain("If the stack paperclip-conn-1 already exists and its value is true");
    expect(prompt).toContain("keep true so the stack keeps owning its provider. Otherwise run `aws iam list-open-id-connect-providers`");
  });

  it("asks for the access policy when the connection has full access", async () => {
    await render({ ...READY, accessLevel: "full" } as AwsConnectionSetup);
    await act(async () => { button("Or do it by hand")?.click(); });
    expect(container.textContent).toContain("Set AccessPolicyArn to the managed policy agents should have");
    expect(container.textContent).not.toContain("so it needs no edits");
  });

  it("downloads the template generated for this connection", async () => {
    await render(READY);
    await act(async () => { button("Or do it by hand")?.click(); });
    const createObjectURL = vi.fn(() => "blob:template");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    let downloaded = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloaded = this.download; });
    await act(async () => { [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Download template"))?.click(); });
    expect(downloaded).toBe("paperclip-aws-paperclip-conn-1.json");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:template");
  });

  it("adds live progress reporting to the prompt and shows the agent's checklist", async () => {
    const progress: AgentSetupProgress = {
      id: "11111111-1111-4111-8111-111111111111", companyId: "company-1", purpose: "aws_connection", subjectId: "conn-1",
      status: "waiting", items: [], summary: null, expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(), createdAt: "2026-11-23T14:00:00.000Z", updatedAt: "2026-11-23T14:00:00.000Z",
    };
    const base = `https://acme.paperclip.app/api/agent-setup-progress/${progress.id}`;
    const handoff: AgentSetupProgressHandoff = { progress, token: "pcsp_test", urls: { checklist: `${base}/checklist`, item: `${base}/items/{key}`, finish: `${base}/finish` } };
    // Live updates are covered in AgentSetupProgress.test.tsx; here the agent has not reported yet.
    const progressClient: AgentSetupProgressClient = { create: vi.fn(async () => handoff), get: vi.fn(async () => progress) };
    await render(READY, { companyId: "company-1", progressClient });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // Creating the checklist is asynchronous: wait for it rather than assume one tick is enough.
    await vi.waitFor(() => expect(container.textContent).toContain("Paste the prompt into your agent. Its steps appear here as it works."));
    expect(progressClient.create).toHaveBeenCalledWith("company-1", { purpose: "aws_connection", subjectId: "conn-1" });
    const prompt = awsAgentSetupPrompt(READY as Ready, "PROGRESS");
    expect(prompt).toContain("Also put it in your finish summary");
    // Progress reporting comes first, so the agent sets its checklist before it starts.
    expect(prompt.indexOf("PROGRESS")).toBeLessThan(prompt.indexOf("Steps:"));
  });

  it("says when live progress is unavailable, keeps the prompt, and tries again", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
      progress: { id: "11111111-1111-4111-8111-111111111111", companyId: "company-1", purpose: "aws_connection", subjectId: "conn-1",
        status: "waiting", items: [], summary: null, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        createdAt: "2026-11-23T14:00:00.000Z", updatedAt: "2026-11-23T14:00:00.000Z" },
      token: "pcsp_test", urls: { checklist: "https://x/checklist", item: "https://x/items/{key}", finish: "https://x/finish" },
    });
    const progressClient: AgentSetupProgressClient = { create, get: vi.fn(async () => { throw new Error("unused"); }) };
    await render(READY, { companyId: "company-1", progressClient });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await vi.waitFor(() => expect(container.textContent).toContain("Live progress isn’t available"));
    expect(container.querySelector('button[aria-label="Set it up with your agent"]')).not.toBeNull();
    await act(async () => { button("Try again")?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(create).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Live progress isn’t available");
    await vi.waitFor(() => expect(container.textContent).toContain("Paste the prompt into your agent."));
  });

  it("points to the access-key method when AWS cannot reach this instance, without starting a checklist", async () => {
    const progressClient: AgentSetupProgressClient = { create: vi.fn(), get: vi.fn() };
    await render({ available: false, reason: "loopback" }, { companyId: "company-1", progressClient });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // No prompt can carry a checklist here, so none is created.
    expect(progressClient.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Use an access key instead");
    expect(container.textContent).toContain("runs on this computer only");
    expect(button("Test connection")?.disabled).toBe(true);
  });

  it("shows the server's AWS message even when setup reports it with a gateway status", () => {
    const message = "AWS refused this connection's role. Check that the role exists and trusts this connection.";
    const awsError = new ApiError(message, 502, { error: message, code: "aws_role_access_denied", details: { code: "aws_role_access_denied" } });
    expect(awsSetupErrorMessage(awsError)).toBe(message);
    const other = new ApiError("Bad Gateway", 502, { error: "upstream", details: { code: "mcp_remote_fetch_failed" } });
    expect(awsSetupErrorMessage(other)).not.toContain("upstream");
  });

  it("explains a failed test in place", async () => {
    await render(READY, { error: "AWS refused this connection's role. Check that the role exists and trusts this connection." });
    expect(container.textContent).toContain("AWS didn’t accept the connection yet");
    expect(container.textContent).toContain("AWS refused this connection's role");
  });

  it("asks to save the connection again instead of showing steps for an old address", async () => {
    await render({ available: false, reason: "address_changed" });
    expect(container.textContent).toContain("Save the connection again");
    expect(container.textContent).not.toContain("Create it with CloudFormation");
    expect(button("Test connection")?.disabled).toBe(true);
  });
});
