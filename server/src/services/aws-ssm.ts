import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  SSMClient,
  DescribeInstanceInformationCommand,
  type InstanceInformation,
} from "@aws-sdk/client-ssm";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { unprocessable } from "../errors.js";

const execFileP = promisify(execFile);

export interface SsmResolveTagInput {
  region: string;
  awsProfile: string | null;
  tagKey: string;
  tagValue: string;
}

export interface SsmResolvedInstance {
  instanceId: string;
  pingStatus: string;
  computerName: string | null;
  platformType: string | null;
}

function buildSsmClient(input: { region: string; awsProfile: string | null }): SSMClient {
  // When awsProfile is null we let the AWS SDK's default credential provider
  // chain resolve credentials — env vars first, then profile from AWS_PROFILE,
  // then the default profile in ~/.aws/credentials, then EC2 instance metadata.
  // This matches the user's "works like the AWS CLI does" requirement.
  if (input.awsProfile && input.awsProfile.trim().length > 0) {
    return new SSMClient({
      region: input.region,
      credentials: fromIni({ profile: input.awsProfile.trim() }),
    });
  }
  return new SSMClient({ region: input.region });
}

export async function resolveSsmInstanceByTag(
  input: SsmResolveTagInput,
): Promise<SsmResolvedInstance> {
  const tagKey = input.tagKey.trim();
  const tagValue = input.tagValue.trim();
  if (!tagKey || !tagValue) {
    throw unprocessable("SSM tag key and tag value are both required.");
  }

  const client = buildSsmClient(input);
  let response;
  try {
    response = await client.send(
      new DescribeInstanceInformationCommand({
        Filters: [
          { Key: `tag:${tagKey}`, Values: [tagValue] },
          { Key: "PingStatus", Values: ["Online"] },
        ],
        MaxResults: 50,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw unprocessable(`Failed to query AWS SSM for tag ${tagKey}=${tagValue}: ${message}`);
  } finally {
    client.destroy();
  }

  const matches = (response.InstanceInformationList ?? []).filter(
    (entry): entry is InstanceInformation & { InstanceId: string } =>
      typeof entry.InstanceId === "string" && entry.InstanceId.length > 0,
  );

  if (matches.length === 0) {
    throw unprocessable(
      `No online SSM-managed instance matches tag ${tagKey}=${tagValue} in ${input.region}.`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((entry) => entry.InstanceId).join(", ");
    throw unprocessable(
      `Multiple SSM-managed instances match tag ${tagKey}=${tagValue} in ${input.region}: ${ids}. Narrow the tag value to a single host.`,
    );
  }

  const match = matches[0];
  return {
    instanceId: match.InstanceId,
    pingStatus: match.PingStatus ?? "Online",
    computerName: match.ComputerName ?? null,
    platformType: match.PlatformType ?? null,
  };
}

export interface SsmProxyCommandInput {
  region: string;
  awsProfile: string | null;
  instanceId: string;
}

// OpenSSH expands %h (host) and %p (port) at connect time. We pass the EC2
// instance ID as the SSH "host" so %h becomes the SSM target, and let the
// remote sshd port flow through %p so the user's configured port works.
export function buildSsmProxyCommand(input: SsmProxyCommandInput): string {
  const parts = [
    "aws",
    "ssm",
    "start-session",
    "--target",
    input.instanceId,
    "--document-name",
    "AWS-StartSSHSession",
    "--parameters",
    "portNumber=%p",
    "--region",
    input.region,
  ];
  if (input.awsProfile && input.awsProfile.trim().length > 0) {
    parts.push("--profile", input.awsProfile.trim());
  }
  return parts.join(" ");
}

let cliCheckCache: { ok: true } | { ok: false; reason: string } | null = null;

// Verifies the AWS CLI v2 and the Session Manager Plugin are installed on the
// Paperclip host. We cache the positive result for the lifetime of the process
// (the binaries do not appear/disappear at runtime) but re-probe on failure so
// the user can install the missing piece without restarting Paperclip.
export async function assertSsmCliAvailable(): Promise<void> {
  if (cliCheckCache?.ok === true) return;

  const errors: string[] = [];
  try {
    await execFileP("aws", ["--version"], { timeout: 5_000 });
  } catch (error) {
    errors.push(
      `aws CLI is not installed or not on PATH (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  try {
    await execFileP("session-manager-plugin", ["--version"], { timeout: 5_000 });
  } catch (error) {
    errors.push(
      `session-manager-plugin is not installed or not on PATH (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  if (errors.length > 0) {
    const reason = `${errors.join(" ")} See SSM_AGENT_SETUP.md for install instructions.`;
    cliCheckCache = { ok: false, reason };
    throw unprocessable(reason);
  }
  cliCheckCache = { ok: true };
}
