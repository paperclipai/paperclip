import { AWS_MCP_STS_AUDIENCE } from "./mcp-credentials.js";
import { workloadIdentitySubject } from "../../workload-identity.js";

/**
 * What a customer configures in AWS for an AWS role connection: an IAM OIDC
 * identity provider for the company's issuer, and a role that trusts exactly
 * this connection. Everything is generated for one connection (the role is named
 * after it, and CloudFormation fills in the account), so nothing is entered by hand
 * until the customer pastes back the role ARN AWS created.
 */

const SIGN_IN_POLICY = "AWSMCPSignInOAuthAccessPolicy";

/** The IAM role name for a connection: unique per connection, within IAM's 64 characters. */
export function awsConnectionRoleName(connectionId: string): string {
  return `paperclip-${connectionId}`.replace(/[^A-Za-z0-9+=,.@_-]/g, "-").slice(0, 64);
}

export interface AwsRoleSetupInput {
  issuer: string;
  connectionId: string;
  /** Read-only connections default the template to ReadOnlyAccess; full access asks for the policy. */
  accessLevel: "read_only" | "full";
}

export interface AwsRoleSetup {
  issuer: string;
  audience: string;
  subject: string;
  /** The issuer without its scheme: IAM's provider URL and the prefix of the trust condition keys. */
  providerHost: string;
  /** The role the template and the agent prompt create. */
  roleName: string;
  accessLevel: "read_only" | "full";
  /** For setting up by hand; `ACCOUNT_ID` stands for the customer's AWS account ID. */
  trustPolicy: Record<string, unknown>;
  /** A CloudFormation template (JSON) that creates the identity provider (optional) and the role. */
  cloudFormationTemplate: string;
  cloudFormationConsoleUrl: string;
}

export function awsRoleSetup(input: AwsRoleSetupInput): AwsRoleSetup {
  const roleName = awsConnectionRoleName(input.connectionId);
  const providerHost = input.issuer.replace(/^https:\/\//, "");
  // The same subject the signer puts in the token, so the trust policy always matches it.
  const subject = workloadIdentitySubject(input.connectionId);
  const condition = {
    StringEquals: {
      [`${providerHost}:aud`]: AWS_MCP_STS_AUDIENCE,
      [`${providerHost}:sub`]: subject,
    },
  };
  const providerArn = `arn:aws:iam::ACCOUNT_ID:oidc-provider/${providerHost}`;
  const trustPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: providerArn },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: condition,
    }],
  };
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
            Default: "arn:aws:iam::aws:policy/ReadOnlyAccess",
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
        // Other connections from this company's issuer may trust the same provider, so updating
        // or deleting this stack must never remove it.
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
        Properties: {
          Url: input.issuer,
          ClientIdList: [AWS_MCP_STS_AUDIENCE],
        },
      },
      PaperclipRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: roleName,
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
      RoleArn: { Description: "Paste this into Paperclip to finish the connection.", Value: { "Fn::GetAtt": ["PaperclipRole", "Arn"] } },
    },
  };
  return {
    issuer: input.issuer,
    audience: AWS_MCP_STS_AUDIENCE,
    subject,
    providerHost,
    roleName,
    accessLevel: input.accessLevel,
    trustPolicy,
    cloudFormationTemplate: `${JSON.stringify(template, null, 2)}\n`,
    cloudFormationConsoleUrl: "https://console.aws.amazon.com/cloudformation/home#/stacks/create",
  };
}
