import { describe, expect, it } from "vitest";
import { APP_DEFINITIONS } from "@paperclipai/shared";
import { AWS_ROLE_ARN_PATTERN } from "./mcp-credentials.js";
import { awsConnectionRoleName, awsRoleSetup } from "./setup.js";

const ISSUER = "https://acme.paperclip.app/oidc/companies/company-1";
const HOST = "acme.paperclip.app/oidc/companies/company-1";

function template(setup: ReturnType<typeof awsRoleSetup>) {
  return JSON.parse(setup.cloudFormationTemplate);
}

describe("awsRoleSetup", () => {
  it("builds a role that trusts only this connection, with the sign-in policy and a one-hour session", () => {
    const setup = awsRoleSetup({ issuer: ISSUER, connectionId: "conn-1", accessLevel: "read_only" });
    expect(setup).toMatchObject({ roleName: "paperclip-conn-1", subject: "connection:conn-1", providerHost: HOST });
    const t = template(setup);
    const role = t.Resources.PaperclipRole.Properties;
    expect(role).toMatchObject({ RoleName: "paperclip-conn-1", MaxSessionDuration: 3600 });
    expect(role.Path).toBeUndefined();
    expect(role.ManagedPolicyArns).toEqual([
      { Ref: "AccessPolicyArn" },
      { "Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/AWSMCPSignInOAuthAccessPolicy" },
    ]);
    const statement = role.AssumeRolePolicyDocument.Statement[0];
    expect(statement.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(statement.Condition.StringEquals).toEqual({ [`${HOST}:aud`]: "sts.amazonaws.com", [`${HOST}:sub`]: "connection:conn-1" });
    // Both identity-provider branches: the one this stack creates, or an existing one in the account.
    expect(statement.Principal.Federated["Fn::If"]).toEqual([
      "CreateProvider",
      { "Fn::GetAtt": ["PaperclipIdentityProvider", "Arn"] },
      { "Fn::Sub": `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:oidc-provider/${HOST}` },
    ]);
    expect(t.Resources.PaperclipIdentityProvider).toMatchObject({ Condition: "CreateProvider", Properties: { Url: ISSUER, ClientIdList: ["sts.amazonaws.com"] } });
    // A stack update that stops creating the provider, or a stack deletion, must not remove a provider other roles trust.
    expect(t.Resources.PaperclipIdentityProvider).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    expect(t.Conditions.CreateProvider).toEqual({ "Fn::Equals": [{ Ref: "CreateIdentityProvider" }, "true"] });
    expect(t.Parameters.AccessPolicyArn.Default).toBe("arn:aws:iam::aws:policy/ReadOnlyAccess");
    expect(setup.trustPolicy).toMatchObject({ Statement: [{ Principal: { Federated: `arn:aws:iam::ACCOUNT_ID:oidc-provider/${HOST}` } }] });
  });

  it("asks for the access policy instead of defaulting to read only when the connection has full access", () => {
    const t = template(awsRoleSetup({ issuer: ISSUER, connectionId: "c", accessLevel: "full" }));
    expect(t.Parameters.AccessPolicyArn.Default).toBeUndefined();
    expect(t.Parameters.AccessPolicyArn.AllowedPattern).toBeTruthy();
  });

  it("names the role after the connection, within IAM's 64 characters", () => {
    const id = "26e99114-bde0-428a-944b-eee3c44366de";
    expect(awsConnectionRoleName(id)).toBe(`paperclip-${id}`);
    expect(awsConnectionRoleName("x".repeat(80))).toHaveLength(64);
    expect(awsConnectionRoleName("a/b c")).toBe("paperclip-a-b-c");
  });
});

describe("role ARN rule", () => {
  it("is the same in the app definition (what the form accepts) and on the server", () => {
    const aws = APP_DEFINITIONS.find((app) => app.slug === "aws")!;
    const patterns = aws.methods.flatMap((method) => [...(method.tenantFields ?? []), ...(method.extensionFields ?? [])])
      .filter((field) => field.key === "roleArn")
      .map((field) => new RegExp(field.validation!.pattern!));
    expect(patterns.length).toBeGreaterThan(0);
    const accepted = [
      "arn:aws:iam::123456789012:role/paperclip-agents",
      "arn:aws:iam::123456789012:role/team/sub/paperclip-ops",
      `arn:aws:iam::123456789012:role/${"x".repeat(64)}`,
      "arn:aws-us-gov:iam::123456789012:role/ops",
    ];
    const rejected = [
      `arn:aws:iam::123456789012:role/${"x".repeat(65)}`,
      "arn:aws:iam::123456789012:role/team/",
      "arn:azure:iam::123456789012:role/ops",
      "arn:aws:iam::12345:role/ops",
      "arn:aws:iam::123456789012:user/ops",
    ];
    for (const arn of [...accepted, ...rejected]) {
      const expected = accepted.includes(arn);
      expect(AWS_ROLE_ARN_PATTERN.test(arn), arn).toBe(expected);
      for (const pattern of patterns) expect(pattern.test(arn), `${pattern} ${arn}`).toBe(expected);
    }
  });
});
