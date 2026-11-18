// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AwsConnectionSetup } from "@paperclipai/shared";
import { AwsRoleSetup, awsAgentSetupPrompt, awsSetupErrorMessage, type AwsRoleSetupClient } from "./AwsRoleSetup";
import { ApiError } from "@/api/client";

vi.mock("@/api/tools", () => ({ toolsApi: {} }));

const READY: AwsConnectionSetup = {
  available: true,
  issuer: "https://acme.paperclip.app/oidc/companies/company-1",
  audience: "sts.amazonaws.com",
  subject: "connection:conn-1",
  providerHost: "acme.paperclip.app/oidc/companies/company-1",
  roleArn: "arn:aws:iam::123456789012:role/paperclip-agents",
  accountId: "123456789012",
  roleName: "paperclip-agents",
  rolePath: "/",
  accessLevel: "read_only",
  trustPolicy: { Version: "2012-10-17", Statement: [{ Effect: "Allow" }] },
  cloudFormationTemplate: "{\"Resources\":{}}\n",
  cloudFormationConsoleUrl: "https://console.aws.amazon.com/cloudformation/home#/stacks/create",
  issuerPublished: true,
};

describe("AwsRoleSetup", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
      root.render(<AwsRoleSetup connectionId="conn-1" client={client} onBack={vi.fn()} onTest={onTest} {...props} />);
    });
    await act(async () => { await Promise.resolve(); });
    return { client, onTest };
  }
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

  it("shows the account, the steps and the values for this connection, then tests", async () => {
    const { client, onTest } = await render(READY);
    expect(client.setup).toHaveBeenCalledWith("conn-1");
    expect(container.textContent).toContain("Create it with CloudFormation");
    expect(container.textContent).toContain("123456789012");
    expect(container.querySelector('a[href="https://console.aws.amazon.com/cloudformation/home#/stacks/create"]')?.getAttribute("rel")).toBe("noreferrer");
    expect(button("Test connection")?.disabled).toBe(false);
    await act(async () => { button("Test connection")?.click(); });
    expect(onTest).toHaveBeenCalledOnce();
  });

  it("keeps a role path in the by-hand steps and the CLI commands", async () => {
    const pathed = { ...READY, roleArn: "arn:aws:iam::123456789012:role/agents/paperclip-ops", roleName: "paperclip-ops", rolePath: "/agents/" } as AwsConnectionSetup;
    await render(pathed);
    await act(async () => { button("Set it up by hand instead")?.click(); });
    expect(container.textContent).toContain("arn:aws:iam::123456789012:role/agents/paperclip-ops");
    expect(container.textContent).toContain("which the IAM console cannot set");
    const cli = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="AWS CLI commands"]')!.value;
    expect(cli).toContain("--path /agents/ --role-name paperclip-ops");
    expect(cli).toContain("AWSMCPSignInOAuthAccessPolicy");
    expect(cli).toContain("arn:aws:iam::aws:policy/ReadOnlyAccess");
  });

  it("offers a prompt for the user's own agent that deploys this connection's template", async () => {
    await render(READY);
    expect(container.querySelector('button[aria-label="Set it up with your agent"]')).not.toBeNull();
    const prompt = awsAgentSetupPrompt(READY as Extract<AwsConnectionSetup, { available: true }>);
    expect(prompt).toContain("confirm the account is 123456789012");
    expect(prompt).toContain("--stack-name paperclip-conn-1 ");
    expect(prompt).toContain("CAPABILITY_NAMED_IAM");
    expect(prompt).toContain("connection:conn-1");
    expect(prompt).toContain(READY.available ? READY.cloudFormationTemplate.trimEnd() : "");
    expect(prompt).not.toContain("AccessPolicyArn=<policy ARN>");
    const full = awsAgentSetupPrompt({ ...READY, accessLevel: "full" } as Extract<AwsConnectionSetup, { available: true }>);
    expect(full).toContain("ask me which managed policy");
    expect(full).toContain("AccessPolicyArn=<policy ARN>");
  });

  it("asks for the access policy when the connection has full access", async () => {
    await render({ ...READY, accessLevel: "full" } as AwsConnectionSetup);
    expect(container.textContent).toContain("Set AccessPolicyArn to the managed policy agents should have");
    expect(container.textContent).not.toContain("so it needs no edits");
  });

  it("downloads the template generated for this connection", async () => {
    await render(READY);
    const createObjectURL = vi.fn(() => "blob:template");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    let downloaded = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloaded = this.download; });
    await act(async () => { [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Download template"))?.click(); });
    expect(downloaded).toBe("paperclip-aws-paperclip-agents.json");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:template");
  });

  it("points to the access-key method when AWS cannot reach this instance", async () => {
    await render({ available: false, reason: "loopback" });
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
