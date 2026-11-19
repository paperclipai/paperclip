import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, type Db } from "@paperclipai/db";
import {
  buildSlackAppManifest,
  isSlackManifestUpdatePending,
  normalizeSlackOptInGroups,
  slackAppConfigurationSchema,
  slackBotScopes,
  SLACK_DEFAULT_BOT_SCOPES,
  slackManifestBotScopes,
  slackOptInGroupsForSetup,
  slackOptInGroupsFromScopes,
  slackRequestedOptInGroups,
  slackSearchRedirectUri,
  SLACK_SEARCH_CALLBACK_PATH,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import { conflict } from "../../../../errors.js";
import { logger } from "../../../../middleware/logger.js";
import { sameSlackOptInGroups } from "../../slack-opt-ins.js";
import { object } from "./provider-client.js";

/**
 * An installed app's per-agent permissions changed and its manifest must be
 * pushed to Slack and re-authorized. Distinct from a new app's first manifest
 * update (`slack_manifest_update_pending`) so the user is told the real reason;
 * `isSlackManifestUpdatePending` treats both as the same follow-up.
 */
export const SLACK_PERMISSIONS_UPDATE_PENDING = "slack_permissions_update_pending";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | DbTransaction;

/**
 * Stable, key-order-independent JSON. `chat_slack_registrations.manifest` is
 * JSONB, which does not preserve key order on read, so a plain stringify can
 * produce a false mismatch and reject a perfectly valid callback.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Bind an OAuth install attempt to the exact manifest it was started with.
 * `install()` records this on the state row; a callback whose registration
 * manifest has since changed is rejected rather than recording a grant the
 * user never approved.
 */
export function slackInstallManifestHash(manifest: unknown): string {
  return createHash("sha256").update(canonicalJson(withoutSearchOAuth(manifest))).digest("hex");
}

/**
 * The personal-search redirect URL and user scopes ride along in the manifest
 * so a push never wipes them, but they do not affect the bot install. Leave
 * them out of the install-binding hash so apps whose stored manifest predates
 * them are not seen as changed (and forced to reinstall).
 */
function withoutSearchOAuth(manifest: unknown): unknown {
  const root = object(manifest);
  const oauth = object(root.oauth_config);
  const { user: _user, ...scopes } = object(oauth.scopes);
  const { redirect_urls: redirects, ...restOauth } = oauth;
  const kept = Array.isArray(redirects)
    ? redirects.filter((url) => !(typeof url === "string" && url.endsWith(SLACK_SEARCH_CALLBACK_PATH)))
    : undefined;
  return {
    ...root,
    oauth_config: {
      ...restOauth,
      scopes,
      ...(kept && kept.length > 0 ? { redirect_urls: kept } : {}),
    },
  };
}

/**
 * TECH-7988: an opt-in change after the app exists can only take effect through
 * a Slack manifest update followed by a reinstall. Rather than inventing a
 * parallel mechanism, rewrite the registration's stored manifest and mark it
 * `slack_permissions_update_pending`. Every path that resolves a pending
 * manifest update (the configuration-token retry and the managed reconnect)
 * recognizes it through `isSlackManifestUpdatePending`.
 *
 * The prior installation keeps its granted scopes until the reinstall lands
 * (see `slackOptInGroupsForSetup`), so a pending change never silently drops
 * live access. Toggling the request back to the installed set clears the
 * pending marker again, so an abandoned change cannot block installation.
 */
export async function applySlackOptInManifestChange(
  executor: Executor,
  input: {
    endpointId: string;
    companyId: string;
    agentName: string;
    app: unknown;
    setup: {
      slackOptInScopeGroups?: readonly SlackOptInScopeGroup[];
      slackInstalledOptInScopeGroups?: readonly SlackOptInScopeGroup[];
      slackInstalledDefaultScopes?: readonly string[];
    };
  },
): Promise<void> {
  const [row] = await executor
    .select()
    .from(chatSlackRegistrations)
    .where(
      and(
        eq(chatSlackRegistrations.endpointId, input.endpointId),
        eq(chatSlackRegistrations.companyId, input.companyId),
      ),
    );
  if (!row?.appId || row.status === "removed") return;
  const eventUrl = object(object(row.manifest.settings).event_subscriptions)
    .request_url;
  if (typeof eventUrl !== "string" || !eventUrl)
    throw conflict(
      "The saved Slack app manifest is unavailable. Resume Slack setup to update its permissions.",
    );
  const requested = slackRequestedOptInGroups(input.setup);
  const installed = slackOptInGroupsForSetup(input.setup);
  const unchanged = sameSlackOptInGroups(requested, installed);
  const app = slackAppConfigurationSchema.parse(input.app);
  const manifest = buildSlackAppManifest({
    app,
    agentName: input.agentName,
    webhookUrl: eventUrl,
    redirectUri: row.callbackUri,
    searchRedirectUri: slackSearchRedirectUri(row.callbackUri),
    optInScopeGroups: requested,
  });
  const manifestHash = slackInstallManifestHash(manifest);
  if (unchanged) {
    // Matching the live grant does not prove Slack still has that manifest:
    // configureManifest may already have pushed another request and moved the
    // registration to install. In that window the restored manifest must be
    // pushed again before authorizing. Keep the marker across repeated edits.
    // A still-configured registration has not pushed the pending change, so
    // withdrawing it can simply clear the permission-change marker.
    const storedScopes = [...slackManifestBotScopes(row.manifest)].sort();
    const rebuiltScopes = [...slackManifestBotScopes(manifest)].sort();
    const scopesChanged = JSON.stringify(storedScopes) !== JSON.stringify(rebuiltScopes);
    const withdrawingUnpushedChange =
      row.status === "configured" &&
      row.errorCode === SLACK_PERMISSIONS_UPDATE_PENDING &&
      input.setup.slackInstalledDefaultScopes !== undefined &&
      SLACK_DEFAULT_BOT_SCOPES.every((scope) =>
        input.setup.slackInstalledDefaultScopes!.includes(scope),
      );
    const mustRepush =
      !withdrawingUnpushedChange &&
      (scopesChanged ||
        row.errorCode === SLACK_PERMISSIONS_UPDATE_PENDING ||
        (row.status !== "configured" && row.manifestHash !== manifestHash));
    if (row.manifestHash === manifestHash && row.errorCode !== SLACK_PERMISSIONS_UPDATE_PENDING) return;
    await executor
      .update(chatSlackRegistrations)
      .set({
        manifest,
        manifestHash,
        // Never clear a new app's first event-settings update. Otherwise an
        // already-pushed change needs the restored manifest applied again;
        // only an unpushed permission change can be withdrawn locally.
        ...(row.errorCode === "slack_manifest_update_pending"
          ? {}
          : mustRepush
            ? { errorCode: SLACK_PERMISSIONS_UPDATE_PENDING }
            : row.errorCode === SLACK_PERMISSIONS_UPDATE_PENDING
              ? { errorCode: null }
              : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatSlackRegistrations.endpointId, input.endpointId),
          eq(chatSlackRegistrations.companyId, input.companyId),
        ),
      );
    return;
  }
  if (manifestHash === row.manifestHash && isSlackManifestUpdatePending(row.errorCode)) return;
  await executor
    .update(chatSlackRegistrations)
    .set({
      manifest,
      manifestHash,
      // A new app still awaiting its first manifest update keeps that reason:
      // applying it pushes this newest manifest anyway, and nothing is installed
      // yet that would need re-authorizing.
      errorCode: row.errorCode === "slack_manifest_update_pending"
        ? row.errorCode
        : SLACK_PERMISSIONS_UPDATE_PENDING,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatSlackRegistrations.endpointId, input.endpointId),
        eq(chatSlackRegistrations.companyId, input.companyId),
      ),
    );
}

