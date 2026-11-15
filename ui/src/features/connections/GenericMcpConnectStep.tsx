import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Loader2, Plus, X } from "lucide-react";
import type { AppDefinition, ConnectToolAppResult } from "@paperclipai/shared";
import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { RadioCard } from "@/components/ui/radio-card";
import { redactUrlSecrets } from "@/lib/redact-url-secrets";
import { AppLogo } from "@/pages/apps/AppLogo";
import { MachineSignInSetup } from "./MachineSignInSetup";
import {
  canSubmitGenericConnect,
  customHeaderError,
  newCustomHeaderRow,
  type CustomHeaderRow,
  type GenericConnectGuidance,
  type GenericMcpAuthMode,
} from "@/pages/apps/generic-mcp-connect";

/**
 * How the server authenticates, in its own terms. Paperclip decides internally
 * which protocol satisfies the choice; none of that belongs on this screen.
 * Ordered by how often an operator needs each one.
 */
const AUTH_OPTIONS: Array<{ mode: GenericMcpAuthMode; title: string; description: string }> = [
  {
    mode: "auto",
    title: "Let Paperclip check",
    description: "Paperclip asks the server what it needs and walks you through it.",
  },
  {
    mode: "bearer",
    title: "Key or token",
    description: "Paperclip sends your key as an Authorization header.",
  },
  {
    mode: "oauth",
    title: "Browser sign-in",
    description: "You’ll sign in at the provider.",
  },
  {
    mode: "custom_headers",
    title: "Custom headers",
    description: "For servers that name their own headers.",
  },
  {
    mode: "none",
    title: "No sign-in needed",
    description: "The server is open to anyone with the address.",
  },
];

/** The resolved sign-in choice, stated in one line beside its Change control. */
export function genericMcpAuthSummary(input: {
  authMode: GenericMcpAuthMode;
  headers: CustomHeaderRow[];
  oauthClientId: string;
}): string {
  switch (input.authMode) {
    case "none":
      return "No sign-in. The server is open to anyone with the address.";
    case "bearer":
      return "Signs in with a key or token.";
    case "custom_headers": {
      const count = input.headers.filter((row) => row.name.trim() && row.value.trim()).length;
      return count === 0
        ? "Signs in with custom headers."
        : `Signs in with ${count} custom ${count === 1 ? "header" : "headers"}.`;
    }
    case "oauth":
      return input.oauthClientId.trim()
        ? "You’ll sign in at the provider, using your own client ID."
        : "You’ll sign in at the provider.";
    default:
      return "Paperclip asks the server how to sign in.";
  }
}

/**
 * The connect screen for an unknown remote MCP server.
 *
 * The address alone is the whole default path. How the server signs in is a
 * stated default with a Change control, in the same shape as the access line
 * below it, so the screen reads as two resolved answers and one action. Each
 * sign-in option keeps its own fields directly beneath it.
 *
 * The operator picks how the server signs in, never which protocol Paperclip
 * uses to satisfy it, so no protocol jargon appears here. The header keeps the
 * endpoint host and its "Unverified server" label visible the whole way
 * through, so the operator can always see whose server agents will call.
 */
