// Git mirror configuration: one GitHub repository mirrored read-only into one
// wiki space per company. Kept free of core imports so the manifest and the
// write guard in core can both use it.

export const GIT_MIRROR_JOB_KEY = "git-mirror-sync";
/**
 * Plugin event (namespaced by the host to `plugin.<plugin key>.<name>`) that runs one company's sync. A
 * host-issued invocation scope ends when its RPC settles and a scheduled job has none, so syncs run in
 * this event's handler, which the host gives a company invocation scope for up to 15 minutes.
 */
export const GIT_MIRROR_SYNC_EVENT = "git-mirror-sync-requested";
export const GIT_MIRROR_CONFIG_KEY = "gitMirror";
export const GIT_MIRROR_PRIVATE_KEY_CONFIG_PATH = `${GIT_MIRROR_CONFIG_KEY}.githubAppPrivateKey`;
export const GIT_MIRROR_TOKEN_CONFIG_PATH = `${GIT_MIRROR_CONFIG_KEY}.token`;

// The host treats `format: "secret-ref"` as a UI hint only, so the shape is
// validated here: a credential field accepts the shared
// `{ type: "secret_ref", secretId }` object, or empty ("" is what the settings
// form sends when the picker is cleared). Any other string, a raw token or key
// pasted through the API, is refused before the host stores it as plain config.
const SECRET_REF_FIELD = {
  format: "secret-ref",
  anyOf: [
    {
      type: "object",
      required: ["type", "secretId"],
      properties: {
        type: { const: "secret_ref" },
        secretId: { type: "string", minLength: 1 },
      },
    },
    { type: "string", maxLength: 0 },
    { type: "null" },
  ],
} as const;

export const GIT_MIRROR_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    [GIT_MIRROR_CONFIG_KEY]: {
      type: "object",
      title: "Git mirror (read-only)",
      description:
        "Mirror the Markdown files of one GitHub repository branch into one wiki space. Paperclip never writes to the repository, and the mirrored space refuses page edits: change the repository to change the wiki.",
      properties: {
        enabled: { type: "boolean", title: "Enabled", default: false },
        repository: {
          type: "string",
          title: "Repository",
          description: "owner/name on github.com, for example acme/handbook.",
        },
        branch: { type: "string", title: "Branch", default: "main" },
        spaceSlug: {
          type: "string",
          title: "Wiki space",
          description: "Slug of the space to mirror into, created if missing. \"default\" is the space the Wiki opens on.",
          default: "default",
        },
        githubAppId: {
          type: "string",
          title: "GitHub App ID",
          description: "A GitHub App installed on the repository. Each sync mints a one-hour installation token narrowed to this repository and contents: read.",
        },
        githubAppInstallationId: { type: "string", title: "GitHub App installation ID" },
        githubAppPrivateKey: { ...SECRET_REF_FIELD, title: "GitHub App private key (PEM)" },
        token: {
          ...SECRET_REF_FIELD,
          title: "Read-only token",
          description: "Instead of a GitHub App: a fine-grained token with contents: read on this repository only. Leave both empty for a public repository.",
        },
      },
    },
  },
} as const;

export type GitMirrorAuth =
  | { kind: "github_app"; appId: string; installationId: string; privateKeyRef: unknown }
  | { kind: "token"; tokenRef: unknown }
  | { kind: "none" };

export type GitMirrorSettings = {
  owner: string;
  repo: string;
  branch: string;
  /** Raw slug as configured; core normalizes it the same way it normalizes every space slug. */
  spaceSlug: string;
  auth: GitMirrorAuth;
  /** Set when the mirror is enabled but misconfigured. The space stays read-only; syncs refuse. */
  error: string | null;
};

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A cleared picker sends "" and an untouched field is absent; neither selects a credential. */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function isSecretRef(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "secret_ref"
    && typeof (value as Record<string, unknown>).secretId === "string";
}

export function isValidBranchName(branch: string): boolean {
  return branch.length <= 200
    && /^[A-Za-z0-9._\/-]+$/.test(branch)
    && !branch.startsWith("/") && !branch.endsWith("/") && !branch.endsWith(".lock")
    && !branch.split("/").some((segment) => !segment || segment.startsWith(".") || segment === "..")
    && !branch.includes("..");
}

/** Returns null when the mirror is absent or disabled. */
export function readGitMirrorConfig(config: Record<string, unknown> | null | undefined): GitMirrorSettings | null {
  const raw = config?.[GIT_MIRROR_CONFIG_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const mirror = raw as Record<string, unknown>;
  if (mirror.enabled !== true) return null;

  const problems: string[] = [];
  const [owner = "", repo = "", ...extra] = (text(mirror.repository) ?? "").split("/");
  if (extra.length > 0 || !OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    problems.push("repository must be owner/name");
  }
  const branch = text(mirror.branch) ?? "main";
  if (!isValidBranchName(branch)) problems.push("branch is not a valid branch name");
  const spaceSlug = text(mirror.spaceSlug) ?? "default";

  const appId = text(mirror.githubAppId);
  const installationId = text(mirror.githubAppInstallationId);
  const privateKeyRef = isSet(mirror.githubAppPrivateKey) ? mirror.githubAppPrivateKey : null;
  const tokenRef = isSet(mirror.token) ? mirror.token : null;
  let auth: GitMirrorAuth = { kind: "none" };
  if (appId || installationId || privateKeyRef != null) {
    if (!appId || !NUMERIC_ID_PATTERN.test(appId)) problems.push("GitHub App ID must be numeric");
    if (!installationId || !NUMERIC_ID_PATTERN.test(installationId)) problems.push("GitHub App installation ID must be numeric");
    if (!isSecretRef(privateKeyRef)) problems.push("GitHub App private key must be a Paperclip secret");
    if (tokenRef != null) problems.push("set either a GitHub App or a token, not both");
    auth = { kind: "github_app", appId: appId ?? "", installationId: installationId ?? "", privateKeyRef };
  } else if (tokenRef != null) {
    if (!isSecretRef(tokenRef)) problems.push("token must be a Paperclip secret");
    auth = { kind: "token", tokenRef };
  }

  return { owner, repo, branch, spaceSlug, auth, error: problems.length > 0 ? problems.join("; ") : null };
}
