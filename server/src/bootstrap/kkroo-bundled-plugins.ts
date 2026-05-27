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

import { existsSync } from "node:fs";
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
  packagePath?: string | null;
  version?: string;
}

async function listInstalledPlugins(ctx: BootstrapContext): Promise<PluginListEntry[]> {
  const res = await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins`).catch(() => null);
  if (!res?.ok) return [];
  return (await res.json()) as PluginListEntry[];
}

async function readBundlePackageJson(
  absPath: string,
): Promise<{ name: string | null; version: string | null }> {
  try {
    const raw = await readFile(resolve(absPath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      version: typeof parsed.version === "string" ? parsed.version : null,
    };
  } catch {
    return { name: null, version: null };
  }
}

/**
 * Compare two semver strings numerically. Returns positive if `a > b`,
 * negative if `a < b`, 0 if equal. Pre-release / build suffixes (e.g.
 * `0.3.0-canary.4`) are stripped before comparison — bundled plugins
 * pin a clean MAJOR.MINOR.PATCH so the simple form is sufficient and
 * avoids pulling in a real semver dep just for this one comparison.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

interface LocalPluginInstall {
  /** Plugin key the host will register the plugin under (matches manifest). */
  pluginKey: string;
  /** Filesystem path passed to `/api/plugins/install` with `isLocalPath: true`. */
  absPath: string;
  /** Human-readable name used in log lines. */
  displayName: string;
}

async function upgradeBundledPlugin(
  ctx: BootstrapContext,
  spec: LocalPluginInstall,
  pluginId: string,
  bundleVersion: string,
  registryVersion: string,
): Promise<void> {
  // For local-path plugins, the upgrade route's loader re-reads the manifest
  // from the registry's stored packagePath (no body fields needed). Force-
  // approve any capability escalation: the bundle is shipped in our own
  // image, so this is implicitly admin-approved at build time.
  try {
    const res = await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins/${pluginId}/upgrade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    if (res.ok) {
      const result = (await res.json()) as { version?: string; status?: string };
      logger.info(
        {
          pluginKey: spec.pluginKey,
          registryVersion,
          bundleVersion,
          newVersion: result.version,
          status: result.status,
        },
        `${spec.displayName} plugin upgraded to bundle version`,
      );
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      logger.warn(
        { pluginKey: spec.pluginKey, registryVersion, bundleVersion, error: err.error },
        `${spec.displayName} plugin version-drift upgrade failed`,
      );
    }
  } catch (err) {
    logger.warn({ pluginKey: spec.pluginKey, err }, `${spec.displayName} plugin upgrade threw`);
  }
}

async function enableBundledPlugin(
  ctx: BootstrapContext,
  spec: LocalPluginInstall,
  pluginId: string,
  fromStatus: string,
): Promise<void> {
  try {
    const res = await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins/${pluginId}/enable`, {
      method: "POST",
    });
    if (res.ok) {
      const result = (await res.json()) as { pluginKey?: string; status?: string };
      logger.info(
        { pluginKey: result.pluginKey ?? spec.pluginKey, fromStatus, status: result.status },
        `${spec.displayName} plugin recovered from non-ready status`,
      );
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      logger.warn(
        { pluginKey: spec.pluginKey, fromStatus, error: err.error },
        `${spec.displayName} plugin recovery enable failed`,
      );
    }
  } catch (err) {
    logger.warn(
      { pluginKey: spec.pluginKey, fromStatus, err },
      `${spec.displayName} plugin recovery enable threw`,
    );
  }
}

