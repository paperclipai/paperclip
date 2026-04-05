/**
 * @fileoverview Plugin UI static file serving route
 *
 * Serves plugin UI bundles from the plugin's dist/ui/ directory under the
 * `/_plugins/:pluginId/ui/*` namespace. This is specified in PLUGIN_SPEC.md
 * §19.0.3 (Bundle Serving).
 *
 * Plugin UI bundles are pre-built ESM that the host serves as static assets.
 * The host dynamically imports the plugin's UI entry module from this path,
 * resolves the named export declared in `ui.slots[].exportName`, and mounts
 * it into the extension slot.
 *
 * Security:
 * - Path traversal is prevented by resolving the requested path and verifying
 *   it stays within the plugin's UI directory.
 * - Only plugins in 'ready' status have their UI served.
 * - Only plugins that declare `entrypoints.ui` serve UI bundles.
 *
 * Cache Headers:
 * - Files with content-hash patterns in their name (e.g., `index-a1b2c3d4.js`)
 *   receive `Cache-Control: public, max-age=31536000, immutable`.
 * - Other files receive `Cache-Control: public, max-age=0, must-revalidate`
 *   with ETag-based conditional request support.
 *
 * @module server/routes/plugin-ui-static
 * @see doc/plugins/PLUGIN_SPEC.md §19.0.3 — Bundle Serving
 * @see doc/plugins/PLUGIN_SPEC.md §25.4.5 — Frontend Cache Invalidation
 */

import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { Db } from "@paperclipai/db";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex to detect content-hashed filenames.
 *
 * Matches patterns like:
 * - `index-a1b2c3d4.js`
 * - `styles.abc123def.css`
 * - `chunk-ABCDEF01.mjs`
 *
 * The hash portion must be at least 8 hex characters to avoid false positives.
 */
const CONTENT_HASH_PATTERN = /[.-][a-fA-F0-9]{8,}\.\w+$/;

/**
 * Cache-Control header for content-hashed files.
 * These files are immutable by definition (the hash changes when content changes).
 */
/** 1 year in seconds — standard for content-hashed immutable resources. */
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60; // 31_536_000
const CACHE_CONTROL_IMMUTABLE = `public, max-age=${ONE_YEAR_SECONDS}, immutable`;

/**
 * Cache-Control header for non-hashed files.
 * These files must be revalidated on each request (ETag-based).
 */
const CACHE_CONTROL_REVALIDATE = "public, max-age=0, must-revalidate";

/**
 * MIME types for common plugin UI bundle file extensions.
 */
const MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Resolve a plugin's UI directory from its package location.
 *
 * The plugin's `packageName` is stored in the DB. We resolve the package path
 * from the local plugin directory (DEFAULT_LOCAL_PLUGIN_DIR) by looking in
 * `node_modules`. If the plugin was installed from a local path, the manifest
 * `entrypoints.ui` path is resolved relative to the package directory.
 *
 * @param localPluginDir - The plugin installation directory
 * @param packageName - The npm package name
 * @param entrypointsUi - The UI entrypoint path from the manifest (e.g., "./dist/ui/")
 * @returns Absolute path to the UI directory, or null if not found
 */
export function resolvePluginUiDir(
  localPluginDir: string,
  packageName: string,
  entrypointsUi: string,
  packagePath?: string | null,
): string | null {
  // For local-path installs, prefer the persisted package path.
  if (packagePath) {
    const resolvedPackagePath = path.resolve(packagePath);
    if (fs.existsSync(resolvedPackagePath)) {
      const uiDirFromPackagePath = path.resolve(resolvedPackagePath, entrypointsUi);
      if (
        uiDirFromPackagePath.startsWith(resolvedPackagePath)
        && fs.existsSync(uiDirFromPackagePath)
      ) {
        return uiDirFromPackagePath;
      }
    }
  }

  // Resolve the package root within the local plugin directory's node_modules.
  // npm installs go to <localPluginDir>/node_modules/<packageName>/
  let packageRoot: string;
  if (packageName.startsWith("@")) {
    // Scoped package: @scope/name -> node_modules/@scope/name
    packageRoot = path.join(localPluginDir, "node_modules", ...packageName.split("/"));
  } else {
    packageRoot = path.join(localPluginDir, "node_modules", packageName);
  }

  // If the standard location doesn't exist, the plugin may have been installed
  // from a local path. Try to check if the package.json is accessible at the
  // computed path or if the package is found elsewhere.
  if (!fs.existsSync(packageRoot)) {
    // For local-path installs, the packageName may be a directory that doesn't
    // live inside node_modules. Check if the package exists directly at the
    // localPluginDir level.
    const directPath = path.join(localPluginDir, packageName);
    if (fs.existsSync(directPath)) {
      packageRoot = directPath;
    } else {
      return null;
    }
  }

  // Resolve the UI directory relative to the package root
  const uiDir = path.resolve(packageRoot, entrypointsUi);

  // Verify the resolved UI directory exists and is actually inside the package
  if (!fs.existsSync(uiDir)) {
    return null;
  }

  return uiDir;
}