/**
 * TECH-7988: record which opt-in groups the live installation actually holds.
 *
 * Derived only from the scopes Slack granted the token -- never from the
 * manifest, which is a request and can change while an OAuth attempt is in
 * flight. Callers must pass a grant read from `auth.test`/`oauth.v2.access`
 * after the runtime accepted the credentials. A group counts as installed only
 * when all of its scopes were granted, so a partial grant leaves its tools
 * gated.
 *
 * Only these two keys are written, atomically, so a concurrent write to any other
 * part of `setup` (not least `runtimeGeneration`) is never lost.
 */
export async function recordInstalledSlackOptIns(
  executor: Executor,
  input: { endpointId: string; companyId: string; grantedScopes: readonly string[] },
): Promise<void> {
  const installed = slackOptInGroupsFromScopes(input.grantedScopes);
  const installedDefaults = SLACK_DEFAULT_BOT_SCOPES.filter((s) =>
    input.grantedScopes.includes(s),
  );
  await executor
    .update(chatEndpoints)
    .set({
      setup: sql`jsonb_set(
        jsonb_set(
          ${chatEndpoints.setup},
          '{slackInstalledOptInScopeGroups}',
          ${JSON.stringify(installed)}::jsonb,
          true
        ),
        '{slackInstalledDefaultScopes}',
        ${JSON.stringify(installedDefaults)}::jsonb,
        true
      )`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatEndpoints.id, input.endpointId),
        eq(chatEndpoints.companyId, input.companyId),
      ),
    );
}

