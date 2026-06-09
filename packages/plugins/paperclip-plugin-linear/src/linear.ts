/**
 * Linear GraphQL API client. Uses the plugin SDK's http.fetch for outbound calls
 * so all requests go through the capability-gated host proxy.
 */

import crypto from "node:crypto";

const LINEAR_API = "https://api.linear.app/graphql";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";

interface LinearFetch {
  (url: string, init?: RequestInit): Promise<Response>;
}

// ---------------------------------------------------------------------------
// TTL cache for near-static workspace reads (teams, org, workflow states).
//
// These rarely change but were re-fetched from Linear on every webhook, tool
// call, and sync operation. At fleet scale that multiplied Linear API calls and
// helped exhaust the workspace's 2500 req/hr limit (HTTP -32603), which in turn
// made identifier->issue resolution and status sync fail intermittently. The
// plugin worker is long-lived (module-level state), so an in-process TTL cache
// survives across events. Keyed by a token fingerprint so raw OAuth tokens are
// never retained as map keys.
// ---------------------------------------------------------------------------
const STATIC_READ_TTL_MS = 10 * 60_000;
const staticReadCache = new Map<string, { value: unknown; at: number }>();

function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

async function cachedStaticRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = staticReadCache.get(key);
  if (hit && Date.now() - hit.at < STATIC_READ_TTL_MS) {
    return hit.value as T;
  }
  const value = await load();
  staticReadCache.set(key, { value, at: Date.now() });
  return value;
}

// --- OAuth helpers ---

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

export async function exchangeCodeForToken(
  fetch: LinearFetch,
  params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
): Promise<OAuthTokenResponse> {
  const res = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  return (await res.json()) as OAuthTokenResponse;
}

