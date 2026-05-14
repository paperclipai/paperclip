// Identifier allocator — central choice point for who mints a new issue's
// identifier. Task 2.1 of the Linear ↔ Paperclip ID Unification plan
// (onprem-k8s commit 9979d0d / .planning/linear-id-unification.md).
//
// Today: every company gets the paperclip-internal `${issuePrefix}-${counter}`
// path, which is the existing behaviour pulled verbatim out of
// services/issues.ts so it's testable and so the linear branch has a place
// to land in Task 2.2 without re-touching the issue creation tx.
//
// The function deliberately accepts a transaction-or-db handle (Drizzle's
// `tx` shares the `Db` shape during `db.transaction(...)`) because the
// paperclip path's counter increment must run inside the same tx as the
// `issues` insert — otherwise two concurrent creators race on
// `issue_counter` and produce a duplicate identifier despite the
// self-correcting `greatest(issueCounter, currentMax) + 1`.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  issues,
  pluginCompanySettings,
  pluginState,
  plugins,
} from "@paperclipai/db";
import { secretService } from "./secrets.js";

// Structural subset of `Db` that the allocator actually uses. Same pattern
// as `GoalReader` in services/goals.ts — accepts either the root client or
// an active tx (Drizzle's tx handle structurally satisfies this Pick).
type IdentifierAllocatorDb = Pick<Db, "select" | "update">;

const LINEAR_PLUGIN_KEY = "paperclip-plugin-linear";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export interface AllocateIdentifierInput {
  /** Drizzle handle. Pass the active transaction when called from inside one. */
  db: IdentifierAllocatorDb;
  companyId: string;
  /** Title is plumbed through for the Linear path (Task 2.2) which posts it
   *  to Linear's IssueCreate mutation. The paperclip path ignores it. */
  title: string;
  description?: string | null;
  /**
   * Mirror-create signal: when set, the caller is importing an existing
   * Linear issue rather than minting a new one. For linear-provider
   * companies, the allocator skips the IssueCreate GraphQL call and uses
   * the supplied identifier verbatim — without this, importing a Linear
   * webhook into a cutover company would mint a duplicate Linear issue
   * and silently disconnect from the original. For paperclip-provider
   * companies the hint is ignored here (allocator returns the next
   * paperclip-internal id); the caller still uses it to write the
   * linear_issue_links row.
   */
  linkedLinearIssue?: { id: string; identifier: string };
}

export interface AllocateIdentifierResult {
  /** The minted identifier (e.g. "BLO-2667" or "PCL-12"). */
  identifier: string;
  /** Bookkeeping: the integer suffix, used to populate issues.issueNumber. */
  issueNumber: number;
  /** Which provider issued the identifier. Determines downstream link rows. */
  source: "paperclip" | "linear";
  /** Linear-side issue id, when source === "linear". */
  externalIssueId?: string;
  /**
   * True only when allocateFromLinear created a brand-new Linear issue in
   * this call. False for the paperclip path and for the linkedLinearIssue
   * passthrough (where the Linear issue pre-existed). The issues-create
   * tx uses this to gate the compensating-delete-on-rollback handler:
   * without it, a tx rollback after a mirror import would delete the
   * pre-existing Linear issue we just linked to.
   */
  createdLinearSideIssue: boolean;
}

export async function allocateIdentifier(
  input: AllocateIdentifierInput,
): Promise<AllocateIdentifierResult> {
  const { db, companyId } = input;

  const company = await db
    .select({ provider: companies.identifierProvider })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0]);

  if (company?.provider === "linear") {
    return allocateFromLinear(input);
  }
  return allocateFromPaperclip(input);
}

// Pulled verbatim from services/issues.ts (the previous inline block).
// Kept transactional: the caller MUST pass the active tx as `input.db` when
// inside an issue-creation transaction, otherwise concurrent creators race
// on `companies.issue_counter`.
async function allocateFromPaperclip(
  input: AllocateIdentifierInput,
): Promise<AllocateIdentifierResult> {
  const { db, companyId } = input;

  // Self-correcting counter: use MAX(issue_number) + 1 if the counter has
  // drifted below the actual max. Defends against historical data imports
  // that leave issueCounter stale relative to the issues table.
  const [maxRow] = await db
    .select({ maxNum: sql<number>`coalesce(max(${issues.issueNumber}), 0)` })
    .from(issues)
    .where(eq(issues.companyId, companyId));
  const currentMax = maxRow?.maxNum ?? 0;

  const [company] = await db
    .update(companies)
    .set({
      issueCounter: sql`greatest(${companies.issueCounter}, ${currentMax}) + 1`,
    })
    .where(eq(companies.id, companyId))
    .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

  const issueNumber = company.issueCounter;
  const identifier = `${company.issuePrefix}-${issueNumber}`;

  return { identifier, issueNumber, source: "paperclip", createdLinearSideIssue: false };
}

