import { useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  ConnectToolAppResult,
  CreateMachineSignIn,
  MachineSignInMethod,
  MachineSignInSetupResult,
  TestMachineSignIn,
} from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { describeError } from "@/api/errors";
import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";

/** The calls this setup makes. Stories pass in-memory fakes. */
export interface MachineSignInClient {
  create(companyId: string, input: CreateMachineSignIn): Promise<MachineSignInSetupResult>;
  test(connectionId: string, input: TestMachineSignIn): Promise<ConnectToolAppResult>;
}

export const machineSignInApiClient: MachineSignInClient = {
  create: (companyId, input) => toolsApi.createMachineSignIn(companyId, input),
  test: (connectionId, input) => toolsApi.testMachineSignIn(connectionId, input),
};

const METHOD_OPTIONS: Array<{ method: MachineSignInMethod; label: string; hint: string }> = [
  {
    method: "paperclip_key",
    label: "Paperclip key (recommended)",
    hint: "Paperclip creates a key and keeps its private half. You register the public key with the provider; nothing secret is copied.",
  },
  {
    method: "client_secret",
    label: "Client secret",
    hint: "For providers that only issue a secret. Paperclip stores it securely and never shows it again.",
  },
];

export interface MachineSignInSetupProps {
  companyId: string;
  link: string;
  name?: string;
  client?: MachineSignInClient;
  /** Resume at "register the key" with a key Paperclip already created. */
  initialSetup?: MachineSignInSetupResult | null;
  initialMethod?: MachineSignInMethod;
  initialError?: string | null;
  onBack: () => void;
  onConnected: (result: ConnectToolAppResult) => void;
}

/**
 * Machine sign-in for an organization connection: the server's provider issues
 * Paperclip a client of its own, so no person signs in. With a Paperclip key the
 * admin registers the public key we show; with a client secret they paste it.
 * Either way the last step is a real test against the provider and the server.
 */
