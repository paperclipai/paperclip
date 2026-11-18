import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronRight, Download, Loader2 } from "lucide-react";
import type { AwsConnectionSetup } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { toolsApi } from "@/api/tools";
import { describeError } from "@/api/errors";
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
        <InlineBanner tone="warning" title="Use an access key instead">
          {UNAVAILABLE_REASON[setup.reason]} Go back and choose Access key.
        </InlineBanner>
      ) : null}
      {ready?.addressChanged ? (
        <InlineBanner tone="warning" title="This instance’s address changed">
          The values below use the address this connection was set up with. Reconnect AWS to switch to the current address.
        </InlineBanner>
      ) : null}

      {!setup && !loadError ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Preparing the AWS setup…
        </p>
      ) : null}

      {ready ? (
        <>
          <section className="space-y-3" aria-labelledby="aws-role-cloudformation">
            <h3 id="aws-role-cloudformation" className="text-sm font-medium text-foreground">Create it with CloudFormation</h3>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>
                <span className="text-foreground">Download the template.</span> It is made for this connection, so it needs no edits.
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
                Keep the defaults. If this AWS account already has an identity provider for this Paperclip address, set
                CreateIdentityProvider to false. To let agents make changes, replace AccessPolicyArn with the policy they
                should have. On the last page, tick the box that acknowledges the stack creates IAM resources.
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
                <li>Create the role <span className="font-mono text-foreground">{ready.roleName}</span> with the trust policy below.</li>
                <li>Attach AWSMCPSignInOAuthAccessPolicy and the permissions agents should have.</li>
              </ol>
              <CopyRow label="Provider URL" value={ready.issuer} />
              <CopyRow label="Audience" value={ready.audience} />
              <CopyRow label="Connection subject" value={ready.subject} />
              <CopyBlock label="Trust policy" value={JSON.stringify(ready.trustPolicy, null, 2)} />
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
