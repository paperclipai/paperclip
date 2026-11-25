import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronRight, Download, Loader2 } from "lucide-react";
import type { AwsConnectionSetup } from "@paperclipai/shared";
import { ROLE_ARN_PATTERN, roleArnFromAgentSummary } from "./aws-role-arn";
import { ApiError } from "@/api/client";
import { toolsApi } from "@/api/tools";
import { describeError } from "@/api/errors";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";
import {
  AgentSetupProgressPanel,
  agentSetupProgressInstructions,
  useAgentSetupProgress,
  type AgentSetupProgressClient,
  type AgentSetupStep,
} from "@/components/AgentSetupProgress";
import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { copyTextToClipboard } from "@/lib/clipboard";

/** The call this step makes. Stories and tests pass in-memory fakes. */
export interface AwsRoleSetupClient {
  setup(connectionId: string, accessLevel?: "read_only" | "full"): Promise<AwsConnectionSetup>;
}

export const awsRoleSetupApiClient: AwsRoleSetupClient = {
  setup: (connectionId, accessLevel) => toolsApi.getAwsSetup(connectionId, accessLevel),
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
  /** The access level the test will submit, when it may differ from the saved one (reconnect). */
  accessLevel?: "read_only" | "full";
  client?: AwsRoleSetupClient;
  /** The last test's failure, shown in place. */
  error?: string | null;
  testing?: boolean;
  onBack: () => void;
  /** Tests the connection with the role ARN the customer pasted back. */
  onTest: (roleArn: string) => void;
  /** Shown above the footer, such as who gets access to the connection. */
  beforeFooter?: React.ReactNode;
  /** The company, for the agent's live progress checklist; without it the prompt has no progress reporting. */
  companyId?: string | null;
  progressClient?: AgentSetupProgressClient;
  /** The signed-in account for the checklist; stories and tests pass it, the app reads the session. */
  progressAccountId?: string;
}

/** The steps the agent is asked to report; it may adjust them. */
export const AWS_AGENT_SETUP_STEPS: AgentSetupStep[] = [
  { key: "check-account", title: "Check the AWS account" },
  { key: "check-provider", title: "Check the identity provider" },
  { key: "deploy-stack", title: "Create the role with CloudFormation" },
  { key: "report-role", title: "Report the role ARN" },
];

/**
 * The middle of AWS role setup: the connection is saved as a draft, so AWS can
 * now trust exactly this connection. By default the customer hands a prompt to
 * their own agent, which creates the role and reports its ARN back through the
 * live checklist; the CloudFormation and by-hand steps, and the Role ARN field,
 * are there for anyone who prefers them.
 */
