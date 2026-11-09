type Connection = { config: Record<string, unknown>; transportConfig?: Record<string, unknown> | null };

/** GitHub tools that target the authenticated user's personal account when
 * `organization` is omitted. A managed connection can only write there when
 * the Paperclip GitHub App is installed on that personal account. */
const OWNER_DESCRIPTIONS: Record<string, string> = {
  create_repository: "Organization to create the repository in. When omitted, the repository goes to your personal account, unless the Paperclip GitHub App is installed only on one organization; then Paperclip uses that organization.",
  fork_repository: "Organization to fork to. When omitted, the fork goes to your personal account, unless the Paperclip GitHub App is installed only on one organization; then Paperclip uses that organization.",
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function operation(toolName: string): string {
  return (toolName.split(/[.:/]/).pop() ?? "").trim().toLowerCase().replace(/-/g, "_");
}

function isManagedGitHub(connection: Connection): boolean {
  const config = record(connection.config);
  const transport = record(connection.transportConfig);
  return (config.sourceTemplateKey ?? transport.sourceTemplateKey) === "github"
    && (config.connectionMethodKey ?? transport.connectionMethodKey) === "managed";
}

function omitted(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function ownerOwnedTool(connection: Connection, toolName: string, inputSchema: unknown): boolean {
  return isManagedGitHub(connection)
    && operation(toolName) in OWNER_DESCRIPTIONS
    && "organization" in record(record(inputSchema).properties);
}

/** The only account the Paperclip GitHub App is installed on, when that
 * account is an organization rather than the user's own. Repository creation
 * without an organization fails for such a grant, so this is the one owner
 * where it can succeed. Suspended installations are already excluded from
 * the access snapshot. */
export function githubDefaultOrganization(github: unknown): string | null {
  const access = record(github);
  const login = typeof access.login === "string" ? access.login.trim().toLowerCase() : "";
  // GitHub logins are case-insensitive.
  const owners = new Map<string, string>();
  for (const value of Array.isArray(access.installationOwnerLogins) ? access.installationOwnerLogins : []) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (!owners.has(value.trim().toLowerCase())) owners.set(value.trim().toLowerCase(), value.trim());
  }
  if (!login || owners.size !== 1 || owners.has(login)) return null;
  const owner = [...owners.values()][0]!;
  // An installation on another person's account can be visible to a
  // collaborator, and GitHub cannot create organization repositories there.
  // Require the snapshot to identify the owner as an organization; snapshots
  // without account types keep GitHub's behavior until access is refreshed.
  const ownerTypes = new Set((Array.isArray(access.repositories) ? access.repositories : [])
    .map(record)
    .filter((entry) => typeof entry.fullName === "string"
      && entry.fullName.split("/")[0]?.toLowerCase() === owner.toLowerCase())
    .map((entry) => entry.ownerType));
  return ownerTypes.size === 1 && ownerTypes.has("organization") ? owner : null;
}

/** Whether this call could take a default organization. Checked before the
 * grant is loaded so other tools never pay for the lookup. */
export function githubDefaultOwnerApplies(
  connection: Connection,
  toolName: string,
  inputSchema: unknown,
  parameters: unknown,
): boolean {
  return ownerOwnedTool(connection, toolName, inputSchema) && omitted(record(parameters).organization);
}

/** Fill an omitted `organization` from the grant's access snapshot. Explicit
 * owners are kept, and a repository is never forked into its own owner. */
export function githubDefaultOwnerArguments(
  toolName: string,
  parameters: Record<string, unknown>,
  github: unknown,
): Record<string, unknown> {
  const organization = githubDefaultOrganization(github);
  if (!organization || !omitted(parameters.organization)) return parameters;
  if (operation(toolName) === "fork_repository" && typeof parameters.owner === "string" &&
      parameters.owner.trim().toLowerCase() === organization.toLowerCase()) return parameters;
  return { ...parameters, organization };
}

/** Describe the default on the `organization` argument for agents and the
 * connection test form. */
export function githubOwnerToolInputSchema(
  connection: Connection,
  toolName: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!ownerOwnedTool(connection, toolName, schema)) return schema;
  const properties = record(schema.properties);
  return {
    ...schema,
    properties: {
      ...properties,
      organization: { ...record(properties.organization), description: OWNER_DESCRIPTIONS[operation(toolName)] },
    },
  };
}
