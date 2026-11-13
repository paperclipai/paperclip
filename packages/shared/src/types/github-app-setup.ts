export type GitHubAppOwner = {
  ownerType: "personal" | "organization";
  ownerLogin?: string;
};
export type GitHubAppRegistrationInput = GitHubAppOwner & { name: string };
/** Redacted transport route; GitHub setup state belongs to the instance. */
export type GitHubAppCloudState = {
  id: string;
  returnOrigin: string;
  expiresAt: string;
  webhookUrl: string;
  callbackUrls: { manifest: string; install: string; oauth: string };
};
export type GitHubAppWizardState = {
  endpointId: string;
  state:
    | "create"
    | "install"
    | "identity"
    | "verify"
    | "connected"
    | "recovery"
    | "enrollment";
  registration?: {
    registrationUrl: string;
    manifest: Record<string, unknown>;
    expiresAt: string;
  };
  /** Expired, unconsumed Cloud registration; manager must attest no App was created. */
  restartableRegistrationId?: string;
  installationUrl?: string;
  identity?: { githubUserId: string; login: string; avatarUrl: string | null };
  identityLinked?: boolean;
  identityMethod?: "dedicated_app" | "existing_connection";
  verification?: {
    ready: boolean;
    checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
  };
  runtimeChecks?: Array<{
    key: string;
    label: string;
    ok: boolean;
    detail: string;
  }>;
  message?: string;
};
