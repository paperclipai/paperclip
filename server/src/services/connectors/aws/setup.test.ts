import { describe, expect, it } from "vitest";
import { AwsRoleArnError, awsRoleSetup } from "./setup.js";

const ISSUER = "https://acme.paperclip.app/oidc/companies/company-1";
const HOST = "acme.paperclip.app/oidc/companies/company-1";

function template(setup: ReturnType<typeof awsRoleSetup>) {
  return JSON.parse(setup.cloudFormationTemplate);
}

describe("awsRoleSetup", () => {
  it("builds a role that trusts only this connection, with the sign-in policy and a one-hour session", () => {
    const setup = awsRoleSetup({ issuer: ISSUER, connectionId: "conn-1", roleArn: "arn:aws:iam::123456789012:role/team/ops", accessLevel: "read_only" });
    expect(setup).toMatchObject({ accountId: "123456789012", roleName: "ops", rolePath: "/team/", subject: "connection:conn-1", providerHost: HOST });
    const t = template(setup);
    const role = t.Resources.PaperclipRole.Properties;
    expect(role).toMatchObject({ RoleName: "ops", Path: "/team/", MaxSessionDuration: 3600 });
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
    expect(t.Conditions.CreateProvider).toEqual({ "Fn::Equals": [{ Ref: "CreateIdentityProvider" }, "true"] });
    expect(t.Parameters.AccessPolicyArn.Default).toBe("arn:aws:iam::aws:policy/ReadOnlyAccess");
    expect(setup.trustPolicy).toMatchObject({ Statement: [{ Principal: { Federated: `arn:aws:iam::123456789012:oidc-provider/${HOST}` } }] });
  });

  it("asks for the access policy instead of defaulting to read only when the connection has full access", () => {
    const t = template(awsRoleSetup({ issuer: ISSUER, connectionId: "c", roleArn: "arn:aws:iam::123456789012:role/ops", accessLevel: "full" }));
    expect(t.Parameters.AccessPolicyArn.Default).toBeUndefined();
    expect(t.Parameters.AccessPolicyArn.AllowedPattern).toBeTruthy();
  });

  it("refuses role ARNs IAM would not accept", () => {
    const base = { issuer: ISSUER, connectionId: "c", accessLevel: "read_only" as const };
    for (const roleArn of ["arn:aws:iam::123456789012:role/team/", `arn:aws:iam::123456789012:role/${"x".repeat(65)}`, "arn:aws:iam::12345:role/ops"]) {
      expect(() => awsRoleSetup({ ...base, roleArn })).toThrow(AwsRoleArnError);
    }
    expect(awsRoleSetup({ ...base, roleArn: `arn:aws:iam::123456789012:role/${"x".repeat(64)}` }).rolePath).toBe("/");
  });
});