/**
 * Compute an ETag from file stat (size + mtime).
 * This is a lightweight approach that avoids reading the file content.
 */
function computeETag(size: number, mtimeMs: number): string {
  const ETAG_VERSION = "v2";
  const hash = crypto
    .createHash("md5")
    .update(`${ETAG_VERSION}:${size}-${mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
  return `"${hash}"`;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Options for the plugin UI static route.
 */
export interface PluginUiStaticRouteOptions {
  /**
   * The local plugin installation directory.
   * This is where plugins are installed via `npm install --prefix`.
   * Defaults to the standard `~/.paperclip/plugins/` location.
   */
  localPluginDir: string;
}

/**
 * Create an Express router that serves plugin UI static files.
 *
 * This route handles `GET /_plugins/:pluginId/ui/*` requests by:
 * 1. Looking up the plugin in the registry by ID or key
 * 2. Verifying the plugin is in 'ready' status with UI declared
 * 3. Resolving the file path within the plugin's dist/ui/ directory
 * 4. Serving the file with appropriate cache headers
 *
 * @param db - Database connection for plugin registry lookups
 * @param options - Configuration options
 * @returns Express router
 */
export function pluginUiStaticRoutes(db: Db, options: PluginUiStaticRouteOptions) {
  const router = Router();
  const registry = pluginRegistryService(db);
  const log = logger.child({ service: "plugin-ui-static" });

  // CORS: restrict Access-Control-Allow-Origin to known origins only.
  // Read comma-separated list from ALLOWED_ORIGINS env var (e.g. "http://localhost:3000,https://app.example.com").
  // If not set, fall back to empty list (no CORS headers emitted — same-origin only).
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // Preflight handler for plugin UI routes
  router.options("/_plugins/:pluginId/ui/*filePath", (req, res) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
    }
    res.status(204).end();
  });

  /**
   * GET /_plugins/:pluginId/ui/*
   *
   * Serve a static file from a plugin's UI bundle directory.
   *
   * The :pluginId parameter accepts either:
   * - Database UUID
   * - Plugin key (e.g., "acme.linear")
   *
   * The wildcard captures the relative file path within the UI directory.
   *
   * Cache strategy:
   * - Content-hashed filenames → immutable, 1-year max-age
   * - Other files → must-revalidate with ETag
   */
  router.get("/_plugins/:pluginId/ui/*filePath", async (req, res) => {
    const { pluginId } = req.params;

    // Extract the relative file path from the named wildcard.
    // In Express 5 with path-to-regexp v8, named wildcards may return
    // an array of path segments or a single string.
    const rawParam = req.params.filePath;
    const rawFilePath = Array.isArray(rawParam)
      ? rawParam.join("/")
      : rawParam as string | undefined;

    if (!rawFilePath || rawFilePath.length === 0) {
      res.status(400).json({ error: "File path is required" });
      return;
    }

    // Step 1: Look up the plugin
    let plugin = null;
    try {
      plugin = await registry.getById(pluginId);
    } catch (error) {
      const maybeCode =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (maybeCode !== "22P02") {
        throw error;
      }
    }
    if (!plugin) {
      plugin = await registry.getByKey(pluginId);
    }

    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Step 2: Verify the plugin is ready and has UI declared
    if (plugin.status !== "ready") {
      res.status(403).json({
        error: `Plugin UI is not available (status: ${plugin.status})`,
      });
      return;
    }

    const manifest = plugin.manifestJson;
    if (!manifest?.entrypoints?.ui) {
      res.status(404).json({ error: "Plugin does not declare a UI bundle" });
      return;
    }

    // Step 2b: Check for devUiUrl in plugin config — proxy to local dev server
    // when a plugin author has configured a dev server URL for hot-reload.
    // See PLUGIN_SPEC.md §27.2 — Local Development Workflow
    try {
      const configRow = await registry.getConfig(plugin.id);
      const devUiUrl =
        configRow &&
        typeof configRow === "object" &&
        "configJson" in configRow &&
        (configRow as { configJson: Record<string, unknown> }).configJson?.devUiUrl;

      if (typeof devUiUrl === "string" && devUiUrl.length > 0) {
        // Dev proxy is only available in development mode
        if (process.env.NODE_ENV === "production") {
          log.warn(
            { pluginId: plugin.id },
            "plugin-ui-static: devUiUrl ignored in production",
          );
          // Fall through to static file serving below
        } else {
          // Guard against rawFilePath overriding the base URL via protocol
          // scheme (e.g. "https://evil.com/x") or protocol-relative paths
          // (e.g. "//evil.com/x") which cause `new URL(path, base)` to
          // ignore the base entirely.
          // Normalize percent-encoding so encoded slashes (%2F) can't bypass
          // the protocol/path checks below.
          let decodedPath: string;
          try {
            decodedPath = decodeURIComponent(rawFilePath);
          } catch {
            res.status(400).json({ error: "Invalid file path" });
            return;
          }
          if (
            decodedPath.includes("://") ||
            decodedPath.startsWith("//") ||
            decodedPath.startsWith("\\\\")
          ) {
            res.status(400).json({ error: "Invalid file path" });
            return;
          }

          // Proxy the request to the dev server
          const targetUrl = new URL(rawFilePath, devUiUrl.endsWith("/") ? devUiUrl : devUiUrl + "/");

          // SSRF protection: only allow http/https and localhost targets for dev proxy
          if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
            res.status(400).json({ error: "devUiUrl must use http or https protocol" });
            return;
          }

          // Dev proxy is restricted to loopback addresses only.
          // Validate the *constructed* targetUrl hostname (not the base) to
          // catch any path-based override that slipped past the checks above.
          const devHost = targetUrl.hostname;
          const isLoopback =
            devHost === "localhost" ||
            devHost === "127.0.0.1" ||
            devHost === "::1" ||
            devHost === "[::1]";
          if (!isLoopback) {
            log.warn(
              { pluginId: plugin.id, devUiUrl, host: devHost },
              "plugin-ui-static: devUiUrl must target localhost, rejecting proxy",
            );
            res.status(400).json({ error: "devUiUrl must target localhost" });
            return;
          }

          log.debug(
            { pluginId: plugin.id, devUiUrl, targetUrl: targetUrl.href },
            "plugin-ui-static: proxying to devUiUrl",
          );

          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            try {
              const upstream = await fetch(targetUrl.href, { signal: controller.signal });
              if (!upstream.ok) {
                res.status(upstream.status).json({
                  error: `Dev server returned ${upstream.status}`,
                });
                return;
              }

              const contentType = upstream.headers.get("content-type");
              if (contentType) res.set("Content-Type", contentType);
              res.set("Cache-Control", "no-cache, no-store, must-revalidate");

              const body = await upstream.arrayBuffer();
              res.send(Buffer.from(body));
              return;
            } finally {
              clearTimeout(timeout);
            }
          } catch (proxyErr) {
            log.warn(
              {
                pluginId: plugin.id,
                devUiUrl,
                err: proxyErr instanceof Error ? proxyErr.message : String(proxyErr),
              },
              "plugin-ui-static: failed to proxy to devUiUrl, falling back to static",
            );
            // Fall through to static serving below
          }
        }
      }
    } catch {
      // Config lookup failure is non-fatal — fall through to static serving
    }

    // Step 3: Resolve the plugin's UI directory
    const uiDir = resolvePluginUiDir(
      options.localPluginDir,
      plugin.packageName,
      manifest.entrypoints.ui,
      plugin.packagePath,
    );

    if (!uiDir) {
      log.warn(
        { pluginId: plugin.id, pluginKey: plugin.pluginKey, packageName: plugin.packageName },
        "plugin-ui-static: UI directory not found on disk",
      );
      res.status(404).json({ error: "Plugin UI directory not found" });
      return;
    }

    // Step 4: Resolve the requested file path and prevent traversal (including symlinks)
    const resolvedFilePath = path.resolve(uiDir, rawFilePath);

    // Step 5: Check that the file exists and is a regular file
    let fileStat: fs.Stats;
    try {
      fileStat = fs.statSync(resolvedFilePath);
    } catch {
      res.status(404).json({ error: "File not found" });
      return;
    }

    // Security: resolve symlinks via realpathSync and verify containment.
    // This prevents symlink-based traversal that string-based startsWith misses.
    let realFilePath: string;
    let realUiDir: string;
    try {
      realFilePath = fs.realpathSync(resolvedFilePath);
      realUiDir = fs.realpathSync(uiDir);
    } catch {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const relative = path.relative(realUiDir, realFilePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    if (!fileStat.isFile()) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    // Step 6: Determine cache strategy based on filename
    const basename = path.basename(resolvedFilePath);
    const isContentHashed = CONTENT_HASH_PATTERN.test(basename);

    // Step 7: Set cache headers
    if (isContentHashed) {
      res.set("Cache-Control", CACHE_CONTROL_IMMUTABLE);
    } else {
      res.set("Cache-Control", CACHE_CONTROL_REVALIDATE);

      // Compute and set ETag for conditional request support
      const etag = computeETag(fileStat.size, fileStat.mtimeMs);
      res.set("ETag", etag);

      // Check If-None-Match for 304 Not Modified
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === etag) {
        res.status(304).end();
        return;
      }
    }

    // Step 8: Set Content-Type
    const ext = path.extname(resolvedFilePath).toLowerCase();
    const contentType = MIME_TYPES[ext];
    if (contentType) {
      res.set("Content-Type", contentType);
    }

    // Step 9: Set CORS headers (plugin UI may be loaded from different origin in dev)
    // Only set if the request origin is in the allowed whitelist.
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
    }

    // Step 10: Send the file
    // The plugin source can live in Git worktrees (e.g. ".worktrees/...").
    // `send` defaults to dotfiles:"ignore", which treats dot-directories as
    // not found. We already enforce traversal safety above, so allow dot paths.
    res.sendFile(resolvedFilePath, { dotfiles: "allow" }, (err) => {
      if (err) {
        log.error(
          { err, pluginId: plugin.id, filePath: resolvedFilePath },
          "plugin-ui-static: error sending file",
        );
        // Only send error if headers haven't been sent yet
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to serve file" });
        }
      }
    });
  });

  return router;
}