export function GenericMcpConnectStep({
  link,
  name,
  needsKey,
  keyValue,
  onKeyChange,
  authMode,
  onAuthModeChange,
  headers,
  onHeadersChange,
  oauthClientId,
  onOAuthClientIdChange,
  oauthClientSecret,
  onOAuthClientSecretChange,
  advancedOpen,
  onAdvancedOpenChange,
  guidance,
  matchedEntry,
  onUseMatchedEntry,
  submitting,
  defaults,
  onBack,
  onConnect,
  machineSignIn,
}: {
  link: string;
  name: string;
  /** Set by the server's probe after a credential challenge, never guessed. */
  needsKey: boolean;
  keyValue: string;
  onKeyChange: (next: string) => void;
  authMode: GenericMcpAuthMode;
  onAuthModeChange: (next: GenericMcpAuthMode) => void;
  headers: CustomHeaderRow[];
  onHeadersChange: (next: CustomHeaderRow[]) => void;
  oauthClientId: string;
  onOAuthClientIdChange: (next: string) => void;
  oauthClientSecret: string;
  onOAuthClientSecretChange: (next: string) => void;
  advancedOpen: boolean;
  onAdvancedOpenChange: (next: boolean) => void;
  guidance: GenericConnectGuidance | null;
  /** A curated app whose endpoint matches, offered as a convenience only. */
  matchedEntry?: AppDefinition | null;
  onUseMatchedEntry?: () => void;
  submitting: boolean;
  /** The stated access default and its Change disclosure. */
  defaults?: ReactNode;
  onBack: () => void;
  onConnect: () => void;
  /** Offered only for organization connections: personal connections sign in as the person. */
  machineSignIn?: { companyId: string; applicationId?: string | null; onConnected: (result: ConnectToolAppResult) => void } | null;
}) {
  const [clientFieldsOpen, setClientFieldsOpen] = useState(false);
  // Machine sign-in runs its own setup and test, so it is a choice beside the modes, not one of them.
  const [machineSelected, setMachineSelected] = useState(false);
  const machine = Boolean(machineSelected && machineSignIn);
  const headerError = authMode === "custom_headers" ? customHeaderError(headers) : null;
  const canSubmit = canSubmitGenericConnect({
    link,
    name,
    authMode,
    needsKey,
    keyValue,
    headers,
    oauthClientId,
    oauthClientSecret,
  });
  const displayedLink = matchedEntry?.slug === "zapier" ? redactUrlSecrets(link) : link;
  const probedKey = authMode === "auto" && needsKey;
  // Stay open while the chosen option still needs something typed into it, so
  // a disabled primary action always has its reason on screen.
  const choiceNeedsInput = (authMode === "bearer" || authMode === "custom_headers") && !canSubmit;
  const expanded = advancedOpen || choiceNeedsInput || machine;
  const showClientFields = clientFieldsOpen
    || oauthClientId.trim().length > 0
    || oauthClientSecret.trim().length > 0
    || guidance?.focus === "credentials";

  const updateHeader = (id: string, patch: Partial<CustomHeaderRow>) => {
    onHeadersChange(headers.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrow keys inside an option's own fields belong to that field.
    if ((event.target as HTMLElement).getAttribute("role") !== "radio") return;
    // Only this group's own options: a nested choice (machine sign-in's) handles its own keys.
    if ((event.target as HTMLElement).closest('[role="radiogroup"]') !== event.currentTarget) return;
    const step = event.key === "ArrowDown" || event.key === "ArrowRight"
      ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? -1
        : 0;
    if (step === 0) return;
    event.preventDefault();
    const count = AUTH_OPTIONS.length + (machineSignIn ? 1 : 0);
    const index = machine ? AUTH_OPTIONS.length : AUTH_OPTIONS.findIndex((option) => option.mode === authMode);
    const next = (index + step + count) % count;
    if (next === AUTH_OPTIONS.length) setMachineSelected(true);
    else {
      setMachineSelected(false);
      onAuthModeChange(AUTH_OPTIONS[next]!.mode);
    }
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  const keyField = (label: string | null) => (
    <div>
      {label ? (
        <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-key">{label}</label>
      ) : null}
      <Input
        id="generic-mcp-key"
        type="password"
        autoComplete="off"
        aria-label={label ? undefined : "Key or token"}
        value={keyValue}
        onChange={(event) => onKeyChange(event.target.value)}
        placeholder="Paste the key or token"
        className={label ? "mt-2 h-11 font-mono" : "h-11 font-mono"}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Grant this key access to what your agents need. Paperclip can’t increase its permissions.
      </p>
    </div>
  );

  const optionFields = (mode: GenericMcpAuthMode): ReactNode => {
    if (mode === "bearer") return keyField(null);
    if (mode === "custom_headers") {
      return (
        <div className="space-y-2">
          {headers.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <Input
                value={row.name}
                onChange={(event) => updateHeader(row.id, { name: event.target.value })}
                placeholder="Header name"
                aria-label="Header name"
                autoComplete="off"
                spellCheck={false}
                className="h-10 font-mono"
              />
              <Input
                type="password"
                autoComplete="off"
                value={row.value}
                onChange={(event) => updateHeader(row.id, { value: event.target.value })}
                placeholder="Value"
                aria-label={row.name.trim() ? `Value for ${row.name.trim()}` : "Header value"}
                className="h-10 font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0 text-muted-foreground"
                aria-label={row.name.trim() ? `Remove ${row.name.trim()}` : "Remove header"}
                onClick={() => onHeadersChange(headers.filter((candidate) => candidate.id !== row.id))}
                disabled={headers.length === 1}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2.5"
              onClick={() => onHeadersChange([...headers, newCustomHeaderRow()])}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add header
            </Button>
            <p className="text-xs text-muted-foreground">Values are stored as secrets and can’t be read back.</p>
          </div>
          {headerError ? <p role="alert" className="text-xs text-destructive">{headerError}</p> : null}
        </div>
      );
    }
    if (mode === "oauth") {
      if (!showClientFields) {
        return (
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => setClientFieldsOpen(true)}
          >
            Use your own client ID
          </Button>
        );
      }
      return (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Paperclip sets sign-in up on its own whenever the server allows it. Fill these in only when the
            server’s docs tell you to register Paperclip yourself first.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-client-id">
                Client ID
              </label>
              <Input
                id="generic-mcp-client-id"
                value={oauthClientId}
                onChange={(event) => onOAuthClientIdChange(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="Optional"
                className="mt-2 h-10 font-mono"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-client-secret">
                Client secret
              </label>
              <Input
                id="generic-mcp-client-secret"
                type="password"
                autoComplete="off"
                value={oauthClientSecret}
                onChange={(event) => onOAuthClientSecretChange(event.target.value)}
                placeholder="Optional"
                className="mt-2 h-10 font-mono"
              />
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="mx-auto max-w-xl">
      <div className="flex flex-col gap-6">
        <p className="min-w-0 truncate font-mono text-sm text-muted-foreground" title={displayedLink}>{displayedLink}</p>

        {matchedEntry && onUseMatchedEntry ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <AppLogo name={matchedEntry.name} logoUrl={matchedEntry.branding.logoUrl} darkLogoUrl={matchedEntry.branding.darkLogoUrl} size={24} />
              <span className="truncate">Paperclip has a guided setup for {matchedEntry.name}.</span>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={onUseMatchedEntry}>
              Use {matchedEntry.name}
            </Button>
          </div>
        ) : null}

        {guidance ? (
          <InlineBanner tone="warning" title={guidance.title}>
            {guidance.body}
          </InlineBanner>
        ) : null}

        {probedKey ? keyField("App key") : null}
      </div>

      <Collapsible
        open={expanded}
        onOpenChange={onAdvancedOpenChange}
        className="mt-6 rounded-lg border border-border bg-muted/30 px-4 py-3"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm text-muted-foreground">
            {expanded ? "How does this server sign in?" : genericMcpAuthSummary({ authMode, headers, oauthClientId })}
          </p>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-xs font-semibold underline underline-offset-2"
              disabled={submitting || choiceNeedsInput || machine}
              data-testid="generic-mcp-sign-in-toggle"
            >
              {expanded ? "Done" : "Change"}
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div
            role="radiogroup"
            aria-label="How this server signs in"
            className="mt-3 grid gap-2 pb-1"
            onKeyDown={moveSelection}
          >
            {AUTH_OPTIONS.map((option) => {
              const selected = !machine && option.mode === authMode;
              const fields = selected ? optionFields(option.mode) : null;
              return (
                <div key={option.mode}>
                  <RadioCard
                    selected={selected}
                    title={option.title}
                    description={option.description}
                    tabIndex={selected ? 0 : -1}
                    disabled={submitting}
                    className="bg-background"
                    onClick={() => {
                      setMachineSelected(false);
                      onAuthModeChange(option.mode);
                    }}
                  />
                  {fields ? <div className="px-4 pb-2 pt-3">{fields}</div> : null}
                </div>
              );
            })}
            {machineSignIn ? (
              <div>
                <RadioCard
                  selected={machine}
                  title="Machine sign-in"
                  description="Your organization’s automation signs in as its own registered client. No person signs in."
                  tabIndex={machine ? 0 : -1}
                  disabled={submitting}
                  className="bg-background"
                  onClick={() => setMachineSelected(true)}
                />
                {machine ? (
                  <div className="px-4 pb-2 pt-3">
                    <MachineSignInSetup
                      companyId={machineSignIn.companyId}
                      applicationId={machineSignIn.applicationId}
                      link={link}
                      name={name}
                      onBack={onBack}
                      onConnected={machineSignIn.onConnected}
                      beforeFooter={defaults}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Machine sign-in owns its footer (Test connection, not Check link) and shows the access line above it. */}
      {machine ? null : (
        <>
          {defaults}

          <div className="mt-8 flex items-center justify-between">
            <Button variant="ghost" onClick={onBack} disabled={submitting}>
              Back
            </Button>
            <Button onClick={onConnect} disabled={submitting || !canSubmit || Boolean(headerError)}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {submitting ? "Checking…" : "Check link"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