export async function revokeToken(
  fetch: LinearFetch,
  token: string,
): Promise<void> {
  await fetch(LINEAR_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

/** Get the highest issue number for a team (to set issueCounter) */
export async function getHighestIssueNumber(
  fetch: LinearFetch,
  token: string,
  teamId: string,
): Promise<number> {
  const data = await gql<{
    issues: { nodes: Array<{ number: number }> };
  }>(fetch, token, `
    query HighestIssueNumber($teamId: ID!) {
      issues(
        filter: { team: { id: { eq: $teamId } } }
        orderBy: createdAt
        first: 1
      ) {
        nodes { number }
      }
    }
  `, { teamId });
  return data.issues.nodes[0]?.number ?? 0;
}

/** Register or update a webhook on Linear */
export async function registerWebhook(
  fetch: LinearFetch,
  token: string,
  params: {
    url: string;
    teamId: string;
    label?: string;
    resourceTypes?: string[];
  },
): Promise<{ id: string; enabled: boolean }> {
  const label = params.label ?? "Paperclip Sync (auto)";
  const resourceTypes = params.resourceTypes ?? ["Issue", "Comment", "IssueLabel", "Project"];

  // Check for existing webhook
  const existing = await gql<{
    webhooks: { nodes: Array<{ id: string; url: string; label: string; enabled: boolean }> };
  }>(fetch, token, `
    query ExistingWebhooks {
      webhooks { nodes { id url label enabled } }
    }
  `);

  const match = existing.webhooks.nodes.find(
    (w) => w.label === label || w.url.includes("/api/plugins/"),
  );

  if (match) {
    // Update existing
    const updated = await gql<{
      webhookUpdate: { webhook: { id: string; enabled: boolean } };
    }>(fetch, token, `
      mutation UpdateWebhook($id: String!, $input: WebhookUpdateInput!) {
        webhookUpdate(id: $id, input: $input) {
          webhook { id enabled }
        }
      }
    `, { id: match.id, input: { url: params.url, enabled: true } });
    return updated.webhookUpdate.webhook;
  }

  // Create new
  const created = await gql<{
    webhookCreate: { webhook: { id: string; enabled: boolean } };
  }>(fetch, token, `
    mutation CreateWebhook($input: WebhookCreateInput!) {
      webhookCreate(input: $input) {
        webhook { id enabled }
      }
    }
  `, {
    input: {
      url: params.url,
      label,
      teamId: params.teamId,
      resourceTypes,
      enabled: true,
    },
  });
  return created.webhookCreate.webhook;
}

/** Delete a webhook from Linear */
export async function deleteWebhook(
  fetch: LinearFetch,
  token: string,
  webhookId: string,
): Promise<void> {
  await gql(fetch, token, `
    mutation DeleteWebhook($id: String!) {
      webhookDelete(id: $id) { success }
    }
  `, { id: webhookId });
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  priority: number;
  url: string;
  assignee: { name: string; email: string } | null;
  labels: { nodes: Array<{ name: string; color: string }> };
  project: { id: string; name: string; description: string | null; state: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinearComment {
  id: string;
  body: string;
  user: { name: string; email: string };
  createdAt: string;
  url: string;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearSearchResult {
  issues: LinearIssue[];
  totalCount: number;
}

async function gql<T>(
  fetch: LinearFetch,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API error: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }
  if (!json.data) {
    throw new Error("Linear API returned no data");
  }
  return json.data;
}

export async function searchIssues(
  fetch: LinearFetch,
  token: string,
  teamId: string,
  query: string,
): Promise<LinearSearchResult> {
  const filter: Record<string, unknown> = {};
  if (teamId) filter.team = { id: { eq: teamId } };

  // Linear deprecated `issueSearch` — the supported API is the generic
  // `issues` connection with an IssueFilter. Pass the query via searchableContent
  // filter for text matching, plus any additional filters the caller supplied.
  // Empty query → return recent issues for the team (no text filter).
  const effectiveFilter: Record<string, unknown> = { ...filter };
  if (query && query.trim().length > 0) {
    effectiveFilter.searchableContent = { contains: query };
  }

  const data = await gql<{
    issues: { nodes: LinearIssue[] };
  }>(fetch, token, `
    query SearchIssues($filter: IssueFilter) {
      issues(filter: $filter, first: 20, orderBy: updatedAt) {
        nodes {
          id identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name email }
          labels { nodes { name color } }
          project { id name description state }
        }
      }
    }
  `, { filter: Object.keys(effectiveFilter).length ? effectiveFilter : undefined });

  return {
    issues: data.issues.nodes,
    totalCount: data.issues.nodes.length,
  };
}

export async function getIssue(
  fetch: LinearFetch,
  token: string,
  issueId: string,
): Promise<LinearIssue> {
  const data = await gql<{ issue: LinearIssue }>(fetch, token, `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id identifier title description url priority
        createdAt updatedAt
        state { name type }
        assignee { name email }
        labels { nodes { name color } }
          project { id name description state }
      }
    }
  `, { id: issueId });

  return data.issue;
}

export async function getIssueByIdentifier(
  fetch: LinearFetch,
  token: string,
  identifier: string,
): Promise<LinearIssue | null> {
  try {
    const [teamKey, numberStr] = identifier.split("-");
    if (!teamKey || !numberStr) return null;
    const number = parseInt(numberStr, 10);

    const data = await gql<{
      issues: { nodes: LinearIssue[] };
    }>(fetch, token, `
      query GetIssueByNumber($teamKey: String!, $number: Float!) {
        issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
          nodes {
            id identifier title description url priority
            createdAt updatedAt
            state { name type }
            assignee { name email }
            labels { nodes { name color } }
          project { id name description state }
          }
        }
      }
    `, { teamKey, number });

    return data.issues.nodes[0] ?? null;
  } catch {
    return null;
  }
}

export async function listIssuesByIds(
  fetch: LinearFetch,
  token: string,
  issueIds: string[],
): Promise<LinearIssue[]> {
  const ids = Array.from(new Set(issueIds.filter((id) => id.trim().length > 0)));
  if (ids.length === 0) return [];

  const data = await gql<{
    issues: { nodes: LinearIssue[] };
  }>(fetch, token, `
    query ListIssuesByIds($ids: [String!]!, $first: Int!) {
      issues(filter: { id: { in: $ids } }, first: $first) {
        nodes {
          id identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name email }
          labels { nodes { name color } }
          project { id name description state }
        }
      }
    }
  `, { ids, first: ids.length });

  return data.issues.nodes;
}

export async function createIssue(
  fetch: LinearFetch,
  token: string,
  input: {
    title: string;
    description?: string;
    teamId: string;
    priority?: number;
    assigneeId?: string;
  },
): Promise<LinearIssue> {
  const data = await gql<{
    issueCreate: { issue: LinearIssue };
  }>(fetch, token, `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        issue {
          id identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name email }
          labels { nodes { name color } }
          project { id name description state }
        }
      }
    }
  `, { input });

  return data.issueCreate.issue;
}

// Create a "link" attachment on a Linear issue.
//
// Uses attachmentCreate rather than the older attachmentLinkURL shorthand so
// callers can attach subtitle/icon/metadata. Linear treats duplicate
// (issueId, url) link attachments as an update/upsert class, but callers still
// handle duplicate-URL errors rather than relying on silent no-op. See docs:
// https://developers.linear.app/docs/graphql/working-with-the-graphql-api/attachments
export async function attachmentLinkURL(
  fetch: LinearFetch,
  token: string,
  input: {
    issueId: string;
    url: string;
    title: string;
    subtitle?: string;
    iconUrl?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ success: boolean; attachmentId: string | null }> {
  const attachmentInput = {
    issueId: input.issueId,
    url: input.url,
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  const data = await gql<{
    attachmentCreate: { success: boolean; attachment: { id: string } | null };
  }>(fetch, token, `
    mutation AttachmentCreate($input: AttachmentCreateInput!) {
      attachmentCreate(input: $input) {
        success
        attachment { id }
      }
    }
  `, { input: attachmentInput });

  return {
    success: data.attachmentCreate.success,
    attachmentId: data.attachmentCreate.attachment?.id ?? null,
  };
}

/**
 * Mark `dupeLinearId` as a native Linear "duplicate" of `keeperLinearId`
 * (issueRelationCreate type: duplicate). Idempotent: pre-checks the dupe
 * issue's relations and no-ops if the duplicate→keeper relation already
 * exists, mirroring the duplicate-URL handling in attachmentLinkURL. Both
 * args are Linear internal issue IDs (resolve identifiers via
 * getIssueByIdentifier first).
 */
export async function markDuplicate(
  fetch: LinearFetch,
  token: string,
  dupeLinearId: string,
  keeperLinearId: string,
): Promise<{ success: boolean; issueRelationId: string | null; alreadyRelated: boolean }> {
  const existing = await gql<{
    issue: {
      relations: { nodes: Array<{ id: string; type: string; relatedIssue: { id: string } | null }> };
    } | null;
  }>(fetch, token, `
    query IssueRelations($id: ID!) {
      issue(id: $id) {
        relations(first: 50) { nodes { id type relatedIssue { id } } }
      }
    }
  `, { id: dupeLinearId });

  const already = existing.issue?.relations.nodes.find(
    (r) => r.type === "duplicate" && r.relatedIssue?.id === keeperLinearId,
  );
  if (already) {
    return { success: true, issueRelationId: already.id, alreadyRelated: true };
  }

  try {
    const data = await gql<{
      issueRelationCreate: { success: boolean; issueRelation: { id: string } | null };
    }>(fetch, token, `
      mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) {
          success
          issueRelation { id }
        }
      }
    `, { input: { issueId: dupeLinearId, relatedIssueId: keeperLinearId, type: "duplicate" } });
    return {
      success: data.issueRelationCreate.success,
      issueRelationId: data.issueRelationCreate.issueRelation?.id ?? null,
      alreadyRelated: false,
    };
  } catch (err) {
    if (/already|duplicate/i.test(String(err))) {
      return { success: true, issueRelationId: null, alreadyRelated: true };
    }
    throw err;
  }
}

export async function updateIssue(
  fetch: LinearFetch,
  token: string,
  issueId: string,
  input: Record<string, unknown>,
): Promise<LinearIssue> {
  const data = await gql<{
    issueUpdate: { issue: LinearIssue };
  }>(fetch, token, `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        issue {
          id identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name email }
          labels { nodes { name color } }
          project { id name description state }
        }
      }
    }
  `, { id: issueId, input });

  return data.issueUpdate.issue;
}

/** Convenience wrapper for state-only updates */
export async function updateIssueState(
  fetch: LinearFetch,
  token: string,
  issueId: string,
  stateId: string,
): Promise<LinearIssue> {
  return updateIssue(fetch, token, issueId, { stateId });
}

export async function getWorkflowStates(
  fetch: LinearFetch,
  token: string,
  teamId: string,
): Promise<Array<{ id: string; name: string; type: string }>> {
  return cachedStaticRead(`states:${tokenFingerprint(token)}:${teamId}`, async () => {
    const data = await gql<{
      workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
    }>(fetch, token, `
      query GetStates($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) {
          nodes { id name type }
        }
      }
    `, { teamId });

    return data.workflowStates.nodes;
  });
}

export async function listComments(
  fetch: LinearFetch,
  token: string,
  issueId: string,
): Promise<LinearComment[]> {
  const data = await gql<{
    issue: { comments: { nodes: LinearComment[] } };
  }>(fetch, token, `
    query ListComments($id: String!) {
      issue(id: $id) {
        comments(orderBy: createdAt) {
          nodes {
            id body createdAt url
            user { name email }
          }
        }
      }
    }
  `, { id: issueId });

  return data.issue.comments.nodes;
}

export async function createComment(
  fetch: LinearFetch,
  token: string,
  issueId: string,
  body: string,
): Promise<LinearComment> {
  const data = await gql<{
    commentCreate: { comment: LinearComment };
  }>(fetch, token, `
    mutation CreateComment($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        comment {
          id body createdAt url
          user { name email }
        }
      }
    }
  `, { input: { issueId, body } });

  return data.commentCreate.comment;
}

export async function listOpenIssues(
  fetch: LinearFetch,
  token: string,
  teamId: string,
  cursor?: string,
): Promise<{ issues: LinearIssue[]; hasNextPage: boolean; endCursor: string | null }> {
  const data = await gql<{
    issues: {
      nodes: LinearIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(fetch, token, `
    query ListOpenIssues($teamId: ID!, $after: String) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          state: { type: { nin: ["completed", "canceled", "cancelled"] } }
        }
        first: 50
        after: $after
        orderBy: updatedAt
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name email }
          labels { nodes { name color } }
          project { id name description state }
        }
      }
    }
  `, { teamId, after: cursor ?? null });

  return {
    issues: data.issues.nodes,
    hasNextPage: data.issues.pageInfo.hasNextPage,
    endCursor: data.issues.pageInfo.endCursor,
  };
}

export interface LinearProject {
  id: string;
  name: string;
  description: string | null;
  state: string;
  startDate: string | null;
  targetDate: string | null;
}

interface LinearProjectsPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: LinearProject[];
}

export async function listProjects(
  fetch: LinearFetch,
  token: string,
  teamId?: string,
): Promise<LinearProject[]> {
  const projects: LinearProject[] = [];
  let after: string | null = null;

  if (teamId) {
    do {
      const data: { team: { projects: LinearProjectsPage } } = await gql(fetch, token, `
      query ListTeamProjects($teamId: String!, $after: String) {
        team(id: $teamId) {
          projects(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id name description state startDate targetDate }
          }
        }
      }
    `, { teamId, after });
      projects.push(...data.team.projects.nodes);
      after = data.team.projects.pageInfo.hasNextPage ? data.team.projects.pageInfo.endCursor : null;
    } while (after);

    return projects;
  }

  do {
    const data: { projects: LinearProjectsPage } = await gql(fetch, token, `
    query ListProjects($after: String) {
      projects(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id name description state startDate targetDate }
      }
    }
  `, { after });
    projects.push(...data.projects.nodes);
    after = data.projects.pageInfo.hasNextPage ? data.projects.pageInfo.endCursor : null;
  } while (after);

  return projects;
}

export async function createProject(
  fetch: LinearFetch,
  token: string,
  input: { name: string; description?: string; teamIds: string[]; state?: string },
): Promise<{ id: string; name: string }> {
  const data = await gql<{ projectCreate: { project: { id: string; name: string } } }>(
    fetch, token, `
    mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) { project { id name } }
    }
  `, { input: { name: input.name, description: input.description, teamIds: input.teamIds, state: input.state } });
  return data.projectCreate.project;
}

export async function updateProject(
  fetch: LinearFetch,
  token: string,
  projectId: string,
  input: { name?: string; description?: string; state?: string },
): Promise<{ id: string; name: string }> {
  const data = await gql<{ projectUpdate: { project: { id: string; name: string } } }>(
    fetch, token, `
    mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
      projectUpdate(id: $id, input: $input) { project { id name } }
    }
  `, { id: projectId, input });
  return data.projectUpdate.project;
}

export async function getTeams(
  fetch: LinearFetch,
  token: string,
): Promise<LinearTeam[]> {
  return cachedStaticRead(`teams:${tokenFingerprint(token)}`, async () => {
    const data = await gql<{
      teams: { nodes: LinearTeam[] };
    }>(fetch, token, `
      query GetTeams {
        teams { nodes { id name key } }
      }
    `);

    return data.teams.nodes;
  });
}

export interface LinearOrganization {
  id: string;
  /** Workspace url-key (e.g. `blockcast`) — the slug in `https://linear.app/<urlKey>/...`. */
  urlKey: string;
  name: string;
}

/**
 * Fetch the workspace ("organization") this OAuth token is connected to.
 * The `urlKey` is what we persist so we can build correct issue URLs at
 * webhook ingest time without re-parsing every Linear url ourselves.
 */
export async function getOrganization(
  fetch: LinearFetch,
  token: string,
): Promise<LinearOrganization | null> {
  return cachedStaticRead(`org:${tokenFingerprint(token)}`, async () => {
    const data = await gql<{
      organization: LinearOrganization | null;
    }>(fetch, token, `
      query GetOrganization {
        organization { id urlKey name }
      }
    `);

    return data.organization ?? null;
  });
}

/**
 * Create a new Linear team. `key` must be 1-5 uppercase letters/digits
 * (e.g. "LUC", "ENG2"). Linear will reject duplicates in the workspace.
 */
export async function createTeam(
  fetch: LinearFetch,
  token: string,
  input: { name: string; key: string; description?: string },
): Promise<LinearTeam> {
  const data = await gql<{
    teamCreate: { success: boolean; team: LinearTeam | null };
  }>(fetch, token, `
    mutation CreateTeam($input: TeamCreateInput!) {
      teamCreate(input: $input) {
        success
        team { id name key }
      }
    }
  `, { input });

  if (!data.teamCreate.success || !data.teamCreate.team) {
    throw new Error("Linear teamCreate returned no team");
  }
  return data.teamCreate.team;
}

/**
 * Parse a Linear issue reference from various formats:
 * - https://linear.app/workspace/issue/TEAM-123/title-slug
 * - TEAM-123
 * - team-123
 */
export interface LinearInitiative {
  id: string;
  name: string;
  description: string | null;
  status: string | null;
  targetDate: string | null;
}

export async function listInitiatives(
  fetch: LinearFetch,
  token: string,
): Promise<LinearInitiative[]> {
  try {
    const data = await gql<{
      initiatives: { nodes: LinearInitiative[] };
    }>(fetch, token, `
      query ListInitiatives {
        initiatives { nodes { id name description status targetDate } }
      }
    `);
    return data.initiatives.nodes;
  } catch {
    // Initiatives not available on this workspace plan
    return [];
  }
}

export async function createInitiative(
  fetch: LinearFetch,
  token: string,
  input: { name: string; description?: string; targetDate?: string | null },
): Promise<LinearInitiative> {
  const data = await gql<{
    initiativeCreate: { initiative: LinearInitiative };
  }>(fetch, token, `
    mutation CreateInitiative($input: InitiativeCreateInput!) {
      initiativeCreate(input: $input) { initiative { id name description status targetDate } }
    }
  `, { input });
  return data.initiativeCreate.initiative;
}

export async function updateInitiative(
  fetch: LinearFetch,
  token: string,
  id: string,
  input: { name?: string; description?: string; targetDate?: string | null },
): Promise<LinearInitiative> {
  const data = await gql<{
    initiativeUpdate: { initiative: LinearInitiative };
  }>(fetch, token, `
    mutation UpdateInitiative($id: String!, $input: InitiativeUpdateInput!) {
      initiativeUpdate(id: $id, input: $input) { initiative { id name description status targetDate } }
    }
  `, { id, input });
  return data.initiativeUpdate.initiative;
}

export function parseLinearIssueRef(
  ref: string,
): { identifier: string } | null {
  // URL format
  const urlMatch = ref.match(/linear\.app\/(?:[^/]+\/)?issue\/([A-Z][A-Z0-9]*-\d+)/i);
  if (urlMatch) {
    return { identifier: urlMatch[1].toUpperCase() };
  }

  // Identifier format (TEAM-123)
  const idMatch = ref.match(/^([A-Z][A-Z0-9]*-\d+)$/i);
  if (idMatch) {
    return { identifier: idMatch[1].toUpperCase() };
  }

  return null;
}