export function AwsRoleSetup({
  connectionId,
  accessLevel,
  client = awsRoleSetupApiClient,
  error = null,
  testing = false,
  onBack,
  onTest,
  beforeFooter,
  companyId,
  progressClient,
  progressAccountId,
}: AwsRoleSetupProps) {
  const [setup, setSetup] = useState<AwsConnectionSetup | null>(null);
  const agentProgress = useAgentSetupProgress({
    companyId, purpose: "aws_connection", subjectId: connectionId,
    // Only when the role method is available: otherwise there is no prompt to carry the checklist.
    enabled: setup?.available === true,
    ...(progressClient ? { client: progressClient } : {}),
    ...(progressAccountId ? { accountId: progressAccountId } : {}),
  });
  // The prompt waits for the checklist (or its failure), so a copied prompt always carries progress reporting when it can.
  const promptReady = !companyId || Boolean(agentProgress.handoff) || Boolean(agentProgress.error);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roleArn, setRoleArn] = useState("");
  // Set once the person types in the field: the agent's ARN then never replaces their value.
  const [roleArnEdited, setRoleArnEdited] = useState(false);
  const [byHandOpen, setByHandOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSetup(null);
    setLoadError(null);
    client.setup(connectionId, accessLevel).then(
      (value) => {
        if (cancelled) return;
        setSetup(value);
        if (value.available && value.savedRoleArn) setRoleArn((current) => current || value.savedRoleArn!);
      },
      (caught) => { if (!cancelled) setLoadError(describeError(caught).body); },
    );
    return () => { cancelled = true; };
  }, [client, connectionId, accessLevel]);

  const ready = setup?.available === true ? setup : null;
  const trimmedArn = roleArn.trim();
  const arnInvalid = trimmedArn.length > 0 && !ROLE_ARN_PATTERN.test(trimmedArn);
  const agentFinished = agentProgress.progress?.status === "done";
  const reportedArn = ready && agentFinished ? roleArnFromAgentSummary(agentProgress.progress?.summary, ready.roleName) : null;
  useEffect(() => {
    if (reportedArn && !roleArnEdited) setRoleArn(reportedArn);
  }, [reportedArn, roleArnEdited]);
  // The field is under "Or do it by hand"; open it whenever the person has to see or fix the ARN.
  const needsArnByHand = Boolean(error) || arnInvalid || (agentFinished && !reportedArn);
  useEffect(() => {
    if (needsArnByHand) setByHandOpen(true);
  }, [needsArnByHand]);

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
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              <span className="text-foreground">Give this prompt to an agent on a computer signed in to your AWS account.</span>{" "}
              {ready.savedRoleArn ? "It updates the existing role" : "It creates the role"} with the AWS CLI
              {agentProgress.handoff
                ? ", shows its progress here, and hands back the role when it finishes."
                : " and tells you the role ARN to paste under Or do it by hand."}
            </p>
            {agentProgress.error ? (
              <InlineBanner tone="warning" title="Live progress isn’t available">
                {agentProgress.error} The prompt still works; your agent just won’t show its steps here.{" "}
                <Button type="button" variant="outline" size="sm" className="ml-1" onClick={agentProgress.renew}>Try again</Button>
              </InlineBanner>
            ) : null}
            {promptReady ? (
              <AgentSetupPrompt
                prompt={awsAgentSetupPrompt(ready, agentProgress.handoff ? agentSetupProgressInstructions(agentProgress.handoff, AWS_AGENT_SETUP_STEPS) : null)}
                label="Set it up with your agent"
                title="Set up AWS with your agent"
                description="Paste this into your own agent, such as Claude Code or Codex, on a computer signed in to the AWS account agents should use. It includes a short-lived link for this setup, so don’t share it."
                side="bottom"
              />
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Preparing the prompt…
              </p>
            )}
            {agentProgress.handoff ? (
              <AgentSetupProgressPanel
                progress={agentProgress.progress}
                subject="AWS"
                expired={agentProgress.expired}
                onRenew={agentProgress.renew}
                refreshError={agentProgress.refreshError}
                onRetryRefresh={agentProgress.retryRefresh}
              />
            ) : null}
          </div>

          {reportedArn && trimmedArn === reportedArn ? (
            <p className="text-sm text-muted-foreground">Your agent’s role is ready. Test the connection to finish.</p>
          ) : agentFinished && !reportedArn ? (
            <p className="text-sm text-muted-foreground">
              Your agent finished without a role ARN Paperclip could use. Paste it under Or do it by hand.
            </p>
          ) : null}

          <Collapsible open={byHandOpen} onOpenChange={setByHandOpen}>
            <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium text-foreground">
              <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
              Or do it by hand
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-6">
              <section className="space-y-3" aria-labelledby="aws-role-cloudformation">
                <h3 id="aws-role-cloudformation" className="text-sm font-medium text-foreground">With CloudFormation</h3>
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
                    <a
                      href={ready.cloudFormationConsoleUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
                    >
                      Open CloudFormation <ArrowUpRight className="h-3.5 w-3.5" />
                    </a>{" "}
                    in the AWS account agents should use, create a stack, choose Upload a template file, and select the downloaded file.
                  </li>
                  <li>
                    {ready.accessLevel === "read_only"
                      ? "Keep the defaults: AccessPolicyArn is ReadOnlyAccess, matching this read-only connection."
                      : "Set AccessPolicyArn to the managed policy agents should have. This connection has full access, so there is no default."}{" "}
                    If this AWS account already has an identity provider for this Paperclip address, set
                    CreateIdentityProvider to false. On the last page, tick the box that acknowledges the stack creates IAM
                    resources.
                  </li>
                  <li>
                    When the stack finishes, copy RoleArn from its Outputs tab into the Role ARN field below. If this role came from
                    this template before, update that stack (<span className="font-mono text-foreground">{ready.roleName}</span>)
                    with the new template instead of creating another.
                  </li>
                </ol>
              </section>

              <section className="space-y-3" aria-labelledby="aws-role-manual">
                <h3 id="aws-role-manual" className="text-sm font-medium text-foreground">In the IAM console or AWS CLI</h3>
                <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
                  <li>Add an OpenID Connect identity provider with the provider URL and audience below, unless the account already has one for it.</li>
                  <li>
                    {ready.savedRoleArn ? "Update the role " : "Create the role "}
                    <span className="font-mono text-foreground">{ready.savedRoleArn ?? ready.roleName}</span>{" "}
                    {ready.savedRoleArn ? "so its trust policy is the one below" : "with the trust policy below"}, replacing
                    ACCOUNT_ID with your AWS account ID. The CLI commands do either.
                  </li>
                  <li>Attach AWSMCPSignInOAuthAccessPolicy and the permissions agents should have, then paste the role ARN below.</li>
                </ol>
                <CopyRow label="Provider URL" value={ready.issuer} />
                <CopyRow label="Audience" value={ready.audience} />
                <CopyRow label="Role name" value={ready.roleName} />
                <CopyRow label="Connection subject" value={ready.subject} />
                <CopyBlock label="Trust policy" value={JSON.stringify(ready.trustPolicy, null, 2)} />
                <CopyBlock label="AWS CLI commands" value={awsCliCommands(ready)} />
              </section>

              <section className="space-y-2" aria-label="Role ARN">
                <label htmlFor="aws-role-arn" className="text-sm font-medium text-foreground">Role ARN</label>
                <Input
                  id="aws-role-arn"
                  value={roleArn}
                  onChange={(event) => { setRoleArnEdited(true); setRoleArn(event.target.value); }}
                  placeholder={`arn:aws:iam::<account ID>:role/${ready.roleName}`}
                  aria-invalid={arnInvalid || undefined}
                  className="font-mono text-base md:text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                {arnInvalid ? (
                  <p className="text-xs text-destructive">Use the full role ARN, like arn:aws:iam::123456789012:role/{ready.roleName}.</p>
                ) : null}
              </section>
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : null}

      {beforeFooter}

      <div className="flex items-center justify-between pt-3">
        <Button variant="ghost" onClick={onBack} disabled={testing}>Back</Button>
        <Button onClick={() => onTest(trimmedArn)} disabled={testing || !ready || !trimmedArn || arnInvalid}>
          {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {testing ? "Testing…" : "Test connection"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The by-hand setup for the AWS CLI. It reads the account ID, reuses an existing identity
 * provider, and updates the role when it already exists (as on reconnect), so it can be pasted as is.
 */
export function awsCliCommands(setup: Extract<AwsConnectionSetup, { available: true }>): string {
  const { roleName } = setup;
  const policy = JSON.stringify(setup.trustPolicy, null, 2).replaceAll("ACCOUNT_ID", "${ACCOUNT_ID}");
  const accessPolicy = setup.accessLevel === "read_only" ? "arn:aws:iam::aws:policy/ReadOnlyAccess" : "REPLACE_WITH_POLICY_ARN";
  return [
    ...(setup.accessLevel === "read_only" ? [] : ["# Replace REPLACE_WITH_POLICY_ARN below with the managed policy agents should have."]),
    "ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)",
    `aws iam get-open-id-connect-provider --open-id-connect-provider-arn "arn:aws:iam::\${ACCOUNT_ID}:oidc-provider/${setup.providerHost}" >/dev/null 2>&1 \\`,
    `  || aws iam create-open-id-connect-provider --url ${setup.issuer} --client-id-list ${setup.audience}`,
    "cat > paperclip-trust-policy.json <<EOF",
    policy,
    "EOF",
    `if aws iam get-role --role-name ${roleName} >/dev/null 2>&1; then`,
    `  aws iam update-assume-role-policy --role-name ${roleName} --policy-document file://paperclip-trust-policy.json`,
    "else",
    `  aws iam create-role --role-name ${roleName} --max-session-duration 3600 --assume-role-policy-document file://paperclip-trust-policy.json`,
    "fi",
    `aws iam attach-role-policy --role-name ${roleName} --policy-arn arn:aws:iam::aws:policy/AWSMCPSignInOAuthAccessPolicy`,
    `aws iam attach-role-policy --role-name ${roleName} --policy-arn ${accessPolicy}`,
    `aws iam get-role --role-name ${roleName} --query Role.Arn --output text`,
  ].join("\n");
}

/**
 * A prompt for the user's own agent (on a machine already signed in to AWS) to
 * deploy this connection's template and report the role ARN. It holds no AWS
 * credential (AWS trusts the connection's signed identity). With progress
 * instructions it carries a short-lived token that can update this setup's
 * checklist, so it is for the person's own agent, not for sharing.
 */
export function awsAgentSetupPrompt(setup: Extract<AwsConnectionSetup, { available: true }>, progressInstructions: string | null = null): string {
  // One stack per connection, like the role, so two connections never share (and replace) a stack.
  const stack = setup.roleName;
  const policyStep = setup.accessLevel === "read_only"
    ? "The connection is read only, so keep the template's default AccessPolicyArn (ReadOnlyAccess)."
    : "The connection has full access, so ask me which managed policy agents should have, then pass it as AccessPolicyArn. Do not pick one yourself.";
  return [
    setup.savedRoleArn
      ? `Update the AWS IAM role ${setup.savedRoleArn} so Paperclip can connect to my AWS account again. Use the AWS CLI on this computer.`
      : "Set up an AWS IAM role so Paperclip can connect to my AWS account. Use the AWS CLI on this computer.",
    ...(progressInstructions ? ["", progressInstructions] : []),
    "",
    "Steps:",
    setup.savedRoleArn
      ? `1. Run \`aws sts get-caller-identity\` and tell me which account and identity it shows. The role is in account ${setup.savedRoleArn.split(":")[4]}: if the CLI uses a different account, or is not signed in, stop and ask me which profile to use.`
      : "1. Run `aws sts get-caller-identity` and tell me which account and identity it shows. If the CLI is not signed in, or I may want a different account, stop and ask me which profile to use.",
    `2. Choose CreateIdentityProvider. If the stack ${stack} already exists and its value is true (see \`aws cloudformation describe-stacks --stack-name ${stack}\`), keep true so the stack keeps owning its provider. Otherwise run \`aws iam list-open-id-connect-providers\`: if one already ends with ${setup.providerHost}, pass false; otherwise pass true.`,
    `3. ${policyStep}`,
    "4. Save the CloudFormation template below to a file and deploy it. This creates the stack, or updates it if it already exists:",
    `   aws cloudformation deploy --stack-name ${stack} --template-file <file> --capabilities CAPABILITY_NAMED_IAM --parameter-overrides CreateIdentityProvider=<true|false>${setup.accessLevel === "full" ? " AccessPolicyArn=<policy ARN>" : ""}`,
    `   If it fails because the role ${setup.roleName} already exists outside this stack, do not delete it. Instead update its trust policy with \`aws iam update-assume-role-policy\` to the trust policy in the template (with this account's ID and the identity provider's ARN), make sure AWSMCPSignInOAuthAccessPolicy and the access policy are attached, and use that role's ARN in step 5.`,
    progressInstructions
      ? `5. Put the role's ARN (the stack's RoleArn output, or \`aws iam get-role --role-name ${setup.roleName} --query Role.Arn --output text\`) in your finish summary, as "Role ARN: <arn>". Paperclip fills it in from there; then I press Test connection.`
      : `5. Give me the role's ARN (the stack's RoleArn output, or \`aws iam get-role --role-name ${setup.roleName} --query Role.Arn --output text\`), so I can paste it into Paperclip under Or do it by hand and press Test connection.`,
    "",
    "The role trusts only this one Paperclip connection, and no AWS keys are created or shared:",
    `- Identity provider: ${setup.issuer} (audience ${setup.audience})`,
    `- Connection subject: ${setup.subject}`,
    `- Role name: ${setup.roleName}`,
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
