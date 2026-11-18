import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronRight, Download, Loader2 } from "lucide-react";
import type { AwsConnectionSetup } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { toolsApi } from "@/api/tools";
import { describeError } from "@/api/errors";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";
import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { copyTextToClipboard } from "@/lib/clipboard";

/** The call this step makes. Stories and tests pass in-memory fakes. */
export interface AwsRoleSetupClient {
  setup(connectionId: string): Promise<AwsConnectionSetup>;
}

export const awsRoleSetupApiClient: AwsRoleSetupClient = {
  setup: (connectionId) => toolsApi.getAwsSetup(connectionId),
};

const UNAVAILABLE_REASON: Record<Extract<AwsConnectionSetup, { available: false }>["reason"], string> = {
  no_public_url: "This Paperclip instance has no public address, so AWS cannot reach it.",
  not_https: "This Paperclip instance is not served over HTTPS, which AWS requires.",
  has_port: "This Paperclip instance's address includes a port, which AWS does not allow.",
  loopback: "This Paperclip instance runs on this computer only, so AWS cannot reach it.",
  address_changed: "This Paperclip instance’s address changed after this connection was saved, so AWS would be set up for the old address.",
};

/**
 * A failed AWS test, in words that say what to fix. The server's AWS messages are
 * already plain language and never contain AWS's own text, so they are shown as
 * is; setup reports them with a gateway status that generic copy would replace.
 */
export function awsSetupErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === "object") {
    const body = error.body as { error?: unknown; details?: { code?: unknown } };
    const code = typeof body.details?.code === "string" ? body.details.code : error.code;
    if (typeof code === "string" && code.startsWith("aws_") && typeof body.error === "string") return body.error;
  }
  return describeError(error).body;
}

export interface AwsRoleSetupProps {
  connectionId: string;
  client?: AwsRoleSetupClient;
  /** The last test's failure, shown in place. */
  error?: string | null;
  testing?: boolean;
  onBack: () => void;
  onTest: () => void;
  /** Shown above the footer, such as who gets access to the connection. */
  beforeFooter?: React.ReactNode;
}

/**
 * The middle of AWS role setup: the connection is saved as a draft, so AWS can
 * now trust exactly this connection. Shows what to create in AWS (a generated
 * CloudFormation template, or the values to enter by hand), then tests.
 */