export function MachineSignInSetup({
  companyId,
  link,
  name,
  client = machineSignInApiClient,
  initialSetup = null,
  initialMethod = "paperclip_key",
  initialError = null,
  onBack,
  onConnected,
}: MachineSignInSetupProps) {
  const [method, setMethod] = useState<MachineSignInMethod>(initialSetup?.machineSignIn.method ?? initialMethod);
  const [signInService, setSignInService] = useState("");
  const [clientId, setClientId] = useState(initialSetup?.machineSignIn.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(initialSetup?.machineSignIn.scopes.join(" ") ?? "");
  const [setup, setSetup] = useState<MachineSignInSetupResult | null>(initialSetup);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState<"creating" | "testing" | null>(null);

  const trimmedScopes = scopes.trim();
  const canCreate = method === "paperclip_key" || (clientId.trim().length > 0 && clientSecret.length > 0);
  const canTest = clientId.trim().length > 0;

  async function createDraft(): Promise<MachineSignInSetupResult | null> {
    setBusy("creating");
    setError(null);
    try {
      const created = await client.create(companyId, {
        link,
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(signInService.trim() ? { authorizationServer: signInService.trim() } : {}),
        method,
        ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
        ...(method === "client_secret" && clientSecret ? { clientSecret } : {}),
        ...(trimmedScopes ? { scopes: trimmedScopes } : {}),
      });
      setSetup(created);
      return created;
    } catch (caught) {
      setError(describeError(caught).body);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function testConnection(target: MachineSignInSetupResult) {
    setBusy("testing");
    setError(null);
    try {
      const result = await client.test(target.connectionId, {
        clientId: clientId.trim(),
        ...(trimmedScopes ? { scopes: trimmedScopes } : {}),
      });
      onConnected(result);
    } catch (caught) {
      setError(describeError(caught).body);
    } finally {
      setBusy(null);
    }
  }

  const host = (() => {
    try { return new URL(link).host; } catch { return link; }
  })();
  const publicKey = setup?.machineSignIn.publicKey ?? null;

  return (
    <div className="space-y-5" data-testid="machine-sign-in-setup">
      <p className="text-xs text-muted-foreground">
        For automation your organization owns. Agents use this connection as the provider client you set up for
        Paperclip, not as any person. Only shared connections can use machine sign-in.
      </p>

      {error ? <InlineBanner tone="warning" title="Machine sign-in didn’t work">{error}</InlineBanner> : null}

      {!setup ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How Paperclip proves who it is">
            {METHOD_OPTIONS.map((option) => (
              <button
                key={option.method}
                type="button"
                role="radio"
                aria-checked={method === option.method}
                onClick={() => setMethod(option.method)}
                className={cn(
                  "rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors",
                  method === option.method ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{METHOD_OPTIONS.find((option) => option.method === method)?.hint}</p>
          <Field id="machine-sign-in-service" label="Sign-in service" hint={`Leave blank and Paperclip asks ${host} where to sign in. Otherwise enter the address or token URL from the provider’s docs.`}>
            <Input id="machine-sign-in-service" value={signInService} onChange={(event) => setSignInService(event.target.value)} placeholder="Found automatically" autoComplete="off" className="h-11 font-mono" />
          </Field>
          <Field id="machine-sign-in-client-id" label="Client ID" hint={method === "paperclip_key" ? "You can add this after registering the key." : undefined}>
            <Input id="machine-sign-in-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" className="h-11 font-mono" />
          </Field>
          {method === "client_secret" ? (
            <Field id="machine-sign-in-client-secret" label="Client secret">
              <Input id="machine-sign-in-client-secret" type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="off" className="h-11 font-mono" />
            </Field>
          ) : null}
          <Field id="machine-sign-in-scopes" label="Scopes" hint="Optional. Separate with spaces, as the provider’s docs list them.">
            <Input id="machine-sign-in-scopes" value={scopes} onChange={(event) => setScopes(event.target.value)} placeholder="Optional" autoComplete="off" className="h-11 font-mono" />
          </Field>
        </div>
      ) : (
        <div className="space-y-4">
          {publicKey ? (
            <div className="space-y-3">
              <p className="text-sm text-foreground">
                Register this public key with the provider for the Paperclip client. It isn’t secret, so you can paste it
                into the provider’s console or send it to whoever manages it.
              </p>
              <PublicKeyBlock label="Public key (PEM)" value={publicKey.pem} />
              <PublicKeyBlock label="Public key (JSON)" value={JSON.stringify(publicKey.jwk, null, 2)} />
            </div>
          ) : null}
          <Field id="machine-sign-in-client-id-confirm" label="Client ID" hint="The ID the provider shows for the Paperclip client.">
            <Input id="machine-sign-in-client-id-confirm" value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" className="h-11 font-mono" />
          </Field>
          <Field id="machine-sign-in-scopes-confirm" label="Scopes" hint="Optional. Separate with spaces.">
            <Input id="machine-sign-in-scopes-confirm" value={scopes} onChange={(event) => setScopes(event.target.value)} autoComplete="off" className="h-11 font-mono" />
          </Field>
        </div>
      )}

      <div className="flex items-center justify-between pt-3">
        <Button variant="ghost" onClick={onBack} disabled={busy !== null}>Back</Button>
        {!setup && method === "paperclip_key" ? (
          <Button onClick={() => void createDraft()} disabled={busy !== null || !canCreate}>
            {busy === "creating" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {busy === "creating" ? "Creating key…" : "Create key"}
          </Button>
        ) : (
          <Button
            onClick={async () => {
              const target = setup ?? await createDraft();
              if (target) await testConnection(target);
            }}
            disabled={busy !== null || (setup ? !canTest : !canCreate)}
          >
            {busy !== null && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {busy === "testing" ? "Testing…" : busy === "creating" ? "Saving…" : "Test connection"}
          </Button>
        )}
      </div>
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm font-medium text-foreground" htmlFor={id}>{label}</label>
      <div className="mt-2">{children}</div>
      {hint ? <p className="mt-2 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function PublicKeyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await copyTextToClipboard(value).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Textarea readOnly value={value} aria-label={label} rows={6} className="mt-2 font-mono text-xs" />
    </div>
  );
}