// Linear path: read the linear plugin's per-company config, resolve the API
// key from the company-secret pointer (linearTokenRef), then call Linear's
// IssueCreate GraphQL mutation. Returns the Linear-issued identifier + the
// internal Linear issue id, both of which the caller persists into a
// linear_issue_links row after the issues row is inserted.
//
// The HTTP call runs inside whatever ctx the caller provides — typically the
// open db.transaction(...) from services/issues.ts. At low write rates this
// is fine; at higher write rates the tx holds the row lock for the duration
// of the Linear roundtrip and contention can grow. If that becomes a
// problem, hoist this call out of the tx in the caller.
async function allocateFromLinear(
  input: AllocateIdentifierInput,
): Promise<AllocateIdentifierResult> {
  const { db, companyId, title, description, linkedLinearIssue } = input;

  // Mirror-import path: caller already has the Linear issue and is asking
  // us to bind to it rather than mint another. Skip IssueCreate entirely
  // and pass the identifier through. createdLinearSideIssue=false so the
  // caller's compensating-delete handler ignores this (we did not create
  // the Linear issue and must not delete it on tx rollback).
  if (linkedLinearIssue) {
    const numMatch = linkedLinearIssue.identifier.match(/-(\d+)$/);
    if (!numMatch) {
      throw new Error(
        `Unexpected Linear identifier format in linkedLinearIssue: ${linkedLinearIssue.identifier}`,
      );
    }
    return {
      identifier: linkedLinearIssue.identifier,
      issueNumber: Number.parseInt(numMatch[1], 10),
      source: "linear",
      externalIssueId: linkedLinearIssue.id,
      createdLinearSideIssue: false,
    };
  }

  const cfg = await getLinearConfigForCompany(db, companyId);
  const created = await createLinearIssue({
    apiKey: cfg.apiKey,
    teamId: cfg.teamId,
    title,
    description: description ?? undefined,
  });
  // Linear identifier is "TEAM-N"; extract the numeric suffix so the issues
  // row's issue_number column stays meaningful (and so existing reports that
  // group by issue_number keep working).
  const numMatch = /-(\d+)$/.exec(created.identifier);
  if (!numMatch) {
    throw new Error(`Unexpected Linear identifier format: ${created.identifier}`);
  }
  return {
    identifier: created.identifier,
    issueNumber: Number.parseInt(numMatch[1], 10),
    source: "linear",
    externalIssueId: created.id,
    createdLinearSideIssue: true,
  };
}

interface LinearConfig {
  apiKey: string;
  teamId: string;
}

// State keys mirrored from packages/plugins/paperclip-plugin-linear/src/constants.ts
// (kept inline to avoid pulling the plugin package as a server-side dep). These
// are the identifiers under which the linear plugin's worker stores OAuth state
// at scope_kind="instance".
const LINEAR_STATE_KEY_OAUTH_TOKEN = "oauth-token";
const LINEAR_STATE_KEY_SECRET_TOKEN_REF = "secret-token-ref";
const LINEAR_STATE_KEY_OAUTH_TEAM_ID = "oauth-team-id";

