/**
 * Kkroo-specific bundled-plugin bootstrap.
 *
 * Pulls every kkroo-only side effect that runs after the upstream
 * `autoInstallBundledPlugins` npm-install loop into a single file so future
 * merges of `paperclipai/master` into kkroo's `master` don't conflict on
 * `server/src/index.ts`. If upstream changes the install loop, the conflicts
 * land here at most — and `index.ts` keeps a stable two-call surface.
 *
 * What lives here:
 *   - Local-path install fallbacks for chat, ccrotate, and linear plugins
 *     bundled in-image at `packages/plugins/*` (no npm publish).
 *   - Auto-configuration of the Linear plugin from
 *     `PAPERCLIP_LINEAR_CLIENT_ID`/`PAPERCLIP_LINEAR_CLIENT_SECRET` env vars.
 *
 * If you need to add a new bundled plugin or auto-config block, do it here.
 * Treat `index.ts` as upstream-aligned territory.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { logger } from "../middleware/logger.js";

type FetchInternal = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface BootstrapContext {
  baseUrl: string;
  fetchInternal: FetchInternal;
}

interface PluginListEntry {
  id: string;
  pluginKey: string;
  status: string;
  packageName?: string;
}

async function listInstalledPlugins(ctx: BootstrapContext): Promise<PluginListEntry[]> {
  const res = await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins`).catch(() => null);
  if (!res?.ok) return [];
  return (await res.json()) as PluginListEntry[];
}

async function readBundlePackageName(absPath: string): Promise<string | null> {
  try {
    const raw = await readFile(resolve(absPath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

interface LocalPluginInstall {
  /** Plugin key the host will register the plugin under (matches manifest). */
  pluginKey: string;
  /** Filesystem path passed to `/api/plugins/install` with `isLocalPath: true`. */
  absPath: string;
  /** Human-readable name used in log lines. */
  displayName: string;
}

async function installLocalPluginIfAbsent(
  ctx: BootstrapContext,
  spec: LocalPluginInstall,
): Promise<void> {
  const installed = await listInstalledPlugins(ctx);
  const existing = installed.find((p) => p.pluginKey === spec.pluginKey && p.status === "ready");

  // Drift check: if a previous deploy installed this pluginKey from a different
  // packageName (e.g. registry has @lucitra/X but the in-image bundle is now
  // @kkroo/X), the dist on disk for the registered packageName is stale and
  // never gets replaced because the pluginKey-only check below would short-
  // circuit. Force a re-install from the bundle path so the host writes the
  // current dist for the current packageName.
  let driftDetected = false;
  if (existing) {
    const bundleName = await readBundlePackageName(spec.absPath);
    if (bundleName && existing.packageName && bundleName !== existing.packageName) {
      driftDetected = true;
      logger.info(
        {
          pluginKey: spec.pluginKey,
          registryPackageName: existing.packageName,
          bundlePackageName: bundleName,
          path: spec.absPath,
        },
        `${spec.displayName} plugin packageName drifted — force-reinstalling from bundle`,
      );
    } else {
      return;
    }
  }

  try {
    if (!driftDetected) {
      logger.info({ path: spec.absPath }, `installing bundled ${spec.displayName} plugin from local path`);
    }
    const res = await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packageName: spec.absPath,
        isLocalPath: true,
        // On drift, repoint the existing registry row to the new bundle path
        // instead of failing with "Plugin already installed".
        ...(driftDetected ? { force: true } : {}),
      }),
    });
    if (res.ok) {
      const result = (await res.json()) as { pluginKey?: string; status?: string };
      logger.info(
        { pluginKey: result.pluginKey, status: result.status, drift: driftDetected || undefined },
        `${spec.displayName} plugin installed from local path`,
      );
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      logger.warn({ error: err.error }, `${spec.displayName} plugin local install failed`);
    }
  } catch (err) {
    logger.warn({ err }, `${spec.displayName} plugin local install threw`);
  }
}

/**
 * Install kkroo-specific plugins from local paths bundled in the docker image.
 *
 * Runs after the upstream npm-based `autoInstallBundledPlugins` loop has had
 * a chance to install npm-published plugins. The chat plugin gets a fallback
 * install from a sibling repo path (used in dev where npm install may have
 * failed); ccrotate and linear are vendored as workspace packages and always
 * install from `packages/plugins/*`.
 */