/**
 * Ensures the stored Slack app manifest bot scopes reflect current default and
 * requested opt-in scopes. Rebuilds and marks pending if scopes drifted. Idempotent.
 */
export async function ensureSlackManifestScopesCurrent(
  executor: Executor,
  input: {
    endpointId: string;
    companyId: string;
    agentName: string;
    app: unknown;
    setup: {
      slackOptInScopeGroups?: readonly SlackOptInScopeGroup[] | readonly unknown[];
      slackInstalledOptInScopeGroups?: readonly SlackOptInScopeGroup[] | readonly unknown[];
    };
  },
): Promise<void> {
  const [row] = await executor
    .select()
    .from(chatSlackRegistrations)
    .where(
      and(
        eq(chatSlackRegistrations.endpointId, input.endpointId),
        eq(chatSlackRegistrations.companyId, input.companyId),
      ),
    );
  if (!row?.appId || row.status === "removed") return;
  const eventUrl = object(object(row.manifest.settings).event_subscriptions)
    .request_url;
  if (typeof eventUrl !== "string" || !eventUrl)
    throw conflict(
      "The saved Slack app manifest is unavailable. Resume Slack setup to update its permissions.",
    );

  const currentBotScopes = slackManifestBotScopes(row.manifest);
  const normalizedGroups =
    input.setup.slackOptInScopeGroups === undefined
      ? slackOptInGroupsFromScopes(currentBotScopes)
      : normalizeSlackOptInGroups(input.setup.slackOptInScopeGroups);
  const targetBotScopes = slackBotScopes(normalizedGroups);
  if (
    JSON.stringify([...currentBotScopes].sort()) ===
    JSON.stringify([...targetBotScopes].sort())
  ) {
    return;
  }

  const parsedApp = slackAppConfigurationSchema.safeParse(input.app);
  if (!parsedApp.success) {
    logger.warn(
      { endpointId: input.endpointId, companyId: input.companyId, error: parsedApp.error },
      "Invalid Slack app configuration for manifest scope update",
    );
    throw conflict(
      "The saved Slack app configuration is unavailable. Resume Slack setup to update its permissions.",
    );
  }
  const app = parsedApp.data;
  const manifest = buildSlackAppManifest({
    app,
    agentName: input.agentName,
    webhookUrl: eventUrl,
    redirectUri: row.callbackUri,
    searchRedirectUri: slackSearchRedirectUri(row.callbackUri),
    optInScopeGroups: normalizedGroups,
  });
  const manifestHash = slackInstallManifestHash(manifest);

  await executor
    .update(chatSlackRegistrations)
    .set({
      manifest,
      manifestHash,
      errorCode:
        row.errorCode === "slack_manifest_update_pending"
          ? row.errorCode
          : SLACK_PERMISSIONS_UPDATE_PENDING,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatSlackRegistrations.endpointId, input.endpointId),
        eq(chatSlackRegistrations.companyId, input.companyId),
      ),
    );
}