async function getLinearConfigForCompany(
  db: IdentifierAllocatorDb,
  companyId: string,
): Promise<LinearConfig> {
  const [plugin] = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(eq(plugins.pluginKey, LINEAR_PLUGIN_KEY));
  if (!plugin) {
    throw new Error(
      `${LINEAR_PLUGIN_KEY} is not installed; cannot allocate Linear-issued identifiers`,
    );
  }

  // Two configuration paths the linear plugin supports — match its
  // `resolveToken()` precedence in worker.ts so the server-side and worker-side
  // resolution agree:
  //   1. Per-company `linearTokenRef` (PAT) in plugin_company_settings
  //   2. Instance-scoped OAuth state in plugin_state
  //
  // OAuth state is keyed by (plugin_id, scope_kind="instance", state_key).
  // `secret-token-ref` is the newer key (token stored via secret-ref);
  // `oauth-token` is the legacy direct-storage key, still in use on instances
  // that connected before the migration. We try secret-token-ref first.
  const [settings] = await db
    .select({ json: pluginCompanySettings.settingsJson })
    .from(pluginCompanySettings)
    .where(
      and(
        eq(pluginCompanySettings.pluginId, plugin.id),
        eq(pluginCompanySettings.companyId, companyId),
      ),
    );
  const settingsJson = (settings?.json ?? {}) as Record<string, unknown>;
  const settingsTeamId =
    typeof settingsJson.teamId === "string" && settingsJson.teamId !== ""
      ? settingsJson.teamId
      : null;
  const settingsTokenRef =
    typeof settingsJson.linearTokenRef === "string" && settingsJson.linearTokenRef !== ""
      ? settingsJson.linearTokenRef
      : null;

  // PAT path takes precedence (matches worker.ts:resolveToken).
  if (settingsTokenRef && settingsTeamId) {
    const apiKey = await secretService(db as Db).resolveSecretValue(
      companyId,
      settingsTokenRef,
      "latest",
    );
    return { apiKey, teamId: settingsTeamId };
  }

  // OAuth fallback. teamId comes from plugin_state.oauth-team-id when the
  // settings_json copy isn't populated (the OAuth callback writes it there).
  // readInstanceState returns `unknown` (plugin_state.value_json is JSONB) —
  // narrow to a non-empty string before use so the typechecker can prove the
  // returned LinearConfig.teamId is a string. Non-string values would have
  // failed downstream anyway; failing here surfaces a cleaner error.
  const oauthTeamIdRaw =
    settingsTeamId ?? (await readInstanceState(db, plugin.id, LINEAR_STATE_KEY_OAUTH_TEAM_ID));
  if (typeof oauthTeamIdRaw !== "string" || oauthTeamIdRaw === "") {
    throw new Error(
      `${LINEAR_PLUGIN_KEY} has no teamId for company ${companyId} (no plugin_company_settings ` +
        `row, no plugin_state oauth-team-id). Connect via the plugin's settings page first.`,
    );
  }
  const oauthTeamId = oauthTeamIdRaw;

  // Token: prefer the new secret-ref key, fall back to legacy direct-storage.
  const tokenRefValue = await readInstanceState(db, plugin.id, LINEAR_STATE_KEY_SECRET_TOKEN_REF);
  if (typeof tokenRefValue === "string" && tokenRefValue !== "") {
    const apiKey = await secretService(db as Db).resolveSecretValue(
      companyId,
      tokenRefValue,
      "latest",
    );
    return { apiKey, teamId: oauthTeamId };
  }

  const directToken = await readInstanceState(db, plugin.id, LINEAR_STATE_KEY_OAUTH_TOKEN);
  if (typeof directToken === "string" && directToken !== "") {
    return { apiKey: directToken, teamId: oauthTeamId };
  }

  throw new Error(
    `${LINEAR_PLUGIN_KEY} is not authenticated for company ${companyId} ` +
      `(no PAT in plugin_company_settings, no OAuth token in plugin_state). ` +
      `Connect via the plugin's settings page first.`,
  );
}

async function readInstanceState(
  db: IdentifierAllocatorDb,
  pluginId: string,
  stateKey: string,
): Promise<unknown> {
  const [row] = await db
    .select({ value: pluginState.valueJson })
    .from(pluginState)
    .where(
      and(
        eq(pluginState.pluginId, pluginId),
        eq(pluginState.scopeKind, "instance"),
        eq(pluginState.stateKey, stateKey),
      ),
    );
  return row?.value;
}

interface CreatedLinearIssue {
  id: string;
  identifier: string;
  url: string;
}

async function createLinearIssue(params: {
  apiKey: string;
  teamId: string;
  title: string;
  description?: string;
}): Promise<CreatedLinearIssue> {
  const { apiKey, teamId, title, description } = params;
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      // Linear PATs are passed as the bare token (no "Bearer " prefix).
      // Mirrors the existing pattern in server/src/linear-tunnel.ts.
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier url }
          }
        }
      `,
      variables: {
        input: {
          teamId,
          title,
          ...(description ? { description } : {}),
        },
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Linear IssueCreate HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const json = (await response.json()) as {
    errors?: unknown[];
    data?: { issueCreate?: { success?: boolean; issue?: CreatedLinearIssue | null } };
  };
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new Error(`Linear IssueCreate GraphQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`);
  }
  const issue = json.data?.issueCreate?.issue;
  if (!json.data?.issueCreate?.success || !issue) {
    throw new Error(`Linear IssueCreate did not return an issue (success=false or null)`);
  }
  return issue;
}

// Compensating delete used by services/issues.ts when the issues-create tx
// rolls back AFTER allocateFromLinear() already created the issue in Linear.
// Re-resolves the company's Linear config (the apiKey may have rotated since
// the create, and the create-time apiKey isn't in scope at the catch handler
// anyway), then fires Linear's IssueDelete mutation. Best-effort: caller
// swallows errors so the original failure that triggered the rollback
// surfaces unmasked.
export async function deleteLinearIssueForCompany(
  db: IdentifierAllocatorDb,
  companyId: string,
  linearIssueId: string,
): Promise<void> {
  const cfg = await getLinearConfigForCompany(db, companyId);
  await deleteLinearIssue({ apiKey: cfg.apiKey, issueId: linearIssueId });
}

async function deleteLinearIssue(params: { apiKey: string; issueId: string }): Promise<void> {
  const { apiKey, issueId } = params;
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `
        mutation IssueDelete($id: String!) {
          issueDelete(id: $id) { success }
        }
      `,
      variables: { id: issueId },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Linear IssueDelete HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as {
    errors?: unknown[];
    data?: { issueDelete?: { success?: boolean } };
  };
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new Error(`Linear IssueDelete GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  if (!json.data?.issueDelete?.success) {
    throw new Error(`Linear IssueDelete returned success=false for issueId=${issueId}`);
  }
}