async function installLocalPluginIfAbsent(
  ctx: BootstrapContext,
  spec: LocalPluginInstall,
): Promise<void> {
  const installed = await listInstalledPlugins(ctx);
  const existing = installed.find((p) => p.pluginKey === spec.pluginKey);
  const bundlePathExists = existsSync(spec.absPath);

  if (!bundlePathExists) {
    if (!existing || existing.status !== "ready") {
      logger.debug(
        { pluginKey: spec.pluginKey, path: spec.absPath },
        `${spec.displayName} plugin local bundle path missing; skipping local fallback`,
      );
    }
    return;
  }

  // packageName drift: a previous deploy installed this pluginKey from a
  // different packageName (e.g. registry has @lucitra/X but the in-image
  // bundle is now @kkroo/X). The dist on disk for the registered packageName
  // is stale and never gets replaced because the pluginKey-only check below
  // would short-circuit. Force a re-install from the bundle path so the host
  // writes the current dist for the current packageName. Worker is repointed
  // in place; new code takes effect on next worker (re)start.
  //
  // version drift: the in-image bundle has bumped past the registry-recorded
  // version (e.g. 0.2.1 → 0.3.0 added a new route). We don't publish kkroo
  // plugins to npm so the upstream auto-upgrade loop (which polls
  // registry.npmjs.org) never fires. We use the upgrade route here, not
  // install+force, because by the time this runs the worker for v0.2.1 is
  // already running (loader.loadAll() ran before this bootstrap step) — the
  // upgrade lifecycle stops the running worker, re-reads the package from
  // the stored packagePath, and starts a fresh worker with the new code.
  if (existing) {
    const bundle = await readBundlePackageJson(spec.absPath);
    if (bundle.name && existing.packageName && bundle.name !== existing.packageName) {
      logger.info(
        {
          pluginKey: spec.pluginKey,
          registryPackageName: existing.packageName,
          bundlePackageName: bundle.name,
          path: spec.absPath,
        },
        `${spec.displayName} plugin packageName drifted — force-reinstalling from bundle`,
      );
      await forceReinstallLocalPlugin(ctx, spec);
      if (existing.status !== "ready") {
        await enableBundledPlugin(ctx, spec, existing.id, existing.status);
      }
      return;
    }
    // packagePath drift: the registry record was created by the upstream npm
    // install loop (which leaves package_path NULL) before this bootstrap
    // entry existed. The version-bump → upgrade route below would fall back
    // to npm because plugin-loader.upgradePlugin reads localPath from the
    // stored packagePath; with no path, fetchAndValidate refetches from the
    // npm registry instead of the in-image bundle dir. Force a re-install
    // once so the row gets the correct packagePath, after which subsequent
    // version bumps upgrade correctly from disk.
    if (!existing.packagePath || existing.packagePath !== spec.absPath) {
      logger.info(
        {
          pluginKey: spec.pluginKey,
          registryPackagePath: existing.packagePath ?? null,
          bundlePath: spec.absPath,
        },
        `${spec.displayName} plugin packagePath missing or drifted — force-reinstalling from bundle`,
      );
      await forceReinstallLocalPlugin(ctx, spec);
      if (existing.status !== "ready") {
        await enableBundledPlugin(ctx, spec, existing.id, existing.status);
      }
      return;
    }
    if (
      existing.status === "ready" &&
      bundle.version &&
      existing.version &&
      compareVersions(bundle.version, existing.version) > 0
    ) {
      await upgradeBundledPlugin(ctx, spec, existing.id, bundle.version, existing.version);
      return;
    }
    if (existing.status === "disabled" || existing.status === "error" || existing.status === "upgrade_pending") {
      await enableBundledPlugin(ctx, spec, existing.id, existing.status);
      return;
    }
    if (existing.status !== "ready") {
      logger.warn(
        { pluginKey: spec.pluginKey, status: existing.status },
        `${spec.displayName} plugin is installed but not recoverable by bundled bootstrap`,
      );
    }
    return;
  }

  try {
    logger.info({ path: spec.absPath }, `installing bundled ${spec.displayName} plugin from local path`);
    const res = await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packageName: spec.absPath,
        isLocalPath: true,
      }),
    });
    if (res.ok) {
      const result = (await res.json()) as { pluginKey?: string; status?: string };
      logger.info(
        { pluginKey: result.pluginKey, status: result.status },
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

async function forceReinstallLocalPlugin(
  ctx: BootstrapContext,
  spec: LocalPluginInstall,
): Promise<void> {
  try {
    const res = await ctx.fetchInternal(`${ctx.baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packageName: spec.absPath,
        isLocalPath: true,
        force: true,
      }),
    });
    if (res.ok) {
      const result = (await res.json()) as { pluginKey?: string; status?: string };
      logger.info(
        { pluginKey: result.pluginKey, status: result.status, drift: true },
        `${spec.displayName} plugin repointed from local path`,
      );
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      logger.warn({ error: err.error }, `${spec.displayName} plugin local repoint failed`);
    }
  } catch (err) {
    logger.warn({ err }, `${spec.displayName} plugin local repoint threw`);
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

  // gbrain: bundled in-image (no npm publish), always install from local path.
  await installLocalPluginIfAbsent(ctx, {
    pluginKey: "kkroo.gbrain",
    absPath: resolve(process.cwd(), "packages/plugins/paperclip-plugin-gbrain"),
    displayName: "gbrain",
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

  // Slack: in-tree fork (commit 983662b7) takes over from the npm-published
  // 2.0.x. Without this entry the host keeps running whatever was installed
  // when the registry version was first pulled — it never picks up workspace
  // changes (formatters, tools, etc.) on subsequent image deploys.
  await installLocalPluginIfAbsent(ctx, {
    pluginKey: "paperclip-plugin-slack",
    absPath: resolve(process.cwd(), "packages/plugins/paperclip-plugin-slack"),
    displayName: "slack",
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
    // Operator already wired the production secret-ref path; respect it instead
    // of stamping the inline env value back on top every restart.
    if (typeof existing.webhookTokenRef === "string" && existing.webhookTokenRef.length > 0) {
      return;
    }

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