export async function installKkrooLocalPlugins(ctx: BootstrapContext): Promise<void> {
  // Chat plugin: dev fallback if the upstream npm install loop didn't pick it up.
  await installLocalPluginIfAbsent(ctx, {
    pluginKey: "paperclip-chat",
    absPath: resolve(process.cwd(), "../paperclip-plugin-chat"),
    displayName: "chat",
  });

  // ccrotate: bundled in-image (no npm publish), always install from local path.
  await installLocalPluginIfAbsent(ctx, {
    pluginKey: "kkroo.ccrotate",
    absPath: resolve(process.cwd(), "packages/plugins/paperclip-plugin-ccrotate"),
    displayName: "ccrotate",
  });

  // Linear: bundled in-image. Must run before autoConfigureLinearFromEnv so
  // there's a plugin to configure.
  await installLocalPluginIfAbsent(ctx, {
    pluginKey: "paperclip-plugin-linear",
    absPath: resolve(process.cwd(), "packages/plugins/paperclip-plugin-linear"),
    displayName: "linear",
  });

  // Alertmanager: bundled in-image. Must run before
  // autoConfigureAlertmanagerFromEnv so there's a plugin to configure.
  await installLocalPluginIfAbsent(ctx, {
    pluginKey: "paperclip-plugin-alertmanager",
    absPath: resolve(process.cwd(), "packages/plugins/paperclip-plugin-alertmanager"),
    displayName: "alertmanager",
  });
}

/**
 * Populate the Alertmanager plugin's webhookToken from
 * `PAPERCLIP_ALERTMANAGER_WEBHOOK_TOKEN` so the helm chart can inject the
 * shared bearer token (matching the cluster's `alertmanager-receivers`
 * Secret) without an admin entering it in the UI on every redeploy.
 *
 * Mirrors the autoConfigureLinearFromEnv pattern.
 */
export async function autoConfigureAlertmanagerFromEnv(ctx: BootstrapContext): Promise<void> {
  const webhookToken = process.env.PAPERCLIP_ALERTMANAGER_WEBHOOK_TOKEN;
  if (!webhookToken) return;

  try {
    const allPlugins = await listInstalledPlugins(ctx);
    const amPlugin = allPlugins.find(
      (p) => p.pluginKey === "paperclip-plugin-alertmanager" && p.status === "ready",
    );
    if (!amPlugin) return;

    const configRes = await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins/${amPlugin.id}/config`);
    if (!configRes.ok) return;

    const config = (await configRes.json()) as { configJson?: Record<string, unknown> | null };
    const existing = config?.configJson ?? {};
    if (existing.webhookToken === webhookToken) return;

    await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins/${amPlugin.id}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        configJson: {
          ...existing,
          webhookToken,
        },
      }),
    });
    logger.info("Auto-configured Alertmanager plugin webhookToken from env");
  } catch (err) {
    logger.warn({ err }, "failed to auto-configure Alertmanager plugin from env");
  }
}

/**
 * Populate Linear plugin OAuth credentials from environment variables when
 * present and not already configured. Lets the helm chart inject
 * `PAPERCLIP_LINEAR_CLIENT_ID`/`PAPERCLIP_LINEAR_CLIENT_SECRET` instead of
 * requiring an admin to enter them through the settings UI on every redeploy.
 */
export async function autoConfigureLinearFromEnv(ctx: BootstrapContext): Promise<void> {
  const linearClientId = process.env.PAPERCLIP_LINEAR_CLIENT_ID;
  const linearClientSecret = process.env.PAPERCLIP_LINEAR_CLIENT_SECRET;
  if (!linearClientId || !linearClientSecret) return;

  try {
    const allPlugins = await listInstalledPlugins(ctx);
    const linearPlugin = allPlugins.find(
      (p) => p.pluginKey === "paperclip-plugin-linear" && p.status === "ready",
    );
    if (!linearPlugin) return;

    const configRes = await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins/${linearPlugin.id}/config`);
    if (!configRes.ok) return;

    const config = (await configRes.json()) as { configJson?: Record<string, unknown> | null };
    const existing = config?.configJson ?? {};
    if (existing.linearClientId && existing.linearClientSecret) return;

    await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins/${linearPlugin.id}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        configJson: {
          ...existing,
          linearClientId,
          linearClientSecret,
          syncComments: existing.syncComments ?? true,
          syncDirection: existing.syncDirection ?? "bidirectional",
        },
      }),
    });
    logger.info("Auto-configured Linear plugin from env vars");
  } catch (err) {
    logger.warn({ err }, "failed to auto-configure Linear plugin from env");
  }
}
