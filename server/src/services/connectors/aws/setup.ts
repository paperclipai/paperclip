import { AWS_MCP_STS_AUDIENCE, AWS_ROLE_ARN_PATTERN } from "./mcp-credentials.js";

/**
 * What a customer configures in AWS for an AWS role connection: an IAM OIDC
 * identity provider for the company's issuer, and a role that trusts exactly
 * this connection. Everything is generated for one connection, so the template
 * needs no hand-entered values.
 */

const SIGN_IN_POLICY = "AWSMCPSignInOAuthAccessPolicy";

/** The saved role ARN is not one IAM accepts (for example a trailing slash or a name over 64 characters). */
export class AwsRoleArnError extends Error {
  constructor() {
    super("This role ARN is not valid. Use arn:aws:iam::<account>:role/<name>, optionally with a path like role/team/<name>; role names have at most 64 characters.");
    this.name = "AwsRoleArnError";
  }
}

export interface AwsRoleSetupInput {
  issuer: string;
  connectionId: string;
  roleArn: string;
  /** Read-only connections default the template to ReadOnlyAccess; full access asks for the policy. */
  accessLevel: "read_only" | "full";
}

export interface AwsRoleSetup {
  issuer: string;
  audience: string;
  subject: string;
  /** The issuer without its scheme: IAM's provider URL and the prefix of the trust condition keys. */
  providerHost: string;
  roleArn: string;
  accountId: string;
  roleName: string;
  rolePath: string;
  accessLevel: "read_only" | "full";
  trustPolicy: Record<string, unknown>;
  /** A CloudFormation template (JSON) that creates the identity provider (optional) and the role. */
  cloudFormationTemplate: string;
  cloudFormationConsoleUrl: string;
}

export function awsRoleSetup(input: AwsRoleSetupInput): AwsRoleSetup {
  const parts = AWS_ROLE_ARN_PATTERN.exec(input.roleArn);
  if (!parts) throw new AwsRoleArnError();
  const [, partition, accountId, pathPrefix, roleName] = parts as unknown as [string, string, string, string, string];
  const providerHost = input.issuer.replace(/^https:\/\//, "");
  const subject = `connection:${input.connectionId}`;
  const condition = {
    StringEquals: {
      [`${providerHost}:aud`]: AWS_MCP_STS_AUDIENCE,
      [`${providerHost}:sub`]: subject,
    },
  };
  const providerArn = `arn:${partition}:iam::${accountId}:oidc-provider/${providerHost}`;
  const trustPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: providerArn },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: condition,
    }],
  };
  const rolePath = `/${pathPrefix}`;
  const template = {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Paperclip AWS connection: an IAM role that trusts only ${subject} from ${input.issuer}.`,
    Parameters: {
      CreateIdentityProvider: {
        Type: "String",
        AllowedValues: ["true", "false"],
        Default: "true",
        Description: "Choose false if this account already has an IAM identity provider for this Paperclip issuer.",
      },
      AccessPolicyArn: input.accessLevel === "read_only"
        ? {
            Type: "String",
            Default: `arn:${partition}:iam::aws:policy/ReadOnlyAccess`,
            Description: "The managed policy that decides what agents can do. This connection is read only, so ReadOnlyAccess fits.",
          }
        : {
            Type: "String",
            AllowedPattern: "^arn:aws[a-z-]*:iam::(aws|[0-9]{12}):policy/.+$",
            ConstraintDescription: "Enter the ARN of a managed policy.",
            Description: "Required. The managed policy that decides what agents can change in this account.",
          },
    },
    Conditions: {
      CreateProvider: { "Fn::Equals": [{ Ref: "CreateIdentityProvider" }, "true"] },
    },
    Resources: {
      PaperclipIdentityProvider: {
        Type: "AWS::IAM::OIDCProvider",
        Condition: "CreateProvider",
        Properties: {
          Url: input.issuer,
          ClientIdList: [AWS_MCP_STS_AUDIENCE],
        },
      },
      PaperclipRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: roleName,
          Path: rolePath,
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Principal: {
                Federated: {
                  "Fn::If": [
                    "CreateProvider",
                    { "Fn::GetAtt": ["PaperclipIdentityProvider", "Arn"] },
                    { "Fn::Sub": `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:oidc-provider/${providerHost}` },
                  ],
                },
              },
              Action: "sts:AssumeRoleWithWebIdentity",
              Condition: condition,
            }],
          },
          ManagedPolicyArns: [
            { Ref: "AccessPolicyArn" },
            { "Fn::Sub": `arn:\${AWS::Partition}:iam::aws:policy/${SIGN_IN_POLICY}` },
          ],
        },
      },
    },
    Outputs: {
      RoleArn: { Description: "Paste this into Paperclip if it differs from the role ARN you entered.", Value: { "Fn::GetAtt": ["PaperclipRole", "Arn"] } },
    },
  };
  return {
    issuer: input.issuer,
    audience: AWS_MCP_STS_AUDIENCE,
    subject,
    providerHost,
    roleArn: input.roleArn,
    accountId,
    roleName,
    rolePath,
    accessLevel: input.accessLevel,
    trustPolicy,
    cloudFormationTemplate: `${JSON.stringify(template, null, 2)}\n`,
    cloudFormationConsoleUrl: "https://console.aws.amazon.com/cloudformation/home#/stacks/create",
  };
}