export function AwsRoleSetup({
  connectionId,
  client = awsRoleSetupApiClient,
  error = null,
  testing = false,
  onBack,
  onTest,
  beforeFooter,
}: AwsRoleSetupProps) {
  const [setup, setSetup] = useState<AwsConnectionSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSetup(null);
    setLoadError(null);
    client.setup(connectionId).then(
      (value) => { if (!cancelled) setSetup(value); },
      (caught) => { if (!cancelled) setLoadError(describeError(caught).body); },
    );
    return () => { cancelled = true; };
  }, [client, connectionId]);

  const ready = setup?.available === true ? setup : null;

  return (
    <div className="space-y-5" data-testid="aws-role-setup">
      <p className="text-sm text-foreground">
        Paperclip saved this connection. Now create a role in your AWS account that trusts this connection only.
        Paperclip stores no AWS keys: it proves who it is each time it needs access.
      </p>

      {error ? <InlineBanner tone="warning" title="AWS didn’t accept the connection yet">{error}</InlineBanner> : null}
      {loadError ? <InlineBanner tone="danger" title="Couldn’t load the AWS setup">{loadError}</InlineBanner> : null}
      {setup?.available === false ? (
        setup.reason === "address_changed" ? (
          <InlineBanner tone="warning" title="Save the connection again">
            {UNAVAILABLE_REASON[setup.reason]} Go back and click Connect to use the current address.
          </InlineBanner>
        ) : (
          <InlineBanner tone="warning" title="Use an access key instead">
            {UNAVAILABLE_REASON[setup.reason]} Go back and choose Access key.
          </InlineBanner>
        )
      ) : null}

      {!setup && !loadError ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Preparing the AWS setup…
        </p>
      ) : null}

      {ready ? (
        <>
          <AgentSetupPrompt
            prompt={awsAgentSetupPrompt(ready)}
            label="Set it up with your agent"
            title="Set up AWS with your agent"
            description="Paste this into an agent on a computer signed in to this AWS account, such as Claude Code or Codex. It creates the role with the AWS CLI."
            side="bottom"
          />
          <section className="space-y-3" aria-labelledby="aws-role-cloudformation">
            <h3 id="aws-role-cloudformation" className="text-sm font-medium text-foreground">Create it with CloudFormation</h3>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>
                <span className="text-foreground">Download the template.</span>{" "}
                {ready.accessLevel === "read_only"
                  ? "It is made for this connection, so it needs no edits."
                  : "It is made for this connection; it only needs the access policy you choose in step 3."}
                <div className="mt-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => downloadTemplate(ready)}>
                    <Download className="mr-2 h-4 w-4" /> Download template
                  </Button>
                </div>
              </li>
              <li>
                <span className="text-foreground">Create a stack in account </span>
                <span className="font-mono text-foreground">{ready.accountId}</span>.{" "}
                <a
                  href={ready.cloudFormationConsoleUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
                >
                  Open CloudFormation <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
                , choose Upload a template file, and select the downloaded file.
              </li>
              <li>
                {ready.accessLevel === "read_only"
                  ? "Keep the defaults: AccessPolicyArn is ReadOnlyAccess, matching this read-only connection."
                  : "Set AccessPolicyArn to the managed policy agents should have. This connection has full access, so there is no default."}{" "}
                If this AWS account already has an identity provider for this Paperclip address, set
                CreateIdentityProvider to false. On the last page, tick the box that acknowledges the stack creates IAM
                resources.
              </li>
              <li>When the stack finishes, come back and test the connection.</li>
            </ol>
          </section>

          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium text-foreground">
              <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
              Set it up by hand instead
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-4">
              <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
                <li>In IAM, add an OpenID Connect identity provider with the provider URL and audience below.</li>
                <li>
                  Create the role <span className="font-mono text-foreground">{ready.roleArn}</span> with the trust policy below.
                  {ready.rolePath !== "/"
                    ? " Its path is " : null}
                  {ready.rolePath !== "/" ? <span className="font-mono text-foreground">{ready.rolePath}</span> : null}
                  {ready.rolePath !== "/"
                    ? ", which the IAM console cannot set, so use the AWS CLI commands below." : null}
                </li>
                <li>Attach AWSMCPSignInOAuthAccessPolicy and the permissions agents should have.</li>
              </ol>
              <CopyRow label="Provider URL" value={ready.issuer} />
              <CopyRow label="Audience" value={ready.audience} />
              <CopyRow label="Role ARN" value={ready.roleArn} />
              <CopyRow label="Connection subject" value={ready.subject} />
              <CopyBlock label="Trust policy" value={JSON.stringify(ready.trustPolicy, null, 2)} />
              <CopyBlock label="AWS CLI commands" value={awsCliCommands(ready)} />
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : null}

      {beforeFooter}

      <div className="flex items-center justify-between pt-3">
        <Button variant="ghost" onClick={onBack} disabled={testing}>Back</Button>
        <Button onClick={onTest} disabled={testing || !ready}>
          {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {testing ? "Testing…" : "Test connection"}
        </Button>
      </div>
    </div>
  );
}

/** The same setup as the trust policy above, for people who prefer the AWS CLI (it also sets role paths). */
export function awsCliCommands(setup: Extract<AwsConnectionSetup, { available: true }>): string {
  const policy = JSON.stringify(setup.trustPolicy);
  return [
    `aws iam create-open-id-connect-provider --url ${setup.issuer} --client-id-list ${setup.audience}`,
    `aws iam create-role --path ${setup.rolePath} --role-name ${setup.roleName} --assume-role-policy-document '${policy}'`,
    `aws iam attach-role-policy --role-name ${setup.roleName} --policy-arn arn:aws:iam::aws:policy/AWSMCPSignInOAuthAccessPolicy`,
    `aws iam attach-role-policy --role-name ${setup.roleName} --policy-arn ${setup.accessLevel === "read_only" ? "arn:aws:iam::aws:policy/ReadOnlyAccess" : "<the managed policy agents should have>"}`,
  ].join("\n");
}

/**
 * A prompt for the user's own agent (on a machine already signed in to AWS) to
 * deploy this connection's template. It holds no secrets: AWS trusts the
 * connection's signed identity, so the values are safe to paste anywhere.
 */
export function awsAgentSetupPrompt(setup: Extract<AwsConnectionSetup, { available: true }>): string {
  const stack = `paperclip-${setup.roleName}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 128);
  const policyStep = setup.accessLevel === "read_only"
    ? "The connection is read only, so keep the template's default AccessPolicyArn (ReadOnlyAccess)."
    : "The connection has full access, so ask me which managed policy agents should have, then pass it as AccessPolicyArn. Do not pick one yourself.";
  return [
    `Set up an AWS IAM role so Paperclip can connect to AWS account ${setup.accountId}. Use the AWS CLI on this computer.`,
    "",
    "Steps:",
    `1. Run \`aws sts get-caller-identity\` and confirm the account is ${setup.accountId}. If it is not, or the CLI is not signed in, stop and tell me which profile or sign-in to use.`,
    `2. Run \`aws iam list-open-id-connect-providers\`. If one already ends with ${setup.providerHost}, pass CreateIdentityProvider=false; otherwise pass true.`,
    `3. ${policyStep}`,
    "4. Save the CloudFormation template below to a file and deploy it:",
    `   aws cloudformation deploy --stack-name ${stack} --template-file <file> --capabilities CAPABILITY_NAMED_IAM --parameter-overrides CreateIdentityProvider=<true|false>${setup.accessLevel === "full" ? " AccessPolicyArn=<policy ARN>" : ""}`,
    `5. Confirm the stack output RoleArn is ${setup.roleArn}. If it differs, tell me the new ARN.`,
    "6. Tell me when it is done, so I can press Test connection in Paperclip.",
    "",
    "The role trusts only this one Paperclip connection, and no AWS keys are created or shared:",
    `- Identity provider: ${setup.issuer} (audience ${setup.audience})`,
    `- Connection subject: ${setup.subject}`,
    "",
    "CloudFormation template:",
    setup.cloudFormationTemplate.trimEnd(),
  ].join("\n");
}

function downloadTemplate(setup: Extract<AwsConnectionSetup, { available: true }>) {
  const blob = new Blob([setup.cloudFormationTemplate], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `paperclip-aws-${setup.roleName}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        await copyTextToClipboard(value).then(() => setCopied(true), () => setCopied(false));
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-sm font-medium text-foreground">{label}</span>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border px-3 py-2 font-mono text-xs text-foreground">{value}</code>
        <CopyButton value={value} label={label} />
      </div>
    </div>
  );
}

function CopyBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <CopyButton value={value} label={label} />
      </div>
      <Textarea readOnly value={value} aria-label={label} rows={10} className="mt-2 font-mono text-xs" />
    </div>
  );
}
